#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import type { ListingRow } from '@/features/api-catalog/lib/types';
import {
  getCallableListingsByGroupUncached,
  getCallableModelIdsByGroupUncached,
} from '@/features/api-catalog/server/queries';
import {
  computeChargeMicroUsd,
  type PriceVector,
  type UsageBuckets,
} from '@/features/gateway/lib/billing';
import { createNewApiClient } from '@/features/newapi-bridge/server/client';
import {
  createPortalApiKey,
  disablePortalApiKey,
} from '@/features/newapi-bridge/server/portal';
import { applyManualAdjustment } from '@/features/wallet/server/ledger';
import { and, desc, eq } from 'drizzle-orm';

import { db } from '@/core/db';
import { APIPOOL_CONFIG } from '@/config/apipool';
import { modelPriceVersion, requestLedger } from '@/config/db/schema';
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
const DEFAULT_PRICE_TOLERANCE_MICRO_USD = 0;

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
    return {
      enabled,
      toleranceMicroUsd: DEFAULT_PRICE_TOLERANCE_MICRO_USD,
    };
  }

  const rawTolerance = env.APIPOOL_SMOKE_PRICE_TOLERANCE_QUOTA?.trim();
  const toleranceMicroUsd = rawTolerance
    ? Number(rawTolerance)
    : DEFAULT_PRICE_TOLERANCE_MICRO_USD;

  if (!Number.isSafeInteger(toleranceMicroUsd) || toleranceMicroUsd < 0) {
    throw new Error(
      'APIPOOL_SMOKE_PRICE_TOLERANCE_QUOTA must be a non-negative integer'
    );
  }

  return { enabled, toleranceMicroUsd };
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
  usage,
  price,
  actualChargedMicroUsd,
  toleranceMicroUsd,
}: {
  model: string;
  groupSlug: string;
  usage: UsageBuckets;
  price: PriceVector;
  actualChargedMicroUsd: number | null;
  toleranceMicroUsd: number;
}): SmokePriceReconciliationReport {
  const expectedMicroUsd = Number(computeChargeMicroUsd(usage, price));
  const deltaMicroUsd =
    actualChargedMicroUsd === null
      ? undefined
      : Math.abs(expectedMicroUsd - actualChargedMicroUsd);
  const ok = deltaMicroUsd !== undefined && deltaMicroUsd <= toleranceMicroUsd;
  const reason =
    actualChargedMicroUsd === null
      ? 'missing settled charge'
      : ok
        ? 'matched'
        : 'micro-USD delta exceeds tolerance';
  const detail = [
    `model=${model}`,
    `groupSlug=${groupSlug}`,
    `uncachedInputTokens=${usage.uncachedInput}`,
    `cachedReadTokens=${usage.cachedRead}`,
    `cacheWrite5mTokens=${usage.cacheWrite5m}`,
    `cacheWrite1hTokens=${usage.cacheWrite1h}`,
    `outputTokens=${usage.output}`,
    `expectedMicroUsd=${expectedMicroUsd}`,
    `actualMicroUsd=${actualChargedMicroUsd ?? 'unavailable'}`,
    `deltaMicroUsd=${deltaMicroUsd ?? 'unavailable'}`,
    `toleranceMicroUsd=${toleranceMicroUsd}`,
    'source=request_ledger',
    `result=${reason}`,
  ].join(', ');

  return { ok, detail };
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
  catalogCallableModelIds: string[] = [],
  configuredDefault = APIPOOL_CONFIG.defaultLaunchModel,
  callableModelIds: string[] = catalogCallableModelIds
) {
  if (requestedModel) {
    if (!callableModelIds.includes(requestedModel)) {
      throw new Error(
        `APIPOOL_SMOKE_MODEL must be callable in the smoke group: ${requestedModel}`
      );
    }

    return requestedModel;
  }

  if (catalogCallableModelIds.length === 0) {
    throw new Error('No callable model is configured for MVP smoke');
  }

  return catalogCallableModelIds.includes(configuredDefault)
    ? configuredDefault
    : catalogCallableModelIds[0];
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
  portalKeyId: string,
  expectedModel: string
) {
  let lastUsage: typeof requestLedger.$inferSelect | undefined;
  for (let attempt = 1; attempt <= USAGE_VISIBILITY_ATTEMPTS; attempt += 1) {
    const [usage] = await db()
      .select()
      .from(requestLedger)
      .where(
        and(
          eq(requestLedger.portalKeyId, portalKeyId),
          eq(requestLedger.portalModelId, expectedModel)
        )
      )
      .orderBy(desc(requestLedger.createdAt))
      .limit(1);
    lastUsage = usage;
    if (
      usage?.status === 'settled' &&
      usage.newapiRequestId &&
      usage.chargedMicroUsd !== null
    ) {
      return usage;
    }
    if (usage && !['open', 'pending_backfill'].includes(usage.status)) {
      throw new Error(
        `Usage visibility smoke failed: request=${usage.id}, ` +
          `status=${usage.status}, newapiRequestId=${usage.newapiRequestId ?? 'missing'}`
      );
    }

    if (attempt < USAGE_VISIBILITY_ATTEMPTS) {
      await sleep(USAGE_VISIBILITY_DELAY_MS);
    }
  }

  throw new Error(
    'Usage visibility smoke failed: ' +
      `request=${lastUsage?.id ?? 'missing'}, ` +
      `status=${lastUsage?.status ?? 'missing'}, ` +
      `newapiRequestId=${lastUsage?.newapiRequestId ?? 'missing'}, ` +
      `chargedMicroUsd=${lastUsage?.chargedMicroUsd ?? 'missing'}`
  );
}

async function callLaunchModel({
  apiKey,
  model,
}: {
  apiKey: string;
  model: string;
}) {
  const apiV1BaseUrl = (
    getEnv('APIPOOL_SMOKE_GATEWAY_BASE_URL') ||
    `${APIPOOL_CONFIG.apiBaseUrl}/v1`
  ).replace(/\/+$/, '');
  const response = await fetch(`${apiV1BaseUrl}/chat/completions`, {
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
  });

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
  const callableListings =
    await getCallableListingsByGroupUncached(smokeGroupSlug);
  const callableModelIds = [
    ...new Set(callableListings.map((listing) => listing.modelId)),
  ];
  const catalogCallableModelIds =
    await getCallableModelIdsByGroupUncached(smokeGroupSlug);
  const model = resolveSmokeLaunchModel(
    getEnv('APIPOOL_SMOKE_MODEL'),
    catalogCallableModelIds,
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
    // 冒烟分组必须通过 catalog_group.newapiGroup 映射到具备可调用渠道和能力的
    // New API 分组；门户 Key 本身只在 APIPool 保存。
    const created = await createPortalApiKey(user, {
      name: `MVP smoke ${new Date().toISOString()}`,
      groupSlug: smokeGroupSlug,
    });
    keyId = created.binding.id;
    plainKey = created.plainKey;
    record('create real API key', !!plainKey, created.binding.keyMasked);

    if (!plainKey) {
      throw new Error('API key creation did not return a plaintext key');
    }

    const adjusted = await applyManualAdjustment({
      userId: user.id,
      operatorUserId,
      signedAmountMicroUsd: amountUsd * 1_000_000,
      reason: 'MVP smoke test quota adjustment',
      idempotencyKey: `mvp-smoke:${user.id}:${keyId}`,
      audit: {
        action: 'wallet.adjust',
        targetType: 'wallet_account',
        targetId: user.id,
        afterJson: { amountUsd, smokeKeyId: keyId },
      },
    });
    record(
      'manual quota adjustment',
      adjusted.balanceAfterMicroUsd > 0,
      adjusted.alreadyApplied ? 'already applied' : 'applied'
    );
    if (adjusted.balanceAfterMicroUsd <= 0) {
      throw new Error('Quota adjustment was not applied');
    }

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
    if (!keyId) {
      throw new Error('Created key id is missing before usage check');
    }

    const usage = await waitForUsageVisibility(keyId, model);
    const inputTokens =
      (usage.uncachedInputTokens ?? 0) +
      (usage.cachedReadTokens ?? 0) +
      (usage.cacheWrite5mTokens ?? 0) +
      (usage.cacheWrite1hTokens ?? 0);
    record(
      'sync usage summary',
      true,
      `1 request, ${inputTokens + (usage.outputTokens ?? 0)} tokens, ` +
        `${usage.portalModelId} local request ledger`
    );

    if (priceReconciliation.enabled && smokeEffectivePrice) {
      const [price] = await db()
        .select()
        .from(modelPriceVersion)
        .where(eq(modelPriceVersion.id, usage.priceVersionId))
        .limit(1);
      if (!price) {
        throw new Error(
          `Immutable price snapshot is missing: ${usage.priceVersionId}`
        );
      }
      const report = buildSmokePriceReconciliationReport({
        model,
        groupSlug: smokeGroupSlug,
        usage: {
          uncachedInput: usage.uncachedInputTokens ?? 0,
          cachedRead: usage.cachedReadTokens ?? 0,
          cacheWrite5m: usage.cacheWrite5mTokens ?? 0,
          cacheWrite1h: usage.cacheWrite1hTokens ?? 0,
          output: usage.outputTokens ?? 0,
          reasoning: usage.reasoningTokens ?? 0,
        },
        price,
        actualChargedMicroUsd: usage.chargedMicroUsd,
        toleranceMicroUsd: priceReconciliation.toleranceMicroUsd,
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
