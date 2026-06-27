import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import {
  assertHealthyNewApi,
  buildCleanupStateDetail,
  isDisabledKeyRejected,
  parseLaunchModelAssistantText,
  resolveSmokeLaunchModel,
} from '../../scripts/smoke-mvp';

test('MVP smoke verifies request count, token count, and recent logs', async () => {
  const script = await readFile(
    join(process.cwd(), 'scripts/smoke-mvp.ts'),
    'utf8'
  );

  assert.match(script, /waitForUsageVisibility/);
  assert.match(script, /usage\.summary\.requestCount\s*>\s*0/);
  assert.match(
    script,
    /usage\.summary\.inputTokens\s*\+\s*usage\.summary\.outputTokens\s*>\s*0/
  );
  assert.match(script, /usage\.logs\.length\s*>\s*0/);
});

test('MVP smoke verifies launch model distribution', async () => {
  const script = await readFile(
    join(process.cwd(), 'scripts/smoke-mvp.ts'),
    'utf8'
  );

  assert.match(script, /byModel/);
  assert.match(script, /modelId\s*===\s*expectedModel/);
  assert.match(script, /modelUsage\.requests\s*>\s*0/);
  assert.match(script, /modelUsage\.tokens\s*>\s*0/);
});

test('MVP smoke verifies that launch model returns assistant content', () => {
  const assistantText = parseLaunchModelAssistantText(
    JSON.stringify({
      choices: [
        {
          message: {
            role: 'assistant',
            content: 'pong',
          },
        },
      ],
    })
  );

  assert.equal(assistantText, 'pong');
  assert.equal(parseLaunchModelAssistantText('{"choices":[]}'), undefined);
  assert.equal(parseLaunchModelAssistantText('not json'), undefined);
});

test('MVP smoke only accepts HTTP rejection for disabled keys', () => {
  assert.equal(isDisabledKeyRejected({ ok: false, status: 401 }), true);
  assert.equal(isDisabledKeyRejected({ ok: false, status: 403 }), true);
  assert.equal(isDisabledKeyRejected({ ok: false, status: 200 }), false);
  assert.equal(isDisabledKeyRejected({ ok: true, status: 200 }), false);
});

test('MVP smoke only accepts verified launch models', () => {
  assert.equal(resolveSmokeLaunchModel(undefined, 'gpt-4o'), 'gpt-4o-mini');
  assert.throws(
    () => resolveSmokeLaunchModel('gpt-4o', 'gpt-4o-mini'),
    /must be an available smoke-tested model/
  );
  assert.equal(resolveSmokeLaunchModel('gpt-4o-mini', 'gpt-4o'), 'gpt-4o-mini');
});

test('MVP smoke requires an operator with quota adjustment permission', async () => {
  const script = await readFile(
    join(process.cwd(), 'scripts/smoke-mvp.ts'),
    'utf8'
  );

  assert.match(script, /APIPOOL_SMOKE_OPERATOR_USER_ID/);
  assert.match(script, /PERMISSIONS\.APIPOOL_QUOTA_ADJUST/);
  assert.match(
    script,
    /hasPermission\([\s\S]*PERMISSIONS\.APIPOOL_QUOTA_ADJUST/
  );
  assert.doesNotMatch(
    script,
    /getEnv\('APIPOOL_SMOKE_OPERATOR_USER_ID'\)\s*\|\|\s*portalUserId/
  );
});

test('MVP smoke checks New API health before creating keys', async () => {
  const script = await readFile(
    join(process.cwd(), 'scripts/smoke-mvp.ts'),
    'utf8'
  );

  assert.match(script, /createNewApiClient/);
  assert.match(script, /\.healthCheck\(\)/);
  assert.match(script, /record\(\s*'check New API health'/);
  const healthRecordIndex = script.search(/record\(\s*'check New API health'/);
  const keyCreationIndex = script.indexOf('await createPortalApiKey');
  assert.ok(
    healthRecordIndex >= 0 && healthRecordIndex < keyCreationIndex,
    'health check should run before key creation smoke'
  );
});

test('MVP smoke fails fast when New API health is unavailable', () => {
  assert.doesNotThrow(() =>
    assertHealthyNewApi({ ok: true, status: 200, version: 'ready' })
  );

  assert.throws(
    () => assertHealthyNewApi({ ok: false, status: 503 }),
    /New API health check failed: 503/
  );
});

test('MVP smoke creates an official group-bound key and records cleanup state', async () => {
  const script = await readFile(
    join(process.cwd(), 'scripts/smoke-mvp.ts'),
    'utf8'
  );

  assert.match(script, /groupSlug:\s*['"]official['"]/);
  assert.match(script, /record\(\s*['"]cleanup state['"]/);
  assert.match(script, /disabled/);
});

test('MVP smoke cleanup state output includes the key id and manual cleanup details', () => {
  assert.match(
    buildCleanupStateDetail({
      keyId: 'key_smoke_123',
      state: 'disabled',
    }),
    /key_smoke_123/
  );

  const failedDetail = buildCleanupStateDetail({
    keyId: 'key_smoke_123',
    state: 'disable_failed',
    errorMessage: 'remote unavailable',
  });

  assert.match(failedDetail, /key_smoke_123/);
  assert.match(failedDetail, /manual cleanup required/);
  assert.match(failedDetail, /remote unavailable/);
});

test('runbook documents MVP smoke commands, live gate, and prerequisites', async () => {
  const runbook = await readFile(
    join(process.cwd(), 'docs/07-runbook.md'),
    'utf8'
  );

  assert.match(runbook, /npm run catalog:init/);
  assert.match(runbook, /npm run smoke:mvp/);
  assert.match(runbook, /APIPOOL_SMOKE_REQUIRE_LIVE=true npm run smoke:mvp/);
  assert.match(runbook, /APIPOOL_SMOKE_MODEL/);
  assert.match(runbook, /APIPOOL_SMOKE_QUOTA_USD/);
  assert.match(runbook, /official/);
  assert.doesNotMatch(runbook, /live\/sandbox/);
});

test('New API bridge contract documents the health endpoint', async () => {
  const contract = await readFile(
    join(process.cwd(), 'docs/04-newapi-contract.md'),
    'utf8'
  );

  assert.match(contract, /健康检查[\s\S]*`GET \/api\/status`/);
});
