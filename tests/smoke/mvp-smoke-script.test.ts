import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import {
  assertHealthyNewApi,
  buildCleanupStateDetail,
  buildSmokePriceReconciliationReport,
  finishSkipped,
  getSmokePriceReconciliationConfig,
  isDisabledKeyRejected,
  parseLaunchModelAssistantText,
  resolveSmokeConfirmedEffectivePrice,
  resolveSmokeLaunchModel,
} from '../../scripts/smoke-mvp';

test('MVP smoke verifies a settled local request ledger entry', async () => {
  const script = await readFile(
    join(process.cwd(), 'scripts/smoke-mvp.ts'),
    'utf8'
  );

  assert.match(script, /waitForUsageVisibility/);
  assert.match(script, /usage\?\.status === ['"]settled['"]/);
  assert.match(script, /usage\.newapiRequestId/);
  assert.match(script, /usage\.chargedMicroUsd !== null/);
  assert.match(script, /from\(requestLedger\)/);
  assert.doesNotMatch(script, /getPortalUsage/);
  assert.doesNotMatch(script, /usageSnapshot/);
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
  assert.equal(
    resolveSmokeLaunchModel(undefined, ['gpt-4o-mini'], 'gpt-4o'),
    'gpt-4o-mini'
  );
  assert.throws(
    () =>
      resolveSmokeLaunchModel('gpt-4o', ['gpt-4o-mini'], 'gpt-4o-mini', [
        'gpt-4o-mini',
      ]),
    /must be callable in the smoke group/
  );
  assert.equal(
    resolveSmokeLaunchModel('gpt-4o-mini', ['gpt-4o-mini'], 'gpt-4o'),
    'gpt-4o-mini'
  );
  assert.equal(
    resolveSmokeLaunchModel('gpt-4o', ['gpt-4o-mini'], 'gpt-4o-mini', [
      'gpt-4o',
      'gpt-4o-mini',
    ]),
    'gpt-4o'
  );
});

test('MVP smoke resolves launch candidates from the database catalog', async () => {
  const script = await readFile(
    join(process.cwd(), 'scripts/smoke-mvp.ts'),
    'utf8'
  );

  assert.match(script, /getCallableModelIdsByGroupUncached/);
  assert.doesNotMatch(script, /smokeTested/);
  assert.doesNotMatch(script, /publicModels/);
  assert.doesNotMatch(script, /getDefaultCallableModelId/);
  assert.doesNotMatch(script, /isModelCallable/);
});

test('MVP smoke requires an operator with quota adjustment permission', async () => {
  const script = await readFile(
    join(process.cwd(), 'scripts/smoke-mvp.ts'),
    'utf8'
  );

  assert.match(script, /APIPOOL_SMOKE_OPERATOR_USER_ID/);
  assert.match(script, /APIPOOL_SMOKE_PORTAL_EMAIL/);
  assert.match(script, /APIPOOL_SMOKE_OPERATOR_EMAIL/);
  assert.match(script, /assertSmokeIdentity/);
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

  assert.match(script, /APIPOOL_SMOKE_GROUP_SLUG/);
  assert.match(script, /APIPOOL_SMOKE_GATEWAY_BASE_URL/);
  assert.match(script, /\|\|\s*['"]official['"]/);
  assert.match(script, /groupSlug:\s*smokeGroupSlug/);
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

test('MVP smoke exposes an opt-in price reconciliation gate', async () => {
  const script = await readFile(
    join(process.cwd(), 'scripts/smoke-mvp.ts'),
    'utf8'
  );

  assert.deepEqual(getSmokePriceReconciliationConfig({}), {
    enabled: false,
    toleranceMicroUsd: 0,
  });
  assert.deepEqual(
    getSmokePriceReconciliationConfig({
      APIPOOL_SMOKE_PRICE_TOLERANCE_QUOTA: 'not-a-number',
    }),
    {
      enabled: false,
      toleranceMicroUsd: 0,
    }
  );
  assert.deepEqual(
    getSmokePriceReconciliationConfig({
      APIPOOL_SMOKE_PRICE_RECONCILIATION: 'true',
      APIPOOL_SMOKE_PRICE_TOLERANCE_QUOTA: '7',
    }),
    {
      enabled: true,
      toleranceMicroUsd: 7,
    }
  );
  assert.match(script, /APIPOOL_SMOKE_PRICE_RECONCILIATION/);
  assert.match(script, /APIPOOL_SMOKE_PRICE_TOLERANCE_QUOTA/);
  assert.match(script, /record\(\s*['"]reconcile smoke price['"]/);
});

test('MVP smoke price reconciliation gate fails instead of skipping when live env is missing', () => {
  assert.throws(
    () =>
      finishSkipped(['DATABASE_URL'], {
        APIPOOL_SMOKE_PRICE_RECONCILIATION: 'true',
      }),
    /APIPOOL_SMOKE_PRICE_RECONCILIATION=true/
  );
});

test('MVP smoke price reconciliation uses local usage buckets and immutable price', () => {
  const report = buildSmokePriceReconciliationReport({
    model: 'gpt-4o-mini',
    groupSlug: 'official',
    usage: {
      uncachedInput: 1_000,
      cachedRead: 200,
      cacheWrite5m: 100,
      cacheWrite1h: 50,
      output: 500,
      reasoning: 0,
    },
    price: {
      inputMicroUsdPerM: 1_000_000,
      cachedInputMicroUsdPerM: 500_000,
      cacheWrite5mMicroUsdPerM: 1_250_000,
      cacheWrite1hMicroUsdPerM: 2_000_000,
      outputMicroUsdPerM: 2_000_000,
    },
    actualChargedMicroUsd: 2_325,
    toleranceMicroUsd: 0,
  });

  assert.equal(report.ok, true);
  assert.match(report.detail, /model=gpt-4o-mini/);
  assert.match(report.detail, /groupSlug=official/);
  assert.match(report.detail, /uncachedInputTokens=1000/);
  assert.match(report.detail, /cachedReadTokens=200/);
  assert.match(report.detail, /cacheWrite5mTokens=100/);
  assert.match(report.detail, /cacheWrite1hTokens=50/);
  assert.match(report.detail, /outputTokens=500/);
  assert.match(report.detail, /expectedMicroUsd=2325/);
  assert.match(report.detail, /actualMicroUsd=2325/);
  assert.match(report.detail, /deltaMicroUsd=0/);
  assert.match(report.detail, /toleranceMicroUsd=0/);
  assert.match(report.detail, /source=request_ledger/);
});

test('MVP smoke price reconciliation fails without a settled local charge', () => {
  const report = buildSmokePriceReconciliationReport({
    model: 'gpt-4o-mini',
    groupSlug: 'official',
    usage: {
      uncachedInput: 1_000,
      cachedRead: 0,
      cacheWrite5m: 0,
      cacheWrite1h: 0,
      output: 500,
      reasoning: 0,
    },
    price: {
      inputMicroUsdPerM: 1_000_000,
      cachedInputMicroUsdPerM: 500_000,
      cacheWrite5mMicroUsdPerM: 1_250_000,
      cacheWrite1hMicroUsdPerM: 2_000_000,
      outputMicroUsdPerM: 2_000_000,
    },
    actualChargedMicroUsd: null,
    toleranceMicroUsd: 0,
  });

  assert.equal(report.ok, false);
  assert.match(report.detail, /missing settled charge/);
  assert.match(report.detail, /expectedMicroUsd=2000/);
  assert.match(report.detail, /actualMicroUsd=unavailable/);
  assert.match(report.detail, /toleranceMicroUsd=0/);
});

test('MVP smoke price reconciliation requires confirmed effective catalog price', () => {
  assert.deepEqual(
    resolveSmokeConfirmedEffectivePrice(
      [
        {
          modelId: 'gpt-4o-mini',
          groupSlug: 'official',
          effectiveInputMicroUsd: 1_000_000,
          effectiveOutputMicroUsd: 2_000_000,
          pricePresentation: { showPrice: true, showStrikethrough: false },
        } as any,
      ],
      'gpt-4o-mini',
      'official'
    ),
    {
      effectiveInputMicroUsd: 1_000_000,
      effectiveOutputMicroUsd: 2_000_000,
    }
  );

  assert.throws(
    () =>
      resolveSmokeConfirmedEffectivePrice(
        [
          {
            modelId: 'gpt-4o-mini',
            groupSlug: 'official',
            pricePresentation: { showPrice: false, showStrikethrough: false },
          } as any,
        ],
        'gpt-4o-mini',
        'official'
      ),
    /pricing drift\/matched gate not passed/
  );
});

test('runbook documents MVP smoke commands, live gate, and prerequisites', async () => {
  const runbook = await readFile(
    join(process.cwd(), 'docs/07-runbook.md'),
    'utf8'
  );

  assert.match(runbook, /npm run catalog:init/);
  assert.match(runbook, /npm run smoke:mvp/);
  assert.match(runbook, /deploy\/setup-smoke-users\.sh --apply/);
  assert.match(runbook, /deploy\/live-smoke\.sh --no-price-reconciliation/);
  assert.match(runbook, /deploy\/live-smoke\.sh/);
  assert.match(
    runbook,
    /不要把 `DATABASE_URL`、`NEWAPI_ADMIN_TOKEN` 或 smoke 用户 ID 配到 GitHub Actions/
  );
  assert.match(runbook, /request_ledger/);
  assert.match(runbook, /失败不能发布/);
  assert.match(runbook, /APIPOOL_SMOKE_GROUP_SLUG/);
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
