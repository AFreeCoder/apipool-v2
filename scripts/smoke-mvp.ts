#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { quotaSpendFromEffectivePrice } from '@/features/api-catalog/lib/pricing';
import type { ListingRow } from '@/features/api-catalog/lib/types';
import {
  getCallableListingsByGroupUncached,
  getSmokeTestedCallableModelIdsByGroupUncached,
} from '@/features/api-catalog/server/queries';
import {
  createNewApiClient,
  DEFAULT_QUOTA_PER_UNIT,
} from '@/features/newapi-bridge/server/client';
import {
  adjustPortalQuota,
  createPortalApiKey,
  disablePortalApiKey,
  getPortalUsage,
  type PortalUsageView,
} from '@/features/newapi-bridge/server/portal';

import { APIPOOL_CONFIG } from '@/config/apipool';
import { findUserById } from '@/shared/models/user';
import { hasPermission } from '@/shared/services/rbac';

import {
  assertSmokeIdentity,
  SMOKE_OPERATOR_EMAIL,
  SMOKE_PORTAL_EMAIL,
} from './smoke-identities';

type SmokeStep = {
  name: string;
  ok: boolean;
  detail?: string;
};

type CleanupState = 'disabled' | 'disable_failed';

const steps: SmokeStep[] = [];
const PERMISSIONS = {
  APIPOOL_QUOTA_ADJUST: 'admin.apipool.quota.adjust',
} as const;

const USAGE_VISIBILITY_ATTEMPTS = Number(
  getEnv('APIPOOL_SMOKE_USAGE_ATTEMPTS') || '6'
);
const USAGE_VISIBILITY_DELAY_MS = Number(
  getEnv('APIPOOL_SMOKE_USAGE_DELAY_MS') || '5000'
);
const DEFAULT_PRICE_TOLERANCE_QUOTA = 1;

type ConfirmedSmokeEffectivePrice = {
  effectiveInputMicroUsd: number;
  effectiveOutputMicroUsd: number;
};

type SmokePriceReconciliationReport = {
  ok: boolean;
  detail: string;
};

function record(name: string, ok: boolean, detail?: string) {
  steps.push({ name, ok, detail });
  const status = ok ? 'PASS' : 'FAIL';
  console.log(`[${status}] ${name}${detail ? ` - ${detail}` : ''}`);
}

function getEnv(name: string) {
  const value = process.env[name]?.trim();
  return value && value.length > 0 ? value : undefined;
}

export function getSmokePriceReconciliationConfig(
  env: Record<string, string | undefined> = process.env
) {
  const enabled = env.APIPOOL_SMOKE_PRICE_RECONCILIATION === 'true';
  if (!enabled) {
    return { enabled, toleranceQuota: DEFAULT_PRICE_TOLERANCE_QUOTA };
  }

  const rawTolerance = env.APIPOOL_SMOKE_PRICE_TOLERANCE_QUOTA?.trim();
  const toleranceQuota = rawTolerance
    ? Number(rawTolerance)
    : DEFAULT_PRICE_TOLERANCE_QUOTA;

  if (!Number.isSafeInteger(toleranceQuota) || toleranceQuota < 0) {
    throw new Error(
      'APIPOOL_SMOKE_PRICE_TOLERANCE_QUOTA must be a non-negative integer'
    );
  }

  return { enabled, toleranceQuota };
}

function getSmokeQuotaPerUnit(env: Record<string, string | undefined>) {
  const value = Number(env.NEWAPI_QUOTA_PER_UNIT || DEFAULT_QUOTA_PER_UNIT);
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error('NEWAPI_QUOTA_PER_UNIT must be a positive number');
  }
  return value;
}

function missingRequiredEnv() {
  const required = [
    'DATABASE_URL',
    'NEWAPI_BASE_URL',
    'NEWAPI_ADMIN_TOKEN',
    'APIPOOL_SMOKE_PORTAL_EMAIL',
    'APIPOOL_SMOKE_PORTAL_USER_ID',
    'APIPOOL_SMOKE_OPERATOR_EMAIL',
    'APIPOOL_SMOKE_OPERATOR_USER_ID',
  ];
  return required.filter((name) => !getEnv(name));
}

export function shouldFailSkippedSmoke(
  env: Record<string, string | undefined> = process.env
) {
  return (
    env.APIPOOL_SMOKE_REQUIRE_LIVE === 'true' ||
    env.APIPOOL_SMOKE_PRICE_RECONCILIATION === 'true'
  );
}

export function finishSkipped(
  missing: string[],
  env: Record<string, string | undefined> = process.env
) {
  const message =
    `SKIPPED: live MVP smoke requires ${missing.join(', ')}. ` +
    'Set APIPOOL_SMOKE_REQUIRE_LIVE=true or APIPOOL_SMOKE_PRICE_RECONCILIATION=true to fail instead of skipping.';
  if (shouldFailSkippedSmoke(env)) {
    throw new Error(message);
  }
  console.log(message);
}

function sleep(ms: number) {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getExpectedModelUsage(
  usage: Awaited<ReturnType<typeof getPortalUsage>>,
  expectedModel: string
) {
  return usage.summary.byModel.find(({ modelId }) => modelId === expectedModel);
}

function normalizeCacheTokens(log: PortalUsageView['logs'][number]) {
  const rawCacheTokens = Number(log.cacheTokens ?? 0);
  if (!Number.isFinite(rawCacheTokens) || rawCacheTokens <= 0) return 0;
  return rawCacheTokens;
}

function normalizeTokenCount(value: number | null | undefined) {
  const raw = Number(value ?? 0);
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return raw;
}

function normalizeRatio(value: number | null | undefined) {
  const raw = Number(value ?? 1);
  if (!Number.isFinite(raw) || raw < 0) return 1;
  return raw;
}

function normalizeCacheRatio(log: PortalUsageView['logs'][number]) {
  return normalizeRatio(log.cacheRatio);
}

function usesAnthropicCacheSemantics(log: PortalUsageView['logs'][number]) {
  const semantic = String(log.usageSemantic ?? '').toLowerCase();
  if (semantic === 'anthropic') return true;

  // New API treats legacy Claude-derived OpenAI-format usage with 5m/1h split
  // cache write fields as Anthropic cache semantics even without usage_semantic.
  return (
    normalizeTokenCount(log.cacheCreationTokens5m) > 0 ||
    normalizeTokenCount(log.cacheCreationTokens1h) > 0
  );
}

function normalizeCacheCreation(log: PortalUsageView['logs'][number]) {
  const total = normalizeTokenCount(log.cacheCreationTokens);
  const tokens5m = normalizeTokenCount(log.cacheCreationTokens5m);
  const tokens1h = normalizeTokenCount(log.cacheCreationTokens1h);

  if (!usesAnthropicCacheSemantics(log)) {
    return {
      tokens: total,
      billableTokens: total * normalizeRatio(log.cacheCreationRatio),
      ratios: total > 0 ? [normalizeRatio(log.cacheCreationRatio)] : [],
    };
  }

  const tokens = Math.max(total, tokens5m + tokens1h);
  const defaultTokens = Math.max(0, total - tokens5m - tokens1h);

  return {
    tokens,
    billableTokens:
      defaultTokens * normalizeRatio(log.cacheCreationRatio) +
      tokens5m * normalizeRatio(log.cacheCreationRatio5m) +
      tokens1h * normalizeRatio(log.cacheCreationRatio1h),
    ratios: [
      defaultTokens > 0 ? normalizeRatio(log.cacheCreationRatio) : undefined,
      tokens5m > 0 ? normalizeRatio(log.cacheCreationRatio5m) : undefined,
      tokens1h > 0 ? normalizeRatio(log.cacheCreationRatio1h) : undefined,
    ].filter((ratio): ratio is number => typeof ratio === 'number'),
  };
}

function quotaSpendFromUsageLogs({
  logs,
  effectiveInputMicroUsd,
  effectiveOutputMicroUsd,
  quotaPerUnit,
}: {
  logs: PortalUsageView['logs'];
  effectiveInputMicroUsd: number;
  effectiveOutputMicroUsd: number;
  quotaPerUnit: number;
}) {
  const usd = logs.reduce((sum, log) => {
    const cacheTokens = normalizeCacheTokens(log);
    const cacheRatio = normalizeCacheRatio(log);
    const cacheCreation = normalizeCacheCreation(log);
    const shouldSubtractCache = !usesAnthropicCacheSemantics(log);
    const nonCachedInputTokens =
      log.inputTokens -
      (shouldSubtractCache ? cacheTokens : 0) -
      (shouldSubtractCache ? cacheCreation.tokens : 0);
    const billableInputTokens =
      nonCachedInputTokens +
      cacheTokens * cacheRatio +
      cacheCreation.billableTokens;
    return (
      sum +
      (billableInputTokens * effectiveInputMicroUsd) / 1_000_000 / 1_000_000 +
      (log.outputTokens * effectiveOutputMicroUsd) / 1_000_000 / 1_000_000
    );
  }, 0);
  return Math.round(usd * quotaPerUnit);
}

export function resolveSmokeConfirmedEffectivePrice(
  listings: Array<
    Pick<
      ListingRow,
      | 'modelId'
      | 'groupSlug'
      | 'effectiveInputMicroUsd'
      | 'effectiveOutputMicroUsd'
      | 'pricePresentation'
    >
  >,
  model: string,
  groupSlug: string
): ConfirmedSmokeEffectivePrice {
  const listing = listings.find(
    (row) => row.modelId === model && row.groupSlug === groupSlug
  );

  if (
    !listing?.pricePresentation?.showPrice ||
    typeof listing.effectiveInputMicroUsd !== 'number' ||
    typeof listing.effectiveOutputMicroUsd !== 'number'
  ) {
    throw new Error(
      `Confirmed effective price is missing for ${model}/${groupSlug}; ` +
        'pricing drift/matched gate not passed'
    );
  }

  return {
    effectiveInputMicroUsd: listing.effectiveInputMicroUsd,
    effectiveOutputMicroUsd: listing.effectiveOutputMicroUsd,
  };
}

export function buildSmokePriceReconciliationReport({
  model,
  groupSlug,
  effectiveInputMicroUsd,
  effectiveOutputMicroUsd,
  quotaPerUnit,
  toleranceQuota,
  beforeUsage,
  afterUsage,
}: {
  model: string;
  groupSlug: string;
  effectiveInputMicroUsd: number;
  effectiveOutputMicroUsd: number;
  quotaPerUnit: number;
  toleranceQuota: number;
  beforeUsage?: PortalUsageView;
  afterUsage: PortalUsageView;
}): SmokePriceReconciliationReport {
  const beforeLogIds = new Set(
    (beforeUsage?.logs ?? []).map((log) => log.id)
  );
  const newLogs = afterUsage.logs.filter(
    (log) =>
      log.modelId === model &&
      log.status === 'success' &&
      !beforeLogIds.has(log.id)
  );
  const loggedInputTokens = newLogs.reduce(
    (sum, log) => sum + log.inputTokens,
    0
  );
  const loggedOutputTokens = newLogs.reduce(
    (sum, log) => sum + log.outputTokens,
    0
  );
  const summaryInputDelta = Math.max(
    0,
    afterUsage.summary.inputTokens - (beforeUsage?.summary.inputTokens ?? 0)
  );
  const summaryOutputDelta = Math.max(
    0,
    afterUsage.summary.outputTokens - (beforeUsage?.summary.outputTokens ?? 0)
  );
  const inputTokens = loggedInputTokens || summaryInputDelta;
  const outputTokens = loggedOutputTokens || summaryOutputDelta;
  const loggedCacheTokens = newLogs.reduce(
    (sum, log) => sum + normalizeCacheTokens(log),
    0
  );
  const loggedCacheCreationTokens = newLogs.reduce(
    (sum, log) => sum + normalizeCacheCreation(log).tokens,
    0
  );
  const cacheRatios = [
    ...new Set(
      newLogs
        .filter((log) => normalizeCacheTokens(log) > 0)
        .map((log) => normalizeCacheRatio(log))
    ),
  ];
  const cacheRatioLabel =
    cacheRatios.length === 0
      ? 'none'
      : cacheRatios.length === 1
        ? String(cacheRatios[0])
        : 'mixed';
  const cacheCreationRatios = [
    ...new Set(
      newLogs.flatMap((log) =>
        normalizeCacheCreation(log).tokens > 0
          ? normalizeCacheCreation(log).ratios
          : []
      )
    ),
  ];
  const cacheCreationRatioLabel =
    cacheCreationRatios.length === 0
      ? 'none'
      : cacheCreationRatios.length === 1
        ? String(cacheCreationRatios[0])
        : 'mixed';
  const expectedQuota =
    newLogs.length > 0
      ? quotaSpendFromUsageLogs({
          logs: newLogs,
          effectiveInputMicroUsd,
          effectiveOutputMicroUsd,
          quotaPerUnit,
        })
      : inputTokens + outputTokens > 0
        ? quotaSpendFromEffectivePrice({
            inputTokens,
            outputTokens,
            effectiveInputMicroUsd,
            effectiveOutputMicroUsd,
            quotaPerUnit,
          })
        : undefined;

  const allNewLogsHaveSpend =
    newLogs.length > 0 &&
    newLogs.every((log) => Number.isFinite(log.spendUsd));
  const actualFromUsageLog = allNewLogsHaveSpend
    ? Math.round(
        newLogs.reduce((sum, log) => sum + (log.spendUsd ?? 0), 0) *
          quotaPerUnit
      )
    : undefined;
  const beforeQuota = beforeUsage?.summary.quotaRemaining;
  const afterQuota = afterUsage.summary.quotaRemaining;
  const actualFromQuotaDelta =
    typeof beforeQuota === 'number' && typeof afterQuota === 'number'
      ? beforeQuota - afterQuota
      : undefined;
  const actualQuota = actualFromUsageLog ?? actualFromQuotaDelta;
  const source = actualFromUsageLog !== undefined ? 'usage_log' : 'quota_delta';
  const deltaQuota =
    expectedQuota !== undefined && actualQuota !== undefined
      ? Math.abs(expectedQuota - actualQuota)
      : undefined;
  const ok =
    expectedQuota !== undefined &&
    actualQuota !== undefined &&
    deltaQuota !== undefined &&
    deltaQuota <= toleranceQuota;
  const reason =
    expectedQuota === undefined
      ? 'insufficient token data'
      : actualQuota === undefined
        ? 'insufficient actual quota data'
        : ok
          ? 'matched'
          : 'quota delta exceeds tolerance';
  const detail = [
    `model=${model}`,
    `groupSlug=${groupSlug}`,
    `effectiveInputMicroUsd=${effectiveInputMicroUsd}`,
    `effectiveOutputMicroUsd=${effectiveOutputMicroUsd}`,
    `inputTokens=${inputTokens}`,
    `outputTokens=${outputTokens}`,
    `cacheTokens=${loggedCacheTokens}`,
    `cacheRatio=${cacheRatioLabel}`,
    `cacheCreationTokens=${loggedCacheCreationTokens}`,
    `cacheCreationRatio=${cacheCreationRatioLabel}`,
    `expectedQuota=${expectedQuota ?? 'unavailable'}`,
    `actualQuota=${actualQuota ?? 'unavailable'}`,
    `actualDelta=${source === 'quota_delta' ? (actualQuota ?? 'unavailable') : 'n/a'}`,
    `deltaQuota=${deltaQuota ?? 'unavailable'}`,
    `toleranceQuota=${toleranceQuota}`,
    `source=${actualQuota === undefined ? 'unavailable' : source}`,
    `result=${reason}`,
  ].join(', ');

  return { ok, detail };
}

function hasVisibleUsage(
  usage: Awaited<ReturnType<typeof getPortalUsage>>,
  expectedModel: string
) {
  const modelUsage = getExpectedModelUsage(usage, expectedModel);

  return (
    usage.summary.status !== 'failed' &&
    usage.summary.requestCount > 0 &&
    usage.summary.inputTokens + usage.summary.outputTokens > 0 &&
    usage.logs.length > 0 &&
    modelUsage !== undefined &&
    modelUsage.requests > 0 &&
    modelUsage.tokens > 0
  );
}

export function isDisabledKeyRejected(call: { ok: boolean; status: number }) {
  return !call.ok && call.status >= 400;
}

export function parseLaunchModelAssistantText(body: string) {
  try {
    const payload = JSON.parse(body);
    const content = payload?.choices?.[0]?.message?.content;
    return typeof content === 'string' && content.trim().length > 0
      ? content.trim()
      : undefined;
  } catch {
    return undefined;
  }
}

export function resolveSmokeLaunchModel(
  requestedModel?: string,
  smokeTestedCallableModelIds: string[] = [],
  configuredDefault = APIPOOL_CONFIG.defaultLaunchModel,
  callableModelIds: string[] = smokeTestedCallableModelIds
) {
  if (requestedModel) {
    if (!callableModelIds.includes(requestedModel)) {
      throw new Error(
        `APIPOOL_SMOKE_MODEL must be callable in the smoke group: ${requestedModel}`
      );
    }

    return requestedModel;
  }

  if (smokeTestedCallableModelIds.length === 0) {
    throw new Error(
      'No smoke-tested callable model is configured for MVP smoke'
    );
  }

  return smokeTestedCallableModelIds.includes(configuredDefault)
    ? configuredDefault
    : smokeTestedCallableModelIds[0];
}

export function assertHealthyNewApi(health: {
  ok: boolean;
  status?: number | string;
  version?: string;
}) {
  if (health.ok) {
    return;
  }

  throw new Error(
    `New API health check failed: ${
      [health.status, health.version].filter(Boolean).join(' ') || 'unhealthy'
    }`
  );
}

export function buildCleanupStateDetail({
  keyId,
  state,
  errorMessage,
}: {
  keyId: string;
  state: CleanupState;
  errorMessage?: string;
}) {
  if (state === 'disabled') {
    return `key ${keyId} is disabled and can be deleted from the dashboard if a fully clean state is required`;
  }

  return [
    `key ${keyId} could not be disabled automatically`,
    'manual cleanup required',
    errorMessage,
  ]
    .filter(Boolean)
    .join('; ');
}

async function waitForUsageVisibility(
  user: Awaited<ReturnType<typeof findUserById>>,
  expectedModel: string
) {
  if (!user) {
    throw new Error('Portal user is required for usage visibility check');
  }

  let lastUsage: Awaited<ReturnType<typeof getPortalUsage>> | undefined;
  for (let attempt = 1; attempt <= USAGE_VISIBILITY_ATTEMPTS; attempt += 1) {
    const usage = await getPortalUsage(user, '7d');
    lastUsage = usage;
    if (hasVisibleUsage(usage, expectedModel)) {
      return usage;
    }

    if (attempt < USAGE_VISIBILITY_ATTEMPTS) {
      await sleep(USAGE_VISIBILITY_DELAY_MS);
    }
  }

  const summary = lastUsage?.summary;
  throw new Error(
    'Usage visibility smoke failed: ' +
      `status=${summary?.status ?? 'unknown'}, ` +
      `requests=${summary?.requestCount ?? 0}, ` +
      `tokens=${(summary?.inputTokens ?? 0) + (summary?.outputTokens ?? 0)}, ` +
      `logs=${lastUsage?.logs.length ?? 0}, ` +
      `byModel=${JSON.stringify(summary?.byModel ?? [])}`
  );
}

async function callLaunchModel({
  apiKey,
  model,
}: {
  apiKey: string;
  model: string;
}) {
  const response = await fetch(
    `${APIPOOL_CONFIG.apiBaseUrl}/v1/chat/completions`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: 'user',
            content: 'Reply with the single word pong.',
          },
        ],
        temperature: 0,
        max_tokens: 8,
      }),
    }
  );

  const text = await response.text();
  const assistantText = parseLaunchModelAssistantText(text);
  return {
    ok: response.ok && Boolean(assistantText),
    status: response.status,
    assistantText,
    body: text.slice(0, 500),
  };
}

export async function main() {
  const priceReconciliation = getSmokePriceReconciliationConfig();
  const missing = missingRequiredEnv();
  if (missing.length > 0) {
    finishSkipped(missing);
    return;
  }

  const portalUserId = getEnv('APIPOOL_SMOKE_PORTAL_USER_ID')!;
  const operatorUserId = getEnv('APIPOOL_SMOKE_OPERATOR_USER_ID')!;
  const amountUsd = Number(getEnv('APIPOOL_SMOKE_QUOTA_USD') || '1');
  const smokeGroupSlug = getEnv('APIPOOL_SMOKE_GROUP_SLUG') || 'official';
  const quotaPerUnit = priceReconciliation.enabled
    ? getSmokeQuotaPerUnit(process.env)
    : DEFAULT_QUOTA_PER_UNIT;
  const callableListings =
    await getCallableListingsByGroupUncached(smokeGroupSlug);
  const callableModelIds = [
    ...new Set(callableListings.map((listing) => listing.modelId)),
  ];
  const smokeTestedModelIds =
    await getSmokeTestedCallableModelIdsByGroupUncached(smokeGroupSlug);
  const model = resolveSmokeLaunchModel(
    getEnv('APIPOOL_SMOKE_MODEL'),
    smokeTestedModelIds,
    APIPOOL_CONFIG.defaultLaunchModel,
    callableModelIds
  );

  if (!Number.isFinite(amountUsd) || amountUsd <= 0) {
    throw new Error('APIPOOL_SMOKE_QUOTA_USD must be a positive number');
  }

  const smokeEffectivePrice = priceReconciliation.enabled
    ? resolveSmokeConfirmedEffectivePrice(
        callableListings,
        model,
        smokeGroupSlug
      )
    : undefined;
  if (smokeEffectivePrice) {
    record(
      'load confirmed model price',
      true,
      `model=${model}, groupSlug=${smokeGroupSlug}, ` +
        `effectiveInputMicroUsd=${smokeEffectivePrice.effectiveInputMicroUsd}, ` +
        `effectiveOutputMicroUsd=${smokeEffectivePrice.effectiveOutputMicroUsd}`
    );
  }

  const health = await createNewApiClient().healthCheck();
  record(
    'check New API health',
    health.ok,
    [health.status, health.version].filter(Boolean).join(' ') || 'ready'
  );
  assertHealthyNewApi(health);

  const user = await findUserById(portalUserId);
  if (!user) {
    throw new Error(`Portal user not found: ${portalUserId}`);
  }
  assertSmokeIdentity({
    actualEmail: user.email,
    configuredEmail: getEnv('APIPOOL_SMOKE_PORTAL_EMAIL'),
    expectedEmail: SMOKE_PORTAL_EMAIL,
    role: 'portal',
  });
  record('load portal user', true, user.email);

  const operator = await findUserById(operatorUserId);
  if (!operator) {
    throw new Error(`Operator user not found: ${operatorUserId}`);
  }
  assertSmokeIdentity({
    actualEmail: operator.email,
    configuredEmail: getEnv('APIPOOL_SMOKE_OPERATOR_EMAIL'),
    expectedEmail: SMOKE_OPERATOR_EMAIL,
    role: 'operator',
  });
  const operatorCanAdjust = await hasPermission(
    operator.id,
    PERMISSIONS.APIPOOL_QUOTA_ADJUST
  );
  record('load quota operator', operatorCanAdjust, operator.email);
  if (!operatorCanAdjust) {
    throw new Error(
      `Operator user lacks ${PERMISSIONS.APIPOOL_QUOTA_ADJUST}: ${operatorUserId}`
    );
  }

  let keyId: string | undefined;
  let plainKey: string | undefined;

  try {
    // The smoke group must align its catalog_group.newapiGroup with an external
    // New API group that has callable channels and abilities.
    const created = await createPortalApiKey(user, {
      name: `MVP smoke ${new Date().toISOString()}`,
      groupSlug: smokeGroupSlug,
    });
    keyId = created.binding.id;
    plainKey = created.plainKey;
    record('create real API key', !!plainKey, created.binding.keyMasked);

    if (!plainKey) {
      throw new Error('Remote key creation did not return a plaintext key');
    }

    const adjusted = await adjustPortalQuota({
      portalUser: user,
      operatorUserId,
      amountUsd,
      reason: 'MVP smoke test quota adjustment',
    });
    record(
      'manual quota adjustment',
      adjusted.status === 'applied',
      adjusted.status
    );
    if (adjusted.status !== 'applied') {
      throw new Error('Quota adjustment was not applied');
    }

    const priceBaselineUsage = priceReconciliation.enabled
      ? await getPortalUsage(user, '7d')
      : undefined;

    const firstCall = await callLaunchModel({ apiKey: plainKey, model });
    record(
      'call launch model',
      firstCall.ok,
      `HTTP ${firstCall.status}${
        firstCall.ok
          ? ` ${firstCall.assistantText}`
          : ` ${firstCall.assistantText ? '' : 'no assistant content'} ${firstCall.body}`
      }`
    );
    if (!firstCall.ok) {
      throw new Error('Launch model smoke call failed');
    }

    const usage = await waitForUsageVisibility(user, model);
    const modelUsage = getExpectedModelUsage(usage, model);
    record(
      'sync usage summary',
      true,
      `${usage.summary.requestCount} requests, ${
        usage.summary.inputTokens + usage.summary.outputTokens
      } tokens, ${usage.logs.length} logs, ${modelUsage?.modelId} model distribution`
    );

    if (priceReconciliation.enabled && smokeEffectivePrice) {
      const report = buildSmokePriceReconciliationReport({
        model,
        groupSlug: smokeGroupSlug,
        effectiveInputMicroUsd: smokeEffectivePrice.effectiveInputMicroUsd,
        effectiveOutputMicroUsd: smokeEffectivePrice.effectiveOutputMicroUsd,
        quotaPerUnit,
        toleranceQuota: priceReconciliation.toleranceQuota,
        beforeUsage: priceBaselineUsage,
        afterUsage: usage,
      });
      record('reconcile smoke price', report.ok, report.detail);
      if (!report.ok) {
        throw new Error(`Smoke price reconciliation failed: ${report.detail}`);
      }
    }

    if (!keyId) {
      throw new Error('Created key id is missing before disable step');
    }
    await disablePortalApiKey(user.id, keyId);
    record('disable API key', true);

    const disabledCall = await callLaunchModel({ apiKey: plainKey, model });
    const disabledRejected = isDisabledKeyRejected(disabledCall);
    record(
      'disabled key is rejected',
      disabledRejected,
      `HTTP ${disabledCall.status}`
    );
    if (!disabledRejected) {
      throw new Error('Disabled key still succeeded');
    }
    record(
      'cleanup state',
      true,
      buildCleanupStateDetail({ keyId, state: 'disabled' })
    );
  } catch (error) {
    if (keyId) {
      try {
        await disablePortalApiKey(user.id, keyId);
        record(
          'cleanup state',
          true,
          buildCleanupStateDetail({ keyId, state: 'disabled' })
        );
      } catch (cleanupError: any) {
        record(
          'cleanup state',
          false,
          buildCleanupStateDetail({
            keyId,
            state: 'disable_failed',
            errorMessage: cleanupError?.message || 'cleanup failed',
          })
        );
      }
    }
    throw error;
  } finally {
    const failed = steps.filter((step) => !step.ok);
    console.log(
      `MVP smoke result: ${steps.length - failed.length}/${steps.length} passed`
    );
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(error?.message || error);
    process.exit(1);
  });
}
