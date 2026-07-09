import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('docker image workflow builds production-configured immutable images', async () => {
  const workflow = await readFile(
    '.github/workflows/docker-build.yaml',
    'utf8'
  );

  assert.match(workflow, /type=sha,format=long/);
  assert.match(
    workflow,
    /push:\s*\$\{\{\s*github\.event_name != 'pull_request'\s*\}\}/
  );
  assert.match(workflow, /NEXT_PUBLIC_APP_URL:\s*https:\/\/app\.apipool\.dev/);
  assert.match(
    workflow,
    /NEXT_PUBLIC_APIPOOL_API_BASE_URL:\s*https:\/\/api2\.apipool\.dev$/m
  );
  assert.match(workflow, /NEXT_PUBLIC_APIPOOL_DEFAULT_MODEL:\s*gpt-5\.4-mini/);
  assert.match(workflow, /deploy-production:/);
  assert.match(workflow, /IMAGE_TAG:\s*sha-\$\{\{\s*github\.sha\s*\}\}/);
  assert.match(workflow, /docker login ghcr\.io/);
  assert.match(workflow, /\.\/deploy\/deploy\.sh '\$IMAGE_TAG'/);
  assert.match(workflow, /deploy\/live-smoke\.sh/);
  assert.match(workflow, /deploy\/setup-smoke-users\.sh/);
});

test('GitHub workflows use Node 24-compatible actions without changing release semantics', async () => {
  const dockerWorkflow = await readFile(
    '.github/workflows/docker-build.yaml',
    'utf8'
  );
  const verifyWorkflow = await readFile(
    '.github/workflows/mvp-verify.yaml',
    'utf8'
  );
  const workflows = `${dockerWorkflow}\n${verifyWorkflow}`;

  for (const action of [
    'actions/checkout@v7',
    'actions/setup-node@v6',
    'pnpm/action-setup@v6',
    'docker/login-action@v4',
    'docker/metadata-action@v6',
    'docker/build-push-action@v7',
  ]) {
    assert.match(workflows, new RegExp(action.replace('/', '\\/')));
  }

  for (const oldAction of [
    'actions/checkout@v4',
    'actions/setup-node@v4',
    'pnpm/action-setup@v4',
    'docker/login-action@v3',
    'docker/metadata-action@v5',
    'docker/build-push-action@v5',
  ]) {
    assert.doesNotMatch(workflows, new RegExp(oldAction.replace('/', '\\/')));
  }

  assert.match(dockerWorkflow, /runs-on:\s*ubuntu-latest/);
  assert.match(verifyWorkflow, /runs-on:\s*ubuntu-latest/);
  assert.match(dockerWorkflow, /branches:\s*\[['"]main['"], ['"]dev['"]\]/);
  assert.match(verifyWorkflow, /branches:\s*\[['"]main['"], ['"]dev['"]\]/);
  assert.match(
    dockerWorkflow,
    /push:\s*\$\{\{\s*github\.event_name != 'pull_request'\s*\}\}/
  );
  assert.match(
    dockerWorkflow,
    /if:\s*github\.event_name == 'push' && github\.ref == 'refs\/heads\/main'/
  );
  assert.match(dockerWorkflow, /type=sha,format=long/);
  assert.match(dockerWorkflow, /\.\/deploy\/deploy\.sh '\$IMAGE_TAG'/);
  assert.equal(
    [...verifyWorkflow.matchAll(/node-version:\s*['"]22['"]/g)].length,
    1
  );
});

test('New API option repair script is documented and guarded', async () => {
  const script = await readFile('deploy/repair-newapi-options.sh', 'utf8');

  assert.match(script, /APIPOOL_REPAIR_LOCK/);
  assert.match(script, /apipool-v2-deploy\.lock/);
  assert.match(script, /apipool-v2-backup\.lock/);
  assert.match(script, /BEGIN IMMEDIATE/);
  assert.match(script, /PRAGMA busy_timeout=5000/);
  assert.match(script, /rollback sql:/);
  assert.match(script, /json_type\(value\)/);
  assert.match(script, /theme\.frontend/);
});

test('production compose pulls a selected GHCR image tag', async () => {
  const compose = await readFile('docker-compose.prod.yml', 'utf8');

  assert.match(compose, /ghcr\.io\/afreecoder\/apipool-v2/);
  assert.match(compose, /\$\{IMAGE_TAG:\?IMAGE_TAG is required\}/);
  assert.doesNotMatch(compose, /^\s*build:/m);
  assert.match(compose, /127\.0\.0\.1:3000:3000/);
  assert.match(compose, /127\.0\.0\.1:3001:3000/);
});

test('deploy script backs up before pulling and deploying', async () => {
  const script = await readFile('deploy/deploy.sh', 'utf8');

  const backupIndex = script.indexOf('./deploy/backup.sh pre-deploy');
  const pullIndex = script.indexOf('compose pull');
  const upIndex = script.indexOf('compose up -d --remove-orphans');

  assert.ok(backupIndex >= 0, 'pre-deploy backup should be present');
  assert.ok(pullIndex > backupIndex, 'image pull should happen after backup');
  assert.ok(upIndex > pullIndex, 'container update should happen after pull');
  assert.match(script, /http:\/\/127\.0\.0\.1:3001\/api\/status/);
  assert.match(script, /http:\/\/127\.0\.0\.1:3000\//);
});

test('backup script has separate pre-deploy and daily retention rules', async () => {
  const script = await readFile('deploy/backup.sh', 'utf8');

  assert.match(script, /pre-deploy\).*APIPOOL_PRE_DEPLOY_BACKUP_RETAIN:-2/);
  assert.match(
    script,
    /pre-smoke-users\).*APIPOOL_PRE_SMOKE_USERS_BACKUP_RETAIN:-2/
  );
  assert.match(script, /daily\).*APIPOOL_DAILY_BACKUP_RETAIN_DAYS:-7/);
  assert.match(script, /docker compose .* pause/);
  assert.match(script, /chmod 600 "\$archive"/);
  assert.match(script, /-mtime \+"\$\(\(RETAIN_DAYS - 1\)\)"/);
});

test('systemd timer runs daily backup at 04:00 Asia/Shanghai', async () => {
  const timer = await readFile(
    'deploy/systemd/apipool-v2-backup.timer',
    'utf8'
  );
  const service = await readFile(
    'deploy/systemd/apipool-v2-backup.service',
    'utf8'
  );

  assert.match(timer, /OnCalendar=\*-\*-\* 04:00:00 Asia\/Shanghai/);
  assert.match(timer, /Persistent=true/);
  assert.match(
    service,
    /ExecStart=\/opt\/apipool-v2\/deploy\/backup\.sh daily/
  );
});

function printCaddyConfig(env: Record<string, string>) {
  return spawnSync('bash', ['deploy/configure-caddy.sh', '--print-config'], {
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
}

const NEWAPI_BASIC_AUTH = {
  APIPOOL_NEWAPI_BASIC_AUTH_USER: 'ops',
  APIPOOL_NEWAPI_BASIC_AUTH_HASH: '$2a$14$hashplaceholder',
};

test('Caddy setup keeps the portal and the data plane reachable', async () => {
  const bootstrap = await readFile('deploy/server-bootstrap.sh', 'utf8');
  const { status, stdout } = printCaddyConfig(NEWAPI_BASIC_AUTH);

  assert.equal(status, 0);
  assert.match(stdout, /app\.apipool\.dev/);
  assert.match(stdout, /api2\.apipool\.dev/);
  assert.match(stdout, /newapi\.apipool\.dev/);
  assert.match(stdout, /reverse_proxy 127\.0\.0\.1:3000/);
  assert.match(stdout, /X-Robots-Tag "noindex, nofollow"/);
  assert.match(bootstrap, /configure-caddy\.sh/);
});

test('Caddy exposes only the /v1 data plane on the public API domain', async () => {
  // api2 与 New API 管理面同一个上游；不限路径就等于把 /api/* 管理接口也代理出去
  const { status, stdout } = printCaddyConfig(NEWAPI_BASIC_AUTH);
  assert.equal(status, 0);

  const apiBlock = stdout.split('api2.apipool.dev {')[1].split('\n}')[0];
  assert.match(apiBlock, /handle \/v1\*/);
  assert.match(apiBlock, /respond .*404/);
  // vhost 顶层（单层缩进）不得有裸 reverse_proxy——那会绕过 /v1 路径限制
  assert.doesNotMatch(apiBlock, /^\treverse_proxy/m);
});

test('Caddy guards the New API operator surface with basic auth', async () => {
  const { status, stdout } = printCaddyConfig(NEWAPI_BASIC_AUTH);
  assert.equal(status, 0);

  const newapiBlock = stdout.split('newapi.apipool.dev {')[1];
  assert.match(newapiBlock, /basic_auth/);
  assert.match(newapiBlock, /ops \$2a\$14\$hashplaceholder/);
});

test('Caddy guards the New API operator surface with an IP allowlist', async () => {
  const { status, stdout } = printCaddyConfig({
    APIPOOL_NEWAPI_ALLOWED_IPS: '203.0.113.7 198.51.100.0/24',
  });
  assert.equal(status, 0);

  const newapiBlock = stdout.split('newapi.apipool.dev {')[1];
  assert.match(newapiBlock, /remote_ip 203\.0\.113\.7 198\.51\.100\.0\/24/);
  assert.match(newapiBlock, /respond .*403/);
});

test('server bootstrap never shell-sources the deploy env', async () => {
  const bootstrap = await readFile('deploy/server-bootstrap.sh', 'utf8');

  // `. .env.deploy` 会让 shell 展开值：bcrypt 哈希 `$2a$14$...` 变成 `a4`，
  // 空格分隔的 IP 白名单里第二个 IP 被当成命令执行（set -e 下直接中断部署）。
  assert.doesNotMatch(bootstrap, /^\s*\.\s+"\$APP_DIR\/\.env\.deploy"/m);
  // 改为把文件路径交给 configure-caddy，由它按字面量读取
  assert.match(bootstrap, /APIPOOL_DEPLOY_ENV_FILE=/);
});

test('Caddy config reads bcrypt hashes and IP lists from .env.deploy literally', async () => {
  const { mkdtemp, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  const hash = '$2a$14$Xy7QZ0abcdefghijklmnop';
  const ips = '203.0.113.7 198.51.100.0/24';

  for (const [label, body] of [
    [
      'quoted',
      `APIPOOL_NEWAPI_BASIC_AUTH_USER='ops'\nAPIPOOL_NEWAPI_BASIC_AUTH_HASH='${hash}'\nAPIPOOL_NEWAPI_ALLOWED_IPS='${ips}'\n`,
    ],
    [
      'unquoted',
      `APIPOOL_NEWAPI_BASIC_AUTH_USER=ops\nAPIPOOL_NEWAPI_BASIC_AUTH_HASH=${hash}\nAPIPOOL_NEWAPI_ALLOWED_IPS=${ips}\n`,
    ],
  ] as const) {
    const dir = await mkdtemp(join(tmpdir(), 'apipool-env-'));
    const envFile = join(dir, '.env.deploy');
    await writeFile(envFile, body, 'utf8');

    // 刻意不通过环境变量传值：要覆盖的正是「从文件读」这条真实路径
    const { status, stdout, stderr } = spawnSync(
      'bash',
      ['deploy/configure-caddy.sh', '--print-config'],
      {
        env: {
          ...process.env,
          APIPOOL_DEPLOY_ENV_FILE: envFile,
          // 置空 == 未设置（脚本用 ${VAR:-...}）：确保读的是文件而非环境变量
          APIPOOL_NEWAPI_BASIC_AUTH_USER: '',
          APIPOOL_NEWAPI_BASIC_AUTH_HASH: '',
          APIPOOL_NEWAPI_ALLOWED_IPS: '',
        },
        encoding: 'utf8',
      }
    );

    assert.equal(status, 0, `${label}: ${stderr}`);
    assert.ok(
      stdout.includes(hash),
      `${label}: bcrypt hash must survive verbatim, got:\n${stdout}`
    );
    assert.ok(
      stdout.includes('remote_ip 203.0.113.7 198.51.100.0/24'),
      `${label}: the whole IP allowlist must survive, got:\n${stdout}`
    );
  }
});

test('Caddy setup refuses to expose the New API operator surface unprotected', async () => {
  // runbook 第 2 节要求运营面「再加一层边界」；脚本必须无法产出裸奔的 vhost
  const { status, stderr } = printCaddyConfig({
    APIPOOL_NEWAPI_BASIC_AUTH_USER: '',
    APIPOOL_NEWAPI_BASIC_AUTH_HASH: '',
    APIPOOL_NEWAPI_ALLOWED_IPS: '',
  });

  assert.notEqual(status, 0);
  assert.match(stderr, /basic auth|IP allowlist/i);
});

test('the deploy env example quotes values that would break a shell source', async () => {
  const example = await readFile('deploy/env.production.example', 'utf8');

  // deploy/live-smoke.sh 仍会 source .env.deploy：bcrypt 哈希的 `$` 会被展开，
  // 空格分隔的 IP 白名单里第二个 IP 会被当命令执行（set -e 下中断部署）。
  assert.match(example, /APIPOOL_NEWAPI_BASIC_AUTH_HASH='/);
  assert.match(example, /APIPOOL_NEWAPI_ALLOWED_IPS='/);
  assert.match(example, /单引号/);
});
