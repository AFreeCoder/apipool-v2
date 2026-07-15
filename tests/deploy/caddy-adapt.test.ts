import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const hasCaddy = spawnSync('caddy', ['version'], { encoding: 'utf8' }).status === 0;

function renderConfig(
  mode: 'legacy' | 'maintenance' | 'portal',
  guardEnv: Record<string, string>
) {
  const dir = mkdtempSync(join(tmpdir(), 'apipool-caddy-'));
  const envFile = join(dir, '.env.deploy');
  writeFileSync(envFile, `APIPOOL_API_MODE=${mode}\n`, 'utf8');
  const rendered = spawnSync(
    'bash',
    ['deploy/configure-caddy.sh', '--print-config'],
    {
      env: {
        ...process.env,
        APIPOOL_DEPLOY_ENV_FILE: envFile,
        APIPOOL_API_MODE: '',
        APIPOOL_NEWAPI_BASIC_AUTH_USER: '',
        APIPOOL_NEWAPI_BASIC_AUTH_HASH: '',
        APIPOOL_NEWAPI_ALLOWED_IPS: '',
        APIPOOL_NEWAPI_ALLOW_UNPROTECTED: '',
        ...guardEnv,
      },
      encoding: 'utf8',
    }
  );
  assert.equal(rendered.status, 0, rendered.stderr);
  return rendered.stdout;
}

function runCaddy(command: 'adapt' | 'validate', config: string) {
  const result = spawnSync(
    'caddy',
    [command, '--config', '-', '--adapter', 'caddyfile'],
    { input: config, encoding: 'utf8' }
  );
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

function visit(value: unknown, callback: (node: Record<string, unknown>) => void) {
  if (!value || typeof value !== 'object') return;
  if (!Array.isArray(value)) callback(value as Record<string, unknown>);
  for (const child of Object.values(value)) {
    if (Array.isArray(child)) {
      for (const item of child) visit(item, callback);
    } else {
      visit(child, callback);
    }
  }
}

test(
  'Basic Auth 下 newapi /v1 路由先独立返回 404，管理路径仍受认证保护',
  { skip: !hasCaddy },
  () => {
    const hash = spawnSync(
      'caddy',
      ['hash-password', '--plaintext', 'fixture-password'],
      { encoding: 'utf8' }
    ).stdout.trim();
    const config = renderConfig('portal', {
      APIPOOL_NEWAPI_BASIC_AUTH_USER: 'ops',
      APIPOOL_NEWAPI_BASIC_AUTH_HASH: hash,
    });
    const adapted = JSON.parse(runCaddy('adapt', config));
    let v1StaticRoute: Record<string, unknown> | undefined;
    let hasAuthentication = false;
    visit(adapted, (node) => {
      const serialized = JSON.stringify(node);
      const matchers = Array.isArray(node.match)
        ? (node.match as Record<string, unknown>[])
        : [];
      const directlyMatchesV1 = matchers.some(
        (matcher) =>
          Array.isArray(matcher.path) && matcher.path.includes('/v1*')
      );
      if (
        directlyMatchesV1 &&
        serialized.includes('static_response') &&
        serialized.includes('"status_code":404')
      ) {
        v1StaticRoute ??= node;
      }
      if (node.handler === 'authentication') hasAuthentication = true;
    });
    assert.ok(v1StaticRoute, 'adapt 结果应含 /v1* 的 404 static_response');
    assert.doesNotMatch(JSON.stringify(v1StaticRoute), /authentication/);
    assert.equal(hasAuthentication, true, 'fallback 管理路径应保留认证 handler');
  }
);

test(
  'basic_auth、IP 白名单与空 guards 三种 Caddyfile 都能真实 validate',
  { skip: !hasCaddy },
  () => {
    const hash = spawnSync(
      'caddy',
      ['hash-password', '--plaintext', 'fixture-password'],
      { encoding: 'utf8' }
    ).stdout.trim();
    const fixtures: Record<string, string>[] = [
      {
        APIPOOL_NEWAPI_BASIC_AUTH_USER: 'ops',
        APIPOOL_NEWAPI_BASIC_AUTH_HASH: hash,
      },
      { APIPOOL_NEWAPI_ALLOWED_IPS: '203.0.113.7 198.51.100.0/24' },
      { APIPOOL_NEWAPI_ALLOW_UNPROTECTED: 'true' },
    ];
    for (const fixture of fixtures) {
      const config = renderConfig('portal', fixture);
      runCaddy('validate', config);
      assert.match(config, /handle \/v1\*/);
      assert.match(config, /respond "not found" 404/);
    }
  }
);

test('CI 固定安装 Caddy，缺二进制不会被 skip 掩盖', async () => {
  const workflow = await import('node:fs/promises').then(({ readFile }) =>
    readFile('.github/workflows/mvp-verify.yaml', 'utf8')
  );
  assert.match(workflow, /apt-get install -y caddy/);
  assert.match(workflow, /caddy version/);
});
