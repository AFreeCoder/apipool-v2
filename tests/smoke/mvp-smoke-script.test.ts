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
    toleranceQuota: 1,
  });
  assert.deepEqual(
    getSmokePriceReconciliationConfig({
      APIPOOL_SMOKE_PRICE_TOLERANCE_QUOTA: 'not-a-number',
    }),
    {
      enabled: false,
      toleranceQuota: 1,
    }
  );
  assert.deepEqual(
    getSmokePriceReconciliationConfig({
      APIPOOL_SMOKE_PRICE_RECONCILIATION: 'true',
      APIPOOL_SMOKE_PRICE_TOLERANCE_QUOTA: '7',
    }),
    {
      enabled: true,
      toleranceQuota: 7,
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

test('MVP smoke price reconciliation reports expected actual delta and tolerance', () => {
  const report = buildSmokePriceReconciliationReport({
    model: 'gpt-4o-mini',
    groupSlug: 'official',
    effectiveInputMicroUsd: 1_000_000,
    effectiveOutputMicroUsd: 2_000_000,
    quotaPerUnit: 500_000,
    toleranceQuota: 1,
    beforeUsage: usageView({
      quotaRemaining: 10_000,
      logs: [{ id: 'old', modelId: 'gpt-4o-mini' }],
    }),
    afterUsage: usageView({
      quotaRemaining: 9_000,
      logs: [
        { id: 'old', modelId: 'gpt-4o-mini' },
        {
          id: 'new',
          modelId: 'gpt-4o-mini',
          inputTokens: 1_000,
          outputTokens: 500,
          spendUsd: 0.002,
        },
      ],
    }),
  });

  assert.equal(report.ok, true);
  assert.match(report.detail, /model=gpt-4o-mini/);
  assert.match(report.detail, /groupSlug=official/);
  assert.match(report.detail, /effectiveInputMicroUsd=1000000/);
  assert.match(report.detail, /effectiveOutputMicroUsd=2000000/);
  assert.match(report.detail, /inputTokens=1000/);
  assert.match(report.detail, /outputTokens=500/);
  assert.match(report.detail, /expectedQuota=1000/);
  assert.match(report.detail, /actualQuota=1000/);
  assert.match(report.detail, /deltaQuota=0/);
  assert.match(report.detail, /toleranceQuota=1/);
  assert.match(report.detail, /source=usage_log/);
});

test('MVP smoke price reconciliation applies New API cache token discounts', () => {
  const report = buildSmokePriceReconciliationReport({
    model: 'gpt-5.5',
    groupSlug: 'discount-1',
    effectiveInputMicroUsd: 5_000_000,
    effectiveOutputMicroUsd: 30_000_000,
    quotaPerUnit: 500_000,
    toleranceQuota: 1,
    beforeUsage: usageView({
      quotaRemaining: 10_000,
      logs: [],
    }),
    afterUsage: usageView({
      quotaRemaining: 7_595,
      logs: [
        {
          id: 'new',
          modelId: 'gpt-5.5',
          inputTokens: 4_388,
          outputTokens: 5,
          cacheTokens: 3_840,
          cacheRatio: 0.1,
          spendUsd: 0.00481,
        },
      ],
    }),
  });

  assert.equal(report.ok, true);
  assert.match(report.detail, /inputTokens=4388/);
  assert.match(report.detail, /cacheTokens=3840/);
  assert.match(report.detail, /cacheRatio=0.1/);
  assert.match(report.detail, /expectedQuota=2405/);
  assert.match(report.detail, /actualQuota=2405/);
  assert.match(report.detail, /deltaQuota=0/);
});

test('MVP smoke price reconciliation applies New API cache creation discounts', () => {
  const report = buildSmokePriceReconciliationReport({
    model: 'gpt-5.5',
    groupSlug: 'discount-1',
    effectiveInputMicroUsd: 1_000_000,
    effectiveOutputMicroUsd: 2_000_000,
    quotaPerUnit: 1_000_000,
    toleranceQuota: 1,
    beforeUsage: usageView({
      quotaRemaining: 10_000,
      logs: [],
    }),
    afterUsage: usageView({
      quotaRemaining: 8_980,
      logs: [
        {
          id: 'new',
          modelId: 'gpt-5.5',
          inputTokens: 1_000,
          outputTokens: 10,
          cacheTokens: 100,
          cacheRatio: 0.5,
          cacheCreationTokens: 200,
          cacheCreationRatio: 1.25,
          usageSemantic: 'openai',
          spendUsd: 0.00102,
        },
      ],
    }),
  });

  assert.equal(report.ok, true);
  assert.match(report.detail, /inputTokens=1000/);
  assert.match(report.detail, /cacheTokens=100/);
  assert.match(report.detail, /cacheCreationTokens=200/);
  assert.match(report.detail, /expectedQuota=1020/);
  assert.match(report.detail, /actualQuota=1020/);
  assert.match(report.detail, /deltaQuota=0/);
});

test('MVP smoke price reconciliation applies Anthropic cache creation semantics', () => {
  const report = buildSmokePriceReconciliationReport({
    model: 'claude-sonnet-4',
    groupSlug: 'discount-1',
    effectiveInputMicroUsd: 1_000_000,
    effectiveOutputMicroUsd: 2_000_000,
    quotaPerUnit: 1_000_000,
    toleranceQuota: 1,
    beforeUsage: usageView({
      quotaRemaining: 10_000,
      logs: [],
    }),
    afterUsage: usageView({
      quotaRemaining: 8_665,
      logs: [
        {
          id: 'new',
          modelId: 'claude-sonnet-4',
          inputTokens: 50,
          outputTokens: 0,
          cacheCreationTokens: 1_000,
          cacheCreationRatio: 1.25,
          cacheCreationTokens5m: 100,
          cacheCreationRatio5m: 1.1,
          cacheCreationTokens1h: 200,
          cacheCreationRatio1h: 1.5,
          usageSemantic: 'anthropic',
          spendUsd: 0.001335,
        },
      ],
    }),
  });

  assert.equal(report.ok, true);
  assert.match(report.detail, /inputTokens=50/);
  assert.match(report.detail, /cacheCreationTokens=1000/);
  assert.match(report.detail, /expectedQuota=1335/);
  assert.match(report.detail, /actualQuota=1335/);
  assert.match(report.detail, /deltaQuota=0/);
});

test('MVP smoke price reconciliation falls back to quota delta when log spend is unavailable', () => {
  const report = buildSmokePriceReconciliationReport({
    model: 'gpt-4o-mini',
    groupSlug: 'official',
    effectiveInputMicroUsd: 1_000_000,
    effectiveOutputMicroUsd: 2_000_000,
    quotaPerUnit: 500_000,
    toleranceQuota: 1,
    beforeUsage: usageView({
      quotaRemaining: 10_000,
      logs: [],
    }),
    afterUsage: usageView({
      quotaRemaining: 9_000,
      logs: [
        {
          id: 'new',
          modelId: 'gpt-4o-mini',
          inputTokens: 1_000,
          outputTokens: 500,
          spendUsd: null,
        },
      ],
    }),
  });

  assert.equal(report.ok, true);
  assert.match(report.detail, /expectedQuota=1000/);
  assert.match(report.detail, /actualQuota=1000/);
  assert.match(report.detail, /actualDelta=1000/);
  assert.match(report.detail, /source=quota_delta/);
});

test('MVP smoke price reconciliation fails without usage spend or quota delta', () => {
  const report = buildSmokePriceReconciliationReport({
    model: 'gpt-4o-mini',
    groupSlug: 'official',
    effectiveInputMicroUsd: 1_000_000,
    effectiveOutputMicroUsd: 2_000_000,
    quotaPerUnit: 500_000,
    toleranceQuota: 1,
    beforeUsage: usageView({ logs: [] }),
    afterUsage: usageView({
      logs: [
        {
          id: 'new',
          modelId: 'gpt-4o-mini',
          inputTokens: 1_000,
          outputTokens: 500,
          spendUsd: null,
        },
      ],
    }),
  });

  assert.equal(report.ok, false);
  assert.match(report.detail, /insufficient actual quota data/);
  assert.match(report.detail, /expectedQuota=1000/);
  assert.match(report.detail, /actualQuota=unavailable/);
  assert.match(report.detail, /toleranceQuota=1/);
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
  assert.match(runbook, /usage log 或 quota delta/);
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

function usageView({
  quotaRemaining,
  logs,
}: {
  quotaRemaining?: number;
  logs: Array<{
    id: string;
    modelId: string;
    inputTokens?: number;
    outputTokens?: number;
    cacheTokens?: number | null;
    cacheRatio?: number | null;
    cacheCreationTokens?: number | null;
    cacheCreationRatio?: number | null;
    cacheCreationTokens5m?: number | null;
    cacheCreationRatio5m?: number | null;
    cacheCreationTokens1h?: number | null;
    cacheCreationRatio1h?: number | null;
    usageSemantic?: string | null;
    spendUsd?: number | null;
  }>;
}) {
  return {
    summary: {
      quotaRemaining,
      requestCount: logs.length,
      inputTokens: logs.reduce((sum, log) => sum + (log.inputTokens ?? 0), 0),
      outputTokens: logs.reduce((sum, log) => sum + (log.outputTokens ?? 0), 0),
      byModel: [],
      status: logs.length > 0 ? 'ready' : 'empty',
    },
    logs: logs.map((log) => ({
      id: log.id,
      keyMasked: 'sk-***',
      modelId: log.modelId,
      status: 'success',
      inputTokens: log.inputTokens ?? 0,
      outputTokens: log.outputTokens ?? 0,
      cacheTokens: log.cacheTokens,
      cacheRatio: log.cacheRatio,
      cacheCreationTokens: log.cacheCreationTokens,
      cacheCreationRatio: log.cacheCreationRatio,
      cacheCreationTokens5m: log.cacheCreationTokens5m,
      cacheCreationRatio5m: log.cacheCreationRatio5m,
      cacheCreationTokens1h: log.cacheCreationTokens1h,
      cacheCreationRatio1h: log.cacheCreationRatio1h,
      usageSemantic: log.usageSemantic,
      spendUsd: log.spendUsd,
      createdAt: new Date(0),
    })),
  } as any;
}
