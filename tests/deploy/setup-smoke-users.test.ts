import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

function run(
  command: string,
  args: string[],
  options: Record<string, any> = {}
) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    ...options,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout.trim();
}

test('setup-smoke-users dry-run 无写入且 apply 备份后幂等复用唯一账户', async () => {
  const appDir = await mkdtemp(join(tmpdir(), 'apipool-smoke-users-'));
  const dbPath = join(appDir, 'data/portal/portal.db');
  const envPath = join(appDir, '.env.deploy');
  const backupMarker = join(appDir, 'backup-calls.txt');

  try {
    await mkdir(join(appDir, 'deploy'), { recursive: true });
    await mkdir(join(appDir, 'data/portal'), { recursive: true });
    await copyFile(
      join(process.cwd(), 'deploy/setup-smoke-users.sh'),
      join(appDir, 'deploy/setup-smoke-users.sh')
    );
    await chmod(join(appDir, 'deploy/setup-smoke-users.sh'), 0o755);
    await writeFile(envPath, '', { mode: 0o600 });
    await writeFile(
      join(appDir, 'deploy/backup.sh'),
      `#!/usr/bin/env bash
set -Eeuo pipefail
count="$(sqlite3 "$APIPOOL_PORTAL_DB" 'select count(*) from user;')"
printf '%s:%s\\n' "$1" "$count" >> "$BACKUP_MARKER"
`,
      { mode: 0o755 }
    );

    run('sqlite3', [dbPath], {
      input: `
CREATE TABLE user (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  email_verified INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  utm_source TEXT NOT NULL DEFAULT '',
  ip TEXT NOT NULL DEFAULT '',
  locale TEXT NOT NULL DEFAULT ''
);
CREATE TABLE role (id TEXT PRIMARY KEY, status TEXT NOT NULL);
CREATE TABLE permission (id TEXT PRIMARY KEY, code TEXT NOT NULL);
CREATE TABLE role_permission (
  role_id TEXT NOT NULL,
  permission_id TEXT NOT NULL,
  deleted_at INTEGER
);
CREATE TABLE user_role (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  role_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER
);
INSERT INTO role (id, status) VALUES ('role_operator', 'active');
INSERT INTO permission (id, code) VALUES ('perm_adjust', 'admin.apipool.quota.adjust');
INSERT INTO role_permission (role_id, permission_id, deleted_at)
VALUES ('role_operator', 'perm_adjust', NULL);
`,
    });

    const env = {
      ...process.env,
      APIPOOL_DEPLOY_DIR: appDir,
      APIPOOL_ENV_FILE: '.env.deploy',
      APIPOOL_PORTAL_DB: 'data/portal/portal.db',
      BACKUP_MARKER: backupMarker,
    };
    const script = join(appDir, 'deploy/setup-smoke-users.sh');

    run(script, [], { env });
    assert.equal(run('sqlite3', [dbPath, 'select count(*) from user;']), '0');

    run(script, ['--apply'], { env });
    const firstUserId = run('sqlite3', [
      dbPath,
      "select id from user where email = 'smo@apipool.local';",
    ]);
    assert.ok(firstUserId);

    run(script, ['--apply'], { env });
    assert.equal(run('sqlite3', [dbPath, 'select count(*) from user;']), '1');
    assert.equal(
      run('sqlite3', [
        dbPath,
        "select count(*) from user_role where user_id = '" +
          firstUserId +
          "' and role_id = 'role_operator' and expires_at is null;",
      ]),
      '1'
    );
    assert.equal(
      run('sqlite3', [
        dbPath,
        "select id from user where email = 'smo@apipool.local';",
      ]),
      firstUserId
    );

    const envFile = await readFile(envPath, 'utf8');
    assert.match(envFile, /APIPOOL_SMOKE_PORTAL_EMAIL=smo@apipool\.local/);
    assert.match(envFile, /APIPOOL_SMOKE_OPERATOR_EMAIL=smo@apipool\.local/);
    assert.match(
      envFile,
      new RegExp(`APIPOOL_SMOKE_PORTAL_USER_ID=${firstUserId}`)
    );
    assert.match(
      envFile,
      new RegExp(`APIPOOL_SMOKE_OPERATOR_USER_ID=${firstUserId}`)
    );
    assert.equal(
      (await readFile(backupMarker, 'utf8')).trim(),
      'pre-smoke-users:0\npre-smoke-users:1'
    );
  } finally {
    await rm(appDir, { recursive: true, force: true });
  }
});
