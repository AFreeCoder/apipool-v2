import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { createClient } from '@libsql/client';

test('生产镜像在数据库迁移后执行幂等目录初始化', async () => {
  const [dockerfile, entrypoint] = await Promise.all([
    readFile('Dockerfile', 'utf8'),
    readFile('deploy/entrypoint.sh', 'utf8'),
  ]);

  assert.match(dockerfile, /scripts\/init-catalog\.ts/);
  assert.match(dockerfile, /--outfile=deploy\/catalog-init\.mjs/);
  assert.match(dockerfile, /createRequire\(import\.meta\.url\)/);
  assert.match(dockerfile, /catalog-init\.mjs \.\/catalog-init\.mjs/);
  assert.ok(
    entrypoint.indexOf('node migrate.cjs') <
      entrypoint.indexOf('node catalog-init.mjs')
  );
});

test('生产同构目录初始化 bundle 可在 Node ESM 中加载 CommonJS 数据库依赖', async () => {
  const tempDir = join(process.cwd(), '.tmp', 'catalog-init-bundle');
  const bundlePath = join(tempDir, 'catalog-init.mjs');
  const dbPath = join(tempDir, 'portal.db');
  await rm(tempDir, { recursive: true, force: true });
  await mkdir(tempDir, { recursive: true });

  try {
    const build = spawnSync(
      'node_modules/.bin/esbuild',
      [
        'scripts/init-catalog.ts',
        '--bundle',
        '--platform=node',
        '--format=esm',
        '--conditions=react-server',
        "--banner:js=import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
        '--external:@libsql/client',
        `--outfile=${bundlePath}`,
      ],
      { encoding: 'utf8' }
    );
    assert.equal(build.status, 0, build.stderr);

    const client = createClient({ url: `file:${dbPath}` });
    const migrationsDir = join(
      process.cwd(),
      'src/config/db/migrations_sqlite'
    );
    for (const file of (await readdir(migrationsDir))
      .filter((name) => name.endsWith('.sql'))
      .sort()) {
      await client.executeMultiple(
        await readFile(join(migrationsDir, file), 'utf8')
      );
    }
    client.close();

    const run = spawnSync(process.execPath, [bundlePath], {
      env: {
        ...process.env,
        DATABASE_PROVIDER: 'sqlite',
        DATABASE_URL: `file:${dbPath}`,
        DB_SCHEMA_FILE: './src/config/db/schema.sqlite.ts',
        DB_SINGLETON_ENABLED: 'false',
      },
      encoding: 'utf8',
    });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /Catalog initialization completed successfully/);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});
