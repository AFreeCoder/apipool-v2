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

type CutoverState = {
  mode?: string;
  checkout?: string;
  ledger?: string;
  display?: string;
};

function envBody(state: CutoverState) {
  return (
    [
      state.mode === undefined ? null : `APIPOOL_API_MODE=${state.mode}`,
      state.checkout === undefined
        ? null
        : `APIPOOL_CHECKOUT_ENABLED=${state.checkout}`,
      state.ledger === undefined
        ? null
        : `WALLET_LEDGER_WRITE_ENABLED=${state.ledger}`,
      state.display === undefined
        ? null
        : `WALLET_DISPLAY_ENABLED=${state.display}`,
      "QUOTED_VALUE='keep $literal spaces'",
    ]
      .filter(Boolean)
      .join('\n') + '\n'
  );
}

async function executable(path: string, body: string) {
  await writeFile(path, body, 'utf8');
  await chmod(path, 0o755);
}

async function makeCutoverFixture(state: CutoverState) {
  const dir = await mkdtemp(join(tmpdir(), 'apipool-cutover-'));
  const bin = join(dir, 'bin');
  const deploy = join(dir, 'deploy');
  await mkdir(bin);
  await mkdir(deploy);
  await writeFile(join(dir, '.env.deploy'), envBody(state), 'utf8');
  await writeFile(join(dir, 'release.env'), 'IMAGE_TAG=sha-current\n', 'utf8');
  await writeFile(join(dir, 'docker-compose.prod.yml'), 'services: {}\n');
  await writeFile(join(dir, 'evidence.txt'), 'restore drill passed\n');
  await executable(join(bin, 'flock'), '#!/bin/sh\nexit 0\n');
  await executable(join(bin, 'sync'), '#!/bin/sh\nexit 0\n');
  await executable(
    join(bin, 'docker'),
    `#!/bin/sh
echo "docker $*" >>"$MOCK_CALL_LOG"
case "$*" in
  *"exec -T apipool-v2 printenv"*)
    key=""
    for arg in "$@"; do key="$arg"; done
    if [ "${'${MOCK_RUNTIME_STALE:-0}'}" = 1 ]; then echo false; exit 0; fi
    sed -n "s/^${'${key}'}=//p" "$APIPOOL_DEPLOY_DIR/.env.deploy" | tail -1
    ;;
esac
exit 0
`
  );
  await executable(
    join(bin, 'curl'),
    `#!/bin/sh
url=""
for arg in "$@"; do url="$arg"; done
mode="$(sed -n 's/^APIPOOL_API_MODE=//p' "$APIPOOL_DEPLOY_DIR/.env.deploy" | tail -1)"
profile="${'${MOCK_PROBE_PROFILE:-isolation}'}"
status=000
case "$profile:$url" in
  failure:*) status=500 ;;
  happy:*api2*/api/status) status=404 ;;
  happy:*api2*/v1/models) [ "$mode" = portal ] && status=401 || status=503 ;;
  happy:*newapi*/v1/models) status=404 ;;
  portal-fail:*api2*/v1/models) [ "$mode" = portal ] && status=500 || status=503 ;;
  portal-fail:*newapi*/v1/models) status=404 ;;
  portal:*api2*/api/status) status=404 ;;
  portal:*api2*/v1/models) status=401 ;;
  portal:*newapi*/v1/models) status=404 ;;
  *:*api2*/v1/models) status=503 ;;
  *:*newapi*/v1/models) status=404 ;;
  *:http://127.0.0.1:3000/v1/models) status=401 ;;
esac
printf '%s' "$status"
`
  );
  await executable(
    join(deploy, 'configure-caddy.sh'),
    '#!/bin/sh\necho recaddy >>"$MOCK_CALL_LOG"\nexit 0\n'
  );
  await executable(
    join(deploy, 'live-smoke.sh'),
    `#!/bin/sh
echo "live-smoke $*" >>"$MOCK_CALL_LOG"
tag="$(sed -n 's/^IMAGE_TAG=//p' "$APIPOOL_DEPLOY_DIR/release.env" | tail -1)"
if [ "$1" = --recharge ]; then
  printf 'TIMESTAMP=fixture\\nIMAGE_TAG=%s\\n' "$tag" >"$APIPOOL_DEPLOY_DIR/.cutover-recharge-ok"
fi
exit "${'${MOCK_SMOKE_EXIT:-0}'}"
`
  );
  const log = join(dir, 'calls.log');
  await writeFile(log, '', 'utf8');
  return { dir, log };
}

function runCutover(
  fixture: { dir: string; log: string },
  args: string[],
  options: { input?: string; env?: Record<string, string> } = {}
) {
  return spawnSync('/bin/dash', ['deploy/cutover.sh', ...args], {
    cwd: process.cwd(),
    input: options.input,
    env: {
      ...process.env,
      PATH: `${join(fixture.dir, 'bin')}:${process.env.PATH}`,
      APIPOOL_DEPLOY_DIR: fixture.dir,
      APIPOOL_DEPLOY_LOCK: join(fixture.dir, 'deploy.lock'),
      APIPOOL_CUTOVER_PROBE_BASE: 'http://probe.test',
      MOCK_CALL_LOG: fixture.log,
      ...options.env,
    },
    encoding: 'utf8',
  });
}

test('env-set-batch 幂等替换/追加多个键并保留引号值', async () => {
  const fixture = await makeCutoverFixture({ mode: 'legacy' });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const result = runCutover(fixture, [
      'env-set-batch',
      'K1=V1',
      'K2=value with spaces',
    ]);
    assert.equal(result.status, 0, result.stderr);
  }
  const body = await readFile(join(fixture.dir, '.env.deploy'), 'utf8');
  assert.equal((body.match(/^K1=/gm) ?? []).length, 1);
  assert.equal((body.match(/^K2=/gm) ?? []).length, 1);
  assert.match(body, /^K2=value with spaces$/m);
  assert.match(body, /^QUOTED_VALUE='keep \$literal spaces'$/m);
  assert.deepEqual(
    (await readdir(fixture.dir)).filter((name) =>
      name.startsWith('.env.deploy.')
    ),
    []
  );
});

test('status 在探测不可达时仍打印四开关与实时状态', async () => {
  const fixture = await makeCutoverFixture({
    mode: 'legacy',
    checkout: 'true',
    ledger: 'false',
    display: 'false',
  });
  const result = runCutover(fixture, ['status'], {
    env: { MOCK_PROBE_PROFILE: 'failure' },
  });
  assert.equal(result.status, 0, result.stderr);
  for (const value of ['legacy', 'true', 'false', 'api2=', 'newapi=']) {
    assert.match(result.stdout, new RegExp(value));
  }
});

test('legacy 与缺失 API_MODE 下禁止跳级，maintenance 是唯一恢复入口', async () => {
  for (const mode of ['legacy', undefined] as const) {
    for (const command of ['activate-wallet', 'portal', 'finalize']) {
      const fixture = await makeCutoverFixture({
        mode,
        checkout: 'false',
        ledger: 'true',
        display: 'true',
      });
      const args =
        command === 'activate-wallet'
          ? [command, '--evidence', join(fixture.dir, 'evidence.txt')]
          : [command];
      const result = runCutover(fixture, args, { input: 'yes\n' });
      assert.equal(result.status, 78, `${command}: ${result.stderr}`);
    }
    const fixture = await makeCutoverFixture({ mode, checkout: 'true' });
    const recovered = runCutover(fixture, ['maintenance']);
    assert.equal(recovered.status, 0, recovered.stderr);
    assert.match(
      await readFile(join(fixture.dir, '.env.deploy'), 'utf8'),
      /^APIPOOL_API_MODE=maintenance$/m
    );
  }
});

test('钱包半状态不能 portal，但 activate-wallet 重跑会补齐、重建并验证运行态', async () => {
  const fixture = await makeCutoverFixture({
    mode: 'maintenance',
    checkout: 'false',
    ledger: 'true',
    display: 'false',
  });
  assert.equal(runCutover(fixture, ['portal']).status, 78);
  const activated = runCutover(
    fixture,
    ['activate-wallet', '--evidence', join(fixture.dir, 'evidence.txt')],
    { input: 'yes\n' }
  );
  assert.equal(activated.status, 0, activated.stderr);
  const body = await readFile(join(fixture.dir, '.env.deploy'), 'utf8');
  assert.match(body, /^WALLET_LEDGER_WRITE_ENABLED=true$/m);
  assert.match(body, /^WALLET_DISPLAY_ENABLED=true$/m);
  const calls = await readFile(fixture.log, 'utf8');
  assert.match(calls, /docker compose .* up -d/);
  assert.match(calls, /printenv WALLET_LEDGER_WRITE_ENABLED/);
  assert.match(calls, /live-smoke --recharge/);
});

test('文件已 true 但容器仍旧值时 portal 拒绝并提示重跑 activate-wallet', async () => {
  const fixture = await makeCutoverFixture({
    mode: 'maintenance',
    checkout: 'false',
    ledger: 'true',
    display: 'true',
  });
  await writeFile(
    join(fixture.dir, '.cutover-recharge-ok'),
    'TIMESTAMP=fixture\nIMAGE_TAG=sha-current\n'
  );
  const result = runCutover(fixture, ['portal'], {
    env: { MOCK_RUNTIME_STALE: '1' },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /activate-wallet/);
});

test('隔离探测不满足 503/404 时 activate-wallet 与 portal 都拒绝', async () => {
  for (const command of ['activate-wallet', 'portal'] as const) {
    const fixture = await makeCutoverFixture({
      mode: 'maintenance',
      checkout: 'false',
      ledger: 'true',
      display: 'true',
    });
    await writeFile(
      join(fixture.dir, '.cutover-recharge-ok'),
      'TIMESTAMP=fixture\nIMAGE_TAG=sha-current\n'
    );
    const args =
      command === 'activate-wallet'
        ? [command, '--evidence', join(fixture.dir, 'evidence.txt')]
        : [command];
    const result = runCutover(fixture, args, {
      input: 'yes\n',
      env: { MOCK_PROBE_PROFILE: 'failure' },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /maintenance/);
  }
});

test('portal 切换后探测失败会自动收敛回 maintenance', async () => {
  const fixture = await makeCutoverFixture({
    mode: 'maintenance',
    checkout: 'false',
    ledger: 'true',
    display: 'true',
  });
  await writeFile(
    join(fixture.dir, '.cutover-recharge-ok'),
    'TIMESTAMP=fixture\nIMAGE_TAG=sha-current\n'
  );
  const result = runCutover(fixture, ['portal'], {
    env: { MOCK_PROBE_PROFILE: 'portal-fail' },
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /收敛.*maintenance/);
  assert.match(
    await readFile(join(fixture.dir, '.env.deploy'), 'utf8'),
    /^APIPOOL_API_MODE=maintenance$/m
  );
});

test('portal 成功后 gateway smoke 在案且三探测通过才能 finalize 开收款', async () => {
  const fixture = await makeCutoverFixture({
    mode: 'maintenance',
    checkout: 'false',
    ledger: 'true',
    display: 'true',
  });
  await writeFile(
    join(fixture.dir, '.cutover-recharge-ok'),
    'TIMESTAMP=recharge\nIMAGE_TAG=sha-current\n'
  );
  const portal = runCutover(fixture, ['portal'], {
    env: { MOCK_PROBE_PROFILE: 'happy' },
  });
  assert.equal(portal.status, 0, portal.stderr);
  await writeFile(
    join(fixture.dir, '.cutover-smoke-ok'),
    'TIMESTAMP=gateway\n'
  );
  const finalized = runCutover(fixture, ['finalize'], {
    input: 'yes\n',
    env: { MOCK_PROBE_PROFILE: 'happy' },
  });
  assert.equal(finalized.status, 0, finalized.stderr);
  assert.match(
    await readFile(join(fixture.dir, '.env.deploy'), 'utf8'),
    /^APIPOOL_CHECKOUT_ENABLED=true$/m
  );
});

test('portal/finalize 拒绝缺失或陈旧 smoke 标志', async () => {
  const portalFixture = await makeCutoverFixture({
    mode: 'maintenance',
    checkout: 'false',
    ledger: 'true',
    display: 'true',
  });
  assert.equal(runCutover(portalFixture, ['portal']).status, 78);
  await writeFile(
    join(portalFixture.dir, '.cutover-recharge-ok'),
    'IMAGE_TAG=sha-old\n'
  );
  assert.equal(runCutover(portalFixture, ['portal']).status, 78);

  const finalFixture = await makeCutoverFixture({
    mode: 'portal',
    checkout: 'false',
    ledger: 'true',
    display: 'true',
  });
  await writeFile(
    join(finalFixture.dir, '.cutover-recharge-ok'),
    'IMAGE_TAG=sha-current\n'
  );
  assert.equal(runCutover(finalFixture, ['finalize']).status, 78);
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

test('smoke 工装、镜像产物与 live-smoke 两种模式完整接线', async () => {
  const [gateway, recharge, live, dockerfile] = await Promise.all([
    readFile('scripts/smoke-gateway.ts', 'utf8'),
    readFile('scripts/smoke-recharge.ts', 'utf8'),
    readFile('deploy/live-smoke.sh', 'utf8'),
    readFile('Dockerfile', 'utf8'),
  ]);
  assert.match(gateway, /from 'openai'/);
  assert.match(gateway, /from '@anthropic-ai\/sdk'/);
  assert.match(gateway, /computeChargeMicroUsd/);
  assert.match(gateway, /newapiRequestId/);
  assert.match(recharge, /handleCheckoutSuccess/);
  assert.match(recharge, /manual_adjustment/);
  assert.match(recharge, /amount \* 10_000/);
  assert.match(live, /--gateway/);
  assert.match(live, /--recharge/);
  assert.match(dockerfile, /smoke-gateway\.cjs/);
  assert.match(dockerfile, /smoke-recharge\.cjs/);
});

async function makeDeployFixture(mode: string, checkout: string) {
  const fixture = await makeCutoverFixture({
    mode,
    checkout,
    ledger: 'true',
    display: 'true',
  });
  await copyFile('deploy/deploy.sh', join(fixture.dir, 'deploy/deploy.sh'));
  await copyFile('deploy/lib.sh', join(fixture.dir, 'deploy/lib.sh'));
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
printf 'TIMESTAMP=fixture\\nIMAGE_TAG=%s\\n' "$tag" >"$APIPOOL_DEPLOY_DIR/.cutover-recharge-ok"
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
  await writeFile(
    join(fixture.dir, 'docker-compose.prod.yml'),
    'services:\n  apipool-v2: {}\n',
    'utf8'
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

test('portal 常规发布在 pull 前冻结 checkout，recharge smoke 失败保持冻结并 exit 75', async () => {
  const fixture = await makeDeployFixture('portal', 'true');
  const result = runDeploy(fixture, '1');
  assert.equal(result.status, 75, result.stderr);
  const log = await readFile(fixture.log, 'utf8');
  const freezeUp = log.indexOf('up -d checkout=false');
  const pull = log.indexOf('pull checkout=false');
  assert.ok(freezeUp >= 0 && pull > freezeUp, '运行容器必须在 pull 前冻结');
  assert.match(log, /docker compose .* pull checkout=false/);
  assert.match(log, /live-smoke --recharge/);
  assert.match(
    await readFile(join(fixture.dir, '.env.deploy'), 'utf8'),
    /^APIPOOL_CHECKOUT_ENABLED=false$/m
  );
});

test('portal 常规发布 recharge smoke 成功后重开 checkout 并刷新当前 IMAGE_TAG 标志', async () => {
  const fixture = await makeDeployFixture('portal', 'true');
  const result = runDeploy(fixture);
  assert.equal(result.status, 0, result.stderr);
  assert.match(
    await readFile(join(fixture.dir, '.env.deploy'), 'utf8'),
    /^APIPOOL_CHECKOUT_ENABLED=true$/m
  );
  assert.match(
    await readFile(join(fixture.dir, '.cutover-recharge-ok'), 'utf8'),
    /^IMAGE_TAG=sha-new$/m
  );
});

test('legacy/maintenance 或 checkout 非 true 的发布不触发 recharge 门禁', async () => {
  for (const [mode, checkout] of [
    ['legacy', 'true'],
    ['maintenance', 'true'],
    ['portal', 'false'],
  ] as const) {
    const fixture = await makeDeployFixture(mode, checkout);
    const result = runDeploy(fixture);
    assert.equal(result.status, 0, `${mode}/${checkout}: ${result.stderr}`);
    assert.doesNotMatch(await readFile(fixture.log, 'utf8'), /live-smoke/);
  }
});
