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
  happy:*app*/v1/models) status=401 ;;
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
runtime="${'${MOCK_RUNTIME_CHECKOUT:-$checkout}'}"
echo "docker $* checkout=$checkout" >>"$MOCK_CALL_LOG"
case "$*" in
  *"up -d apipool-v2"*)
    if [ "${'${MOCK_PORTAL_UP_FAIL:-false}'}" = true ]; then exit 1; fi
    ;;
  *"exec -T apipool-v2 printenv APIPOOL_CHECKOUT_ENABLED"*)
    if [ "${'${MOCK_RUNTIME_UNAVAILABLE:-false}'}" = true ]; then exit 1; fi
    printf '%s\\n' "$runtime"
    ;;
  *"stop apipool-v2"*)
    : >"$APIPOOL_DEPLOY_DIR/mock-portal-stopped"
    ;;
  *"ps --status running --services apipool-v2"*)
    if [ "${'${MOCK_STOP_PERSISTS:-false}'}" = true ]; then
      printf '%s\\n' apipool-v2
    elif [ ! -f "$APIPOOL_DEPLOY_DIR/mock-portal-stopped" ]; then
      printf '%s\\n' apipool-v2
    fi
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
  --image)
    printf 'TIMESTAMP=fixture\\nIMAGE_TAG=%s\\n' "$tag" >"$APIPOOL_DEPLOY_DIR/.live-smoke-image-ok"
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
  for (const name of [
    '.live-smoke-recharge-ok',
    '.live-smoke-gateway-ok',
    '.live-smoke-image-ok',
  ]) {
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
  assert.match(result.stdout, /APIPOOL_CHECKOUT_CONFIGURED=false/);
  assert.match(result.stdout, /APIPOOL_CHECKOUT_RUNNING=false/);
  assert.match(result.stdout, /IMAGE_TAG=sha-current/);
  assert.match(result.stdout, /app=401/);
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

test('verify 在最终态路由通过后依次完成 MVP、充值、长上下文网关和异步图片 smoke', async () => {
  const fixture = await makeFixture();
  const result = runGoLive(fixture, ['verify']);
  assert.equal(result.status, 0, result.stderr);
  const log = await readFile(fixture.log, 'utf8');
  assert.match(log, /live-smoke\s*\n/);
  assert.match(log, /live-smoke --recharge/);
  assert.match(log, /live-smoke --gateway/);
  assert.match(log, /live-smoke --image/);
  for (const marker of [
    '.live-smoke-recharge-ok',
    '.live-smoke-gateway-ok',
    '.live-smoke-image-ok',
  ]) {
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

  const missingImage = await makeFixture();
  const missingImageEvidence = await writeRestoreEvidence(missingImage);
  for (const name of ['.live-smoke-recharge-ok', '.live-smoke-gateway-ok']) {
    await writeFile(
      join(missingImage.dir, name),
      'TIMESTAMP=fixture\nIMAGE_TAG=sha-current\n',
      'utf8'
    );
  }
  const missingImageResult = runGoLive(missingImage, [
    'open-checkout',
    '--evidence',
    missingImageEvidence,
  ]);
  assert.equal(missingImageResult.status, 78, missingImageResult.stderr);
  assert.match(missingImageResult.stderr, /\.live-smoke-image-ok/);

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

test('close-checkout 无需确认即可原子冻结收款并验证容器运行态', async () => {
  const fixture = await makeFixture('true');
  const result = runGoLive(fixture, ['close-checkout']);
  assert.equal(result.status, 0, result.stderr);
  const env = await readFile(join(fixture.dir, '.env.deploy'), 'utf8');
  assert.match(env, /^APIPOOL_CHECKOUT_ENABLED=false$/m);
  assert.match(env, /^QUOTED_VALUE='keep \$literal spaces'$/m);
  const log = await readFile(fixture.log, 'utf8');
  assert.match(log, /docker compose .* up -d apipool-v2 checkout=false/);
  assert.match(log, /exec -T apipool-v2 printenv APIPOOL_CHECKOUT_ENABLED/);
  assert.doesNotMatch(log, /stop apipool-v2/);
});

test('close-checkout 无法确认运行态关闭时紧急停止门户并返回失败', async () => {
  for (const env of [
    { MOCK_PORTAL_UP_FAIL: 'true', MOCK_RUNTIME_CHECKOUT: 'true' },
    { MOCK_RUNTIME_CHECKOUT: 'true' },
  ]) {
    const fixture = await makeFixture('true');
    const result = runGoLive(fixture, ['close-checkout'], { env });
    assert.equal(result.status, 75, result.stderr);
    assert.doesNotMatch(result.stdout, /checkout 已冻结/);
    assert.match(result.stderr, /紧急停止门户容器/);
    assert.match(result.stderr, /门户容器已停止/);
    const configured = await readFile(join(fixture.dir, '.env.deploy'), 'utf8');
    assert.match(configured, /^APIPOOL_CHECKOUT_ENABLED=false$/m);
    const log = await readFile(fixture.log, 'utf8');
    assert.match(log, /stop apipool-v2/);
    assert.match(log, /ps --status running --services apipool-v2/);
  }
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

test('smoke 工装、镜像产物与 live-smoke 三种专项模式完整接线', async () => {
  const [gateway, image, recharge, live, dockerfile] = await Promise.all([
    readFile('scripts/smoke-gateway.ts', 'utf8'),
    readFile('scripts/smoke-image.ts', 'utf8'),
    readFile('scripts/smoke-recharge.ts', 'utf8'),
    readFile('deploy/live-smoke.sh', 'utf8'),
    readFile('Dockerfile', 'utf8'),
  ]);
  assert.match(gateway, /from 'openai'/);
  assert.match(gateway, /from '@anthropic-ai\/sdk'/);
  assert.match(gateway, /parsePricingSpec/);
  assert.match(gateway, /computePricingCharge/);
  assert.doesNotMatch(gateway, /computeTokenChargeMicroUsd/);
  assert.doesNotMatch(gateway, /computePerCallChargeMicroUsd/);
  assert.doesNotMatch(gateway, /computeChargeMicroUsd/);
  assert.match(gateway, /newapiRequestId/);
  assert.match(recharge, /handleCheckoutSuccess/);
  assert.match(recharge, /manual_adjustment/);
  assert.match(recharge, /amount \* 10_000/);
  assert.doesNotMatch(recharge, /WALLET_LEDGER_WRITE_ENABLED/);
  assert.match(live, /--gateway/);
  assert.match(live, /--recharge/);
  assert.match(live, /--image/);
  assert.match(live, /https:\/\/app\.apipool\.dev\/v1/);
  assert.match(live, /APIPOOL_SMOKE_LONG_CONTEXT_MODEL/);
  assert.match(live, /\.live-smoke-gateway-ok/);
  assert.match(live, /\.live-smoke-recharge-ok/);
  assert.match(live, /\.live-smoke-image-ok/);
  assert.match(image, /\/images\/generations/);
  assert.match(image, /response\.status === 202/);
  assert.match(dockerfile, /smoke-gateway\.cjs/);
  assert.match(dockerfile, /smoke-recharge\.cjs/);
  assert.match(dockerfile, /smoke-image\.cjs/);
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
  await executable(
    join(fixture.dir, 'bin/sqlite3'),
    `#!/bin/sh
if [ "${'${MOCK_SQLITE_FAIL:-0}'}" = 1 ]; then exit 1; fi
tag="$(sed -n 's/^IMAGE_TAG=//p' "$APIPOOL_DEPLOY_DIR/release.env" | tail -1)"
if [ "${'${MOCK_SQLITE_FAIL_AFTER:-0}'}" = 1 ] && [ "$tag" = sha-new ]; then exit 1; fi
if [ "${'${MOCK_CONSOLIDATED_BEFORE:-0}'}" = 1 ]; then
  printf 'consolidated\\n'
  exit 0
fi
if [ "${'${MOCK_MIGRATE_GROUPS:-0}'}" = 1 ] && [ "$tag" = sha-new ]; then
  printf 'consolidated\\n'
else
  printf 'legacy\\n'
fi
`
  );
  await mkdir(join(fixture.dir, 'data/portal'), { recursive: true });
  await writeFile(
    join(fixture.dir, 'data/portal/portal.db'),
    'fixture',
    'utf8'
  );
  await executable(
    join(fixture.dir, 'bin/curl'),
    `#!/bin/sh
url=""
for arg in "$@"; do url="$arg"; done
if [ -n "${'${MOCK_CURL_FAIL_URL:-}'}" ] && [ "$url" = "$MOCK_CURL_FAIL_URL" ]; then
  exit 7
fi
exit 0
`
  );
  await executable(join(fixture.dir, 'bin/sleep'), '#!/bin/sh\nexit 0\n');
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

function runDeploy(
  fixture: { dir: string; log: string },
  smokeExit = '0',
  env: Record<string, string> = {}
) {
  return spawnSync('bash', [join(fixture.dir, 'deploy/deploy.sh'), 'sha-new'], {
    env: {
      ...process.env,
      PATH: `${join(fixture.dir, 'bin')}:${process.env.PATH}`,
      APIPOOL_DEPLOY_DIR: fixture.dir,
      APIPOOL_DEPLOY_LOCK: join(fixture.dir, 'deploy.lock'),
      MOCK_CALL_LOG: fixture.log,
      MOCK_SMOKE_EXIT: smokeExit,
      ...env,
    },
    encoding: 'utf8',
  });
}

test('portal 最终健康探针失败时发布回滚并返回失败', async () => {
  const fixture = await makeDeployFixture('false');
  const result = runDeploy(fixture, '0', {
    MOCK_CURL_FAIL_URL: 'http://127.0.0.1:3000/',
  });

  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /healthcheck failed for sha-new/);
  assert.match(result.stderr, /rolling back container image to sha-current/);
  assert.match(
    await readFile(join(fixture.dir, 'release.env'), 'utf8'),
    /^IMAGE_TAG=sha-current$/m
  );
});

test('分组数据迁移后健康失败会拒绝仅回滚旧镜像', async () => {
  const fixture = await makeDeployFixture('false');

  const result = runDeploy(fixture, '0', {
    MOCK_CURL_FAIL_URL: 'http://127.0.0.1:3000/',
    MOCK_MIGRATE_GROUPS: '1',
  });

  assert.equal(result.status, 78, result.stderr);
  assert.match(result.stderr, /image-only rollback is forbidden/);
  assert.doesNotMatch(result.stderr, /rolling back container image/);
  assert.match(
    await readFile(join(fixture.dir, 'release.env'), 'utf8'),
    /^IMAGE_TAG=sha-new$/m
  );
});

test('分组状态查询失败时不授权仅回滚旧镜像', async () => {
  const fixture = await makeDeployFixture('false');
  const result = runDeploy(fixture, '0', {
    MOCK_CURL_FAIL_URL: 'http://127.0.0.1:3000/',
    MOCK_SQLITE_FAIL: '1',
  });

  assert.equal(result.status, 78, result.stderr);
  assert.match(result.stderr, /before=unknown after=unknown/);
  assert.doesNotMatch(result.stderr, /rolling back container image/);
});

test('已合并分组在发布后状态未知时也不授权仅回滚旧镜像', async () => {
  const fixture = await makeDeployFixture('false');
  const result = runDeploy(fixture, '0', {
    MOCK_CONSOLIDATED_BEFORE: '1',
    MOCK_CURL_FAIL_URL: 'http://127.0.0.1:3000/',
    MOCK_SQLITE_FAIL_AFTER: '1',
  });

  assert.equal(result.status, 78, result.stderr);
  assert.match(result.stderr, /before=consolidated after=unknown/);
  assert.doesNotMatch(result.stderr, /rolling back container image/);
});

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
