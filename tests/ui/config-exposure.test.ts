import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('the root layout never hands full config (with secrets) to script services', async () => {
  const layout = await readFile('src/app/layout.tsx', 'utf8');

  // getAllConfigs() 含 stripe_secret_key / NEWAPI_ADMIN_TOKEN 等；这些服务把
  // 读到的值拼进 <head>/<body> 脚本，多读一个键就外泄。
  assert.doesNotMatch(layout, /await getAllConfigs\(\)/);
  assert.doesNotMatch(layout, /import[^\n]*getAllConfigs/);
  assert.match(layout, /await getScriptInjectionConfigs\(\)/);
});

test('the script-injection allowlist carries no secret-looking keys', async () => {
  const { getScriptInjectionConfigs } = await import('@/shared/models/config');
  assert.equal(typeof getScriptInjectionConfigs, 'function');

  const source = await readFile('src/shared/models/config.ts', 'utf8');
  const allowlist = source
    .split('SCRIPT_INJECTION_CONFIG_KEYS = [')[1]
    .split('] as const')[0];

  for (const forbidden of [
    'secret',
    'token',
    'password',
    'api_key',
    'signing',
  ]) {
    assert.doesNotMatch(
      allowlist,
      new RegExp(forbidden, 'i'),
      `allowlist must not contain ${forbidden}`
    );
  }
});
