import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('生产镜像在数据库迁移后执行幂等目录初始化', async () => {
  const [dockerfile, entrypoint] = await Promise.all([
    readFile('Dockerfile', 'utf8'),
    readFile('deploy/entrypoint.sh', 'utf8'),
  ]);

  assert.match(dockerfile, /scripts\/init-catalog\.ts/);
  assert.match(dockerfile, /--outfile=deploy\/catalog-init\.mjs/);
  assert.match(dockerfile, /catalog-init\.mjs \.\/catalog-init\.mjs/);
  assert.ok(
    entrypoint.indexOf('node migrate.cjs') <
      entrypoint.indexOf('node catalog-init.mjs')
  );
});
