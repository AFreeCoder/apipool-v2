import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

async function executable(path: string, body: string) {
  await writeFile(path, body, 'utf8');
  await chmod(path, 0o755);
}

async function makeFixture(checkout = 'false') {
  const dir = await mkdtemp(join(tmpdir(), 'apipool-go-live-'));
  const bin = join(dir, 'bin');
  const deploy = join(dir, 'deploy');
  await mkdir(bin);
  await mkdir(deploy);
  await writeFile(
    join(dir, '.env.deploy'),
    `APIPOOL_CHECKOUT_ENABLED=${checkout}\nQUOTED_VALUE='keep $literal spaces'\n`,
    'utf8'
  );
  await writeFile(join(dir, 'release.env'), 'IMAGE_TAG=sha-current\n', 'utf8');
  await writeFile(
    join(dir, 'docker-compose.prod.yml'),
    'services:\n  apipool-v2: {}\n',
    'utf8'
  );
  await copyFile('deploy/go-live.sh', join(deploy, 'go-live.sh'));
  await copyFile('deploy/lib.sh', join(deploy, 'lib.sh'));
  await chmod(join(deploy, 'go-live.sh'), 0o755);
  await executable(join(bin, 'flock'), '#!/bin/sh\nexit 0\n');
  await executable(join(bin, 'sync'), '#!/bin/sh\nexit 0\n');
  await executable(
    join(bin, 'curl'),
    `#!/bin/sh
url=""
for arg in "$@"; do url="$arg"; done
profile="${'${MOCK_PROBE_PROFILE:-happy}'}"
status=000
case "$profile:$url" in
  failure:*) status=500 ;;
  happy:*api2*/api/status) status=404 ;;
  happy:*api2*/v1/models) status=401 ;;
  happy:*newapi*/v1/models) status=404 ;;
esac
printf '%s' "$status"
`
  );
  await executable(
    join(bin, 'docker'),
    `#!/bin/sh
checkout="$(sed -n 's/^APIPOOL_CHECKOUT_ENABLED=//p' "$APIPOOL_DEPLOY_DIR/.env.deploy" | tail -1)"
echo "docker $* checkout=$checkout" >>"$MOCK_CALL_LOG"
case "$*" in
  *"exec -T apipool-v2 printenv APIPOOL_CHECKOUT_ENABLED"*)
    printf '%s\\n' "$checkout"
    ;;
esac
exit 0
`
  );
  await executable(
    join(deploy, 'live-smoke.sh'),
    `#!/bin/sh
echo "live-smoke $*" >>"$MOCK_CALL_LOG"
if [ "${'${MOCK_SMOKE_EXIT_MODE:-}'}" = "${'${1:-mvp}'}" ]; then exit 1; fi
tag="$(sed -n 's/^IMAGE_TAG=//p' "$APIPOOL_DEPLOY_DIR/release.env" | tail -1)"
case "${'${1:-}'}" in
  --recharge)
    printf 'TIMESTAMP=fixture\\nIMAGE_TAG=%s\\n' "$tag" >"$APIPOOL_DEPLOY_DIR/.live-smoke-recharge-ok"
    ;;
  --gateway)
    printf 'TIMESTAMP=fixture\\nIMAGE_TAG=%s\\n' "$tag" >"$APIPOOL_DEPLOY_DIR/.live-smoke-gateway-ok"
    ;;
esac
`
  );
  const log = join(dir, 'calls.log');
  await writeFile(log, '', 'utf8');
  return { dir, log };
}

function runGoLive(
  fixture: { dir: string; log: string },
  args: string[],
  options: { input?: string; env?: Record<string, string> } = {}
) {
  return spawnSync(
    '/bin/dash',
    [join(fixture.dir, 'deploy/go-live.sh'), ...args],
    {
      input: options.input,
      env: {
        ...process.env,
        PATH: `${join(fixture.dir, 'bin')}:${process.env.PATH}`,
        APIPOOL_DEPLOY_DIR: fixture.dir,
        APIPOOL_DEPLOY_LOCK: join(fixture.dir, 'deploy.lock'),
        APIPOOL_GO_LIVE_PROBE_BASE: 'http://probe.test',
        MOCK_CALL_LOG: fixture.log,
        ...options.env,
      },
      encoding: 'utf8',
    }
  );
}

async function writeMarkers(fixture: { dir: string }, tag = 'sha-current') {
  for (const name of ['.live-smoke-recharge-ok', '.live-smoke-gateway-ok']) {
    await writeFile(
      join(fixture.dir, name),
      `TIMESTAMP=fixture\nIMAGE_TAG=${tag}\n`,
      'utf8'
    );
  }
}

async function writeRestoreEvidence(
  fixture: { dir: string },
  content = '恢复演练完成：portal=ok, newapi=ok, credentials=ok\n'
) {
  const path = join(fixture.dir, 'restore-drill-evidence.md');
  await writeFile(path, content, 'utf8');
  return path;
}

test('go-live 只保留 checkout 门禁，不再维护切流或钱包开关', async () => {
  const script = await readFile('deploy/go-live.sh', 'utf8');
  assert.match(script, /APIPOOL_CHECKOUT_ENABLED/);
  assert.doesNotMatch(
    script,
    /APIPOOL_API_MODE|WALLET_LEDGER_WRITE_ENABLED|WALLET_DISPLAY_ENABLED|maintenance|legacy/
  );
});

test('status 只读输出 checkout、发布版本和最终态路由探测', async () => {
  const fixture = await makeFixture('false');
  const result = runGoLive(fixture, ['status']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /APIPOOL_CHECKOUT_ENABLED=false/);
  assert.match(result.stdout, /IMAGE_TAG=sha-current/);
  assert.match(result.stdout, /api2=401/);
  assert.match(result.stdout, /newapi=404/);
  assert.match(result.stdout, /api2-management=404/);
});

test('verify 要求 checkout 显式关闭', async () => {
  for (const checkout of ['true', '']) {
    const fixture = await makeFixture(checkout);
    const result = runGoLive(fixture, ['verify']);
    assert.equal(result.status, 78, result.stderr);
    assert.match(result.stderr, /必须显式为 false/);
    assert.equal(await readFile(fixture.log, 'utf8'), '');
  }
});

test('verify 在最终态路由通过后依次完成 MVP、充值和网关 smoke', async () => {
  const fixture = await makeFixture();
  const result = runGoLive(fixture, ['verify']);
  assert.equal(result.status, 0, result.stderr);
  const log = await readFile(fixture.log, 'utf8');
  assert.match(log, /live-smoke\s*\n/);
  assert.match(log, /live-smoke --recharge/);
  assert.match(log, /live-smoke --gateway/);
  for (const marker of ['.live-smoke-recharge-ok', '.live-smoke-gateway-ok']) {
    assert.match(
      await readFile(join(fixture.dir, marker), 'utf8'),
      /^IMAGE_TAG=sha-current$/m
    );
  }
});

test('最终态路由探测失败时 verify 不启动任何 smoke', async () => {
  const fixture = await makeFixture();
  const result = runGoLive(fixture, ['verify'], {
    env: { MOCK_PROBE_PROFILE: 'failure' },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /探测失败/);
  assert.equal(await readFile(fixture.log, 'utf8'), '');
});

test('open-checkout 强制要求存在、可读且非空的备份恢复演练证据', async () => {
  const noArgument = await makeFixture();
  let result = runGoLive(noArgument, ['open-checkout']);
  assert.equal(result.status, 78, result.stderr);
  assert.match(result.stderr, /--evidence/);

  const missing = await makeFixture();
  result = runGoLive(missing, [
    'open-checkout',
    '--evidence',
    join(missing.dir, 'missing.md'),
  ]);
  assert.equal(result.status, 78, result.stderr);
  assert.match(result.stderr, /必须存在、可读且非空/);

  const empty = await makeFixture();
  const emptyPath = await writeRestoreEvidence(empty, '');
  result = runGoLive(empty, ['open-checkout', '--evidence', emptyPath]);
  assert.equal(result.status, 78, result.stderr);
  assert.match(result.stderr, /必须存在、可读且非空/);
});

test('open-checkout 拒绝缺失或陈旧的当前镜像 smoke 标志', async () => {
  const missing = await makeFixture();
  const missingEvidence = await writeRestoreEvidence(missing);
  assert.equal(
    runGoLive(missing, ['open-checkout', '--evidence', missingEvidence]).status,
    78
  );

  const stale = await makeFixture();
  const staleEvidence = await writeRestoreEvidence(stale);
  await writeMarkers(stale, 'sha-old');
  const result = runGoLive(stale, [
    'open-checkout',
    '--evidence',
    staleEvidence,
  ]);
  assert.equal(result.status, 78, result.stderr);
  assert.match(result.stderr, /与当前发布.*不匹配/);
});

test('open-checkout 经确认后原子开收款并验证容器运行态', async () => {
  const fixture = await makeFixture();
  const evidence = await writeRestoreEvidence(fixture);
  await writeMarkers(fixture);
  const result = runGoLive(fixture, ['open-checkout', '--evidence', evidence], {
    input: 'yes\n',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, new RegExp(evidence));
  const env = await readFile(join(fixture.dir, '.env.deploy'), 'utf8');
  assert.match(env, /^APIPOOL_CHECKOUT_ENABLED=true$/m);
  assert.match(env, /^QUOTED_VALUE='keep \$literal spaces'$/m);
  const log = await readFile(fixture.log, 'utf8');
  assert.match(log, /docker compose .* up -d checkout=true/);
  assert.match(log, /exec -T apipool-v2 printenv APIPOOL_CHECKOUT_ENABLED/);
  assert.deepEqual(
    (await readdir(fixture.dir)).filter((name) =>
      name.startsWith('.env.deploy.')
    ),
    []
  );
});

test('共享 env 写入只用同目录临时文件与 rename，不用 install 覆盖状态文件', async () => {
  const library = await readFile('deploy/lib.sh', 'utf8');
  assert.match(
    library,
    /mktemp "\$\(dirname "\$STATE_ENV_FILE"\)\/\.env\.deploy/
  );
  assert.match(library, /mv -f "\$tmp" "\$STATE_ENV_FILE"/);
  assert.doesNotMatch(library, /install[^\n]*STATE_ENV_FILE/);
});

test('smoke 工装、镜像产物与 live-smoke 两种专项模式完整接线', async () => {
  const [gateway, recharge, live, dockerfile] = await Promise.all([
    readFile('scripts/smoke-gateway.ts', 'utf8'),
    readFile('scripts/smoke-recharge.ts', 'utf8'),
    readFile('deploy/live-smoke.sh', 'utf8'),
    readFile('Dockerfile', 'utf8'),
  ]);
  assert.match(gateway, /from 'openai'/);
  assert.match(gateway, /from '@anthropic-ai\/sdk'/);
  assert.match(gateway, /computeTokenChargeMicroUsd/);
  assert.match(gateway, /computePerCallChargeMicroUsd/);
  assert.doesNotMatch(gateway, /computeChargeMicroUsd/);
  assert.match(gateway, /newapiRequestId/);
  assert.match(recharge, /handleCheckoutSuccess/);
  assert.match(recharge, /manual_adjustment/);
  assert.match(recharge, /amount \* 10_000/);
  assert.doesNotMatch(recharge, /WALLET_LEDGER_WRITE_ENABLED/);
  assert.match(live, /--gateway/);
  assert.match(live, /--recharge/);
  assert.match(live, /\.live-smoke-gateway-ok/);
  assert.match(live, /\.live-smoke-recharge-ok/);
  assert.match(dockerfile, /smoke-gateway\.cjs/);
  assert.match(dockerfile, /smoke-recharge\.cjs/);
});

async function makeDeployFixture(checkout: string) {
  const fixture = await makeFixture(checkout);
  await copyFile('deploy/deploy.sh', join(fixture.dir, 'deploy/deploy.sh'));
  await copyFile('deploy/lib.sh', join(fixture.dir, 'deploy/lib.sh'));
  await copyFile(
    'deploy/cloudflare-ips.txt',
    join(fixture.dir, 'deploy/cloudflare-ips.txt')
  );
  await chmod(join(fixture.dir, 'deploy/deploy.sh'), 0o755);
  await executable(
    join(fixture.dir, 'deploy/backup.sh'),
    '#!/bin/sh\necho backup >>"$MOCK_CALL_LOG"\n'
  );
  await executable(
    join(fixture.dir, 'deploy/configure-caddy.sh'),
    '#!/bin/sh\necho caddy >>"$MOCK_CALL_LOG"\n'
  );
  await executable(
    join(fixture.dir, 'deploy/live-smoke.sh'),
    `#!/bin/sh
echo "live-smoke $*" >>"$MOCK_CALL_LOG"
if [ "${'${MOCK_SMOKE_EXIT:-0}'}" != 0 ]; then exit "$MOCK_SMOKE_EXIT"; fi
tag="$(sed -n 's/^IMAGE_TAG=//p' "$APIPOOL_DEPLOY_DIR/release.env" | tail -1)"
printf 'TIMESTAMP=fixture\\nIMAGE_TAG=%s\\n' "$tag" >"$APIPOOL_DEPLOY_DIR/.live-smoke-recharge-ok"
`
  );
  await executable(join(fixture.dir, 'bin/chown'), '#!/bin/sh\nexit 0\n');
  await executable(join(fixture.dir, 'bin/curl'), '#!/bin/sh\nexit 0\n');
  await executable(
    join(fixture.dir, 'bin/docker'),
    `#!/bin/sh
checkout="$(sed -n 's/^APIPOOL_CHECKOUT_ENABLED=//p' "$APIPOOL_DEPLOY_DIR/.env.deploy" | tail -1)"
echo "docker $* checkout=$checkout" >>"$MOCK_CALL_LOG"
case "$*" in
  *"ps -q newapi-metadata-filter"*) printf '%s\\n' "mock-metadata-filter" ;;
  *"inspect --format"*"mock-metadata-filter"*) printf '%s\\n' "healthy" ;;
  *"exec -T apipool-v2 printenv APIPOOL_CHECKOUT_ENABLED"*) printf '%s\\n' "$checkout" ;;
esac
exit 0
`
  );
  return fixture;
}

function runDeploy(fixture: { dir: string; log: string }, smokeExit = '0') {
  return spawnSync('bash', [join(fixture.dir, 'deploy/deploy.sh'), 'sha-new'], {
    env: {
      ...process.env,
      PATH: `${join(fixture.dir, 'bin')}:${process.env.PATH}`,
      APIPOOL_DEPLOY_DIR: fixture.dir,
      APIPOOL_DEPLOY_LOCK: join(fixture.dir, 'deploy.lock'),
      MOCK_CALL_LOG: fixture.log,
      MOCK_SMOKE_EXIT: smokeExit,
    },
    encoding: 'utf8',
  });
}

test('checkout 已开放的常规发布在 pull 前冻结，充值 smoke 失败时保持冻结', async () => {
  const fixture = await makeDeployFixture('true');
  const result = runDeploy(fixture, '1');
  assert.equal(result.status, 75, result.stderr);
  const log = await readFile(fixture.log, 'utf8');
  const freezeUp = log.indexOf('up -d checkout=false');
  const pull = log.indexOf('pull checkout=false');
  assert.ok(freezeUp >= 0 && pull > freezeUp, '运行容器必须在 pull 前冻结');
  assert.match(log, /live-smoke --recharge/);
  assert.match(
    await readFile(join(fixture.dir, '.env.deploy'), 'utf8'),
    /^APIPOOL_CHECKOUT_ENABLED=false$/m
  );
});

test('checkout 已开放的常规发布在充值 smoke 成功后恢复开放', async () => {
  const fixture = await makeDeployFixture('true');
  const result = runDeploy(fixture);
  assert.equal(result.status, 0, result.stderr);
  assert.match(
    await readFile(join(fixture.dir, '.env.deploy'), 'utf8'),
    /^APIPOOL_CHECKOUT_ENABLED=true$/m
  );
  assert.match(
    await readFile(join(fixture.dir, '.live-smoke-recharge-ok'), 'utf8'),
    /^IMAGE_TAG=sha-new$/m
  );
});

test('checkout 未开放的发布不触发充值门禁', async () => {
  const fixture = await makeDeployFixture('false');
  const result = runDeploy(fixture);
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(await readFile(fixture.log, 'utf8'), /live-smoke/);
});
