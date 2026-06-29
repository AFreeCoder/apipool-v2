#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { getSmokeTestedCallableModelIdsByGroupUncached } from '@/features/api-catalog/server/queries';
import { createNewApiClient } from '@/features/newapi-bridge/server/client';
import {
  adjustPortalQuota,
  createPortalApiKey,
  disablePortalApiKey,
  getPortalUsage,
} from '@/features/newapi-bridge/server/portal';

import { APIPOOL_CONFIG } from '@/config/apipool';
import { findUserById } from '@/shared/models/user';
import { hasPermission } from '@/shared/services/rbac';

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

function record(name: string, ok: boolean, detail?: string) {
  steps.push({ name, ok, detail });
  const status = ok ? 'PASS' : 'FAIL';
  console.log(`[${status}] ${name}${detail ? ` - ${detail}` : ''}`);
}

function getEnv(name: string) {
  const value = process.env[name]?.trim();
  return value && value.length > 0 ? value : undefined;
}

function missingRequiredEnv() {
  const required = [
    'DATABASE_URL',
    'NEWAPI_BASE_URL',
    'NEWAPI_ADMIN_TOKEN',
    'APIPOOL_SMOKE_PORTAL_USER_ID',
    'APIPOOL_SMOKE_OPERATOR_USER_ID',
  ];
  return required.filter((name) => !getEnv(name));
}

function finishSkipped(missing: string[]) {
  const message =
    `SKIPPED: live MVP smoke requires ${missing.join(', ')}. ` +
    'Set APIPOOL_SMOKE_REQUIRE_LIVE=true to fail instead of skipping.';
  if (process.env.APIPOOL_SMOKE_REQUIRE_LIVE === 'true') {
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
  configuredDefault = APIPOOL_CONFIG.defaultLaunchModel
) {
  if (smokeTestedCallableModelIds.length === 0) {
    throw new Error(
      'No smoke-tested callable model is configured for MVP smoke'
    );
  }

  if (!requestedModel) {
    return smokeTestedCallableModelIds.includes(configuredDefault)
      ? configuredDefault
      : smokeTestedCallableModelIds[0];
  }

  if (!smokeTestedCallableModelIds.includes(requestedModel)) {
    throw new Error(
      `APIPOOL_SMOKE_MODEL must be a smoke-tested callable model: ${requestedModel}`
    );
  }

  return requestedModel;
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

async function main() {
  const missing = missingRequiredEnv();
  if (missing.length > 0) {
    finishSkipped(missing);
    return;
  }

  const portalUserId = getEnv('APIPOOL_SMOKE_PORTAL_USER_ID')!;
  const operatorUserId = getEnv('APIPOOL_SMOKE_OPERATOR_USER_ID')!;
  const amountUsd = Number(getEnv('APIPOOL_SMOKE_QUOTA_USD') || '1');
  const smokeGroupSlug = 'official';
  const smokeTestedModelIds =
    await getSmokeTestedCallableModelIdsByGroupUncached(smokeGroupSlug);
  const model = resolveSmokeLaunchModel(
    getEnv('APIPOOL_SMOKE_MODEL'),
    smokeTestedModelIds
  );

  if (!Number.isFinite(amountUsd) || amountUsd <= 0) {
    throw new Error('APIPOOL_SMOKE_QUOTA_USD must be a positive number');
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
  record('load portal user', true, user.email);

  const operator = await findUserById(operatorUserId);
  if (!operator) {
    throw new Error(`Operator user not found: ${operatorUserId}`);
  }
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
    // groupSlug='official' maps to the seed group; live New API smoke must align
    // that group's newapiGroup with the external New API group per DESIGN §9.1.
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
