import 'server-only';

import { createHash, randomBytes } from 'node:crypto';
import { getGroupBySlug } from '@/features/api-catalog/server/catalog-service';
import { getPublicUsageSyncErrorMessage } from '@/features/api-console/lib/public-errors';
import {
  canCleanupKeyStatus,
  canDeleteKeyStatus,
  canDisableKeyStatus,
  type KeyLifecycleStatus,
} from '@/features/api-console/lib/status';
import {
  AdjustmentLedgerDraft,
  createAdjustmentLedgerDraft,
} from '@/features/apipool-ledger/lib/ledger';
import { and, desc, eq, ne } from 'drizzle-orm';

import { db } from '@/core/db';
import {
  apipoolLedgerEntry,
  catalogGroup,
  newApiBridgeAuditLog,
  newApiKeyBinding,
  newApiUserBinding,
  order as orderTable,
  usageLogSnapshot,
  usageSnapshot,
  user as userTable,
} from '@/config/db/schema';
import { getUuid } from '@/shared/lib/hash';
import { User } from '@/shared/models/user';

import {
  createNewApiClient,
  isQuotaAdjustmentReconciliationError,
  NewApiBridgeError,
  NewApiClient,
  type NewApiBridgeErrorCode,
  type NewApiUserCredentials,
  type RemoteKey,
  type RemoteUsageLog,
} from './client';
import { decryptCredential, encryptCredential } from './crypto';

export type PortalKeyCreateInput = {
  name: string;
  groupSlug: string;
  quotaLimit?: number;
  ipAllowlist?: string[];
};

export type PortalUsageRange = '7d' | '30d' | 'month';

export type PortalUsageView = {
  summary: {
    balanceUsd?: number;
    quotaRemaining?: number;
    requestCount: number;
    inputTokens: number;
    outputTokens: number;
    spendUsd?: number;
    byModel: Array<{
      modelId: string;
      requests: number;
      tokens: number;
      spendUsd?: number;
    }>;
    status: 'ready' | 'empty' | 'syncing' | 'stale' | 'failed';
    syncedAt?: Date | null;
    errorMessage?: string | null;
  };
  logs: Array<{
    id: string;
    keyMasked: string;
    modelId: string;
    status: string;
    inputTokens: number;
    outputTokens: number;
    spendUsd?: number | null;
    createdAt: Date;
  }>;
};

export type BillingLedgerEntry = {
  orderNo: string | null;
  amountUsd: number;
  ledgerStatus: string;
  orderStatus: string | null;
  paymentProvider: string | null;
  paidAt: number | null;
  createdAt: number;
};

type AuditInput = {
  portalUserId?: string;
  operatorUserId?: string;
  action: string;
  targetType: string;
  targetId?: string;
  status: 'success' | 'failed';
  idempotencyKey?: string;
  requestBody?: unknown;
  responseBody?: unknown;
  errorMessage?: string;
};

const TERMINAL_KEY_MUTATION_ERROR_CODES = new Set<NewApiBridgeErrorCode>([
  'unauthorized',
  'forbidden',
  'malformed_response',
]);
const USAGE_SYNC_LOCK_TTL_MS = 60_000;
const DUPLICATE_USAGE_LOG_ID_SEPARATOR = '#apipool-duplicate-';
const UNKNOWN_API_KEY_LABEL = 'API Key';
const DUPLICATE_KEY_NAME_MESSAGE =
  'A key with this name already exists. Delete the existing key or choose another name.';
const ONE_CUSTOMER_KEY_MESSAGE =
  'Each account can create only one API key. Delete the existing key before creating another.';
const CUSTOMER_KEY_SLOT_STATUSES = new Set<KeyLifecycleStatus>([
  'creating_remote',
  'active',
  'remote_created_binding_failed',
  'disable_pending',
  'delete_pending',
  'disabled',
]);

function getUnknownErrorMessage(error: unknown) {
  return error instanceof Error
    ? error.message
    : typeof error === 'string'
      ? error
      : '';
}

function isConstraintErrorFor(error: unknown, expectedNeedles: string[]) {
  const message = getUnknownErrorMessage(error);
  return (
    /constraint|unique|duplicate/i.test(message) &&
    expectedNeedles.some((needle) => message.includes(needle))
  );
}

function isDuplicateKeyNameConstraintError(error: unknown) {
  return isConstraintErrorFor(error, [
    'idx_newapi_key_binding_user_display_name_active',
    'newapi_key_binding.portal_user_id',
    'newapi_key_binding.display_name',
  ]);
}

function isQuotaIdempotencyConstraintError(error: unknown) {
  return isConstraintErrorFor(error, [
    'idx_apipool_ledger_idempotency',
    'apipool_ledger_entry.idempotency_key',
  ]);
}

function getFailedKeyMutationStatus(error: unknown): KeyLifecycleStatus {
  if (
    error instanceof NewApiBridgeError &&
    TERMINAL_KEY_MUTATION_ERROR_CODES.has(error.code)
  ) {
    return 'failed_terminal';
  }

  return 'failed_retriable';
}

function serialize(value: unknown) {
  if (value === undefined) return undefined;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export async function recordAudit(input: AuditInput) {
  await db()
    .insert(newApiBridgeAuditLog)
    .values({
      id: getUuid(),
      portalUserId: input.portalUserId,
      operatorUserId: input.operatorUserId,
      action: input.action,
      targetType: input.targetType,
      targetId: input.targetId,
      status: input.status,
      idempotencyKey: input.idempotencyKey,
      requestBody: serialize(input.requestBody),
      responseBody: serialize(input.responseBody),
      errorMessage: input.errorMessage,
    });
}

function parseJsonArray<T>(value: string | null | undefined): T[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseJsonObject(value: string | null | undefined) {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed
      : {};
  } catch {
    return {};
  }
}

function toPublicApiKey(row: any) {
  return {
    id: row.id,
    keyMasked: row.keyMasked,
    displayName: row.displayName,
    status: row.status,
    allowedModels: parseJsonArray<string>(row.allowedModels),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    lastUsedAt: row.lastUsedAt,
    deletedAt: row.deletedAt,
    groupSlug: row.groupSlug ?? null,
    groupName: row.groupName ?? null,
  };
}

function isPendingRemoteKeyId(remoteKeyId: unknown) {
  return typeof remoteKeyId === 'string' && remoteKeyId.startsWith('pending:');
}

function isLocalFallbackKeyId(remoteKeyId: unknown) {
  return typeof remoteKeyId === 'string' && remoteKeyId.startsWith('local:');
}

function isLocalNewApiBaseUrl(value: string | undefined) {
  if (!value) return false;
  try {
    const { hostname } = new URL(value);
    return (
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname === '::1'
    );
  } catch {
    return false;
  }
}

function occupiesCustomerKeySlot(row: any) {
  const status = row.status as KeyLifecycleStatus;
  if (status === 'deleted' || row.deletedAt) return false;
  if (CUSTOMER_KEY_SLOT_STATUSES.has(status)) return true;

  return status === 'failed_retriable' && !isPendingRemoteKeyId(row.newapiKeyId);
}

function isLocalKeyFallbackEnabled() {
  if (process.env.NODE_ENV === 'production') return false;
  if (process.env.APIPOOL_LOCAL_KEY_FALLBACK_ENABLED === 'false') return false;
  if (process.env.APIPOOL_LOCAL_KEY_FALLBACK_ENABLED === 'true') return true;
  return isLocalNewApiBaseUrl(process.env.NEWAPI_BASE_URL);
}

function maskPortalKey(key: string) {
  if (key.length <= 8) return `${key.slice(0, 2)}****${key.slice(-2)}`;
  return `${key.slice(0, 4)}${'*'.repeat(10)}${key.slice(-4)}`;
}

function createLocalPortalPlainKey() {
  return `sk-local-${randomBytes(24).toString('base64url')}`;
}

function toPublicLedgerEntry(row: any) {
  return {
    id: row.id,
    amountUsd: row.amountUsd,
    source: row.source,
    status: row.status,
    reason: row.reason,
    rollbackStatus: row.rollbackStatus,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toTimestampMs(value: Date | number | string): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  return new Date(value).getTime();
}

function toNullableTimestampMs(
  value: Date | number | string | null | undefined
) {
  if (value === null || value === undefined) return null;
  return toTimestampMs(value);
}

function toPublicUsageLogId(
  requestId: string | null | undefined,
  fallbackId: string
) {
  if (!requestId) return fallbackId;

  const separatorIndex = requestId.lastIndexOf(
    DUPLICATE_USAGE_LOG_ID_SEPARATOR
  );
  if (separatorIndex === -1) return requestId;

  const suffix = requestId.slice(
    separatorIndex + DUPLICATE_USAGE_LOG_ID_SEPARATOR.length
  );
  return /^\d+$/.test(suffix) ? requestId.slice(0, separatorIndex) : requestId;
}

function toPublicUsageLog(row: any) {
  return {
    id: toPublicUsageLogId(row.newapiRequestId, row.id),
    keyMasked: toPublicUsageLogKey(row.keyMasked),
    modelId: row.modelId,
    status: row.status,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    spendUsd: row.spendUsd,
    createdAt:
      row.createdAt instanceof Date ? row.createdAt : new Date(row.createdAt),
  };
}

async function listCachedUsageLogs(portalUserId: string) {
  return db()
    .select()
    .from(usageLogSnapshot)
    .where(eq(usageLogSnapshot.portalUserId, portalUserId))
    .orderBy(desc(usageLogSnapshot.createdAt))
    .limit(20);
}

function isFreshSyncingSnapshot(row: any, now = new Date()) {
  if (!row || row.status !== 'syncing' || !row.updatedAt) return false;
  const updatedAt =
    row.updatedAt instanceof Date ? row.updatedAt : new Date(row.updatedAt);
  return now.getTime() - updatedAt.getTime() <= USAGE_SYNC_LOCK_TTL_MS;
}

function hasUsableUsageSnapshot(row: any) {
  return Boolean(row?.syncedAt);
}

function countRemoteUsageLogIds(logs: RemoteUsageLog[]) {
  const counts = new Map<string, number>();
  for (const log of logs) {
    counts.set(log.id, (counts.get(log.id) ?? 0) + 1);
  }
  return counts;
}

function toUsageLogSnapshotRequestId(
  log: RemoteUsageLog,
  index: number,
  requestIdCounts: Map<string, number>
) {
  if ((requestIdCounts.get(log.id) ?? 0) <= 1) return log.id;
  return `${log.id}${DUPLICATE_USAGE_LOG_ID_SEPARATOR}${index}`;
}

function isInternalRemoteTokenName(value: string) {
  return /^pk_[0-9a-f]{24}$/i.test(value);
}

function toPublicUsageLogKey(value: string) {
  return isInternalRemoteTokenName(value) ? UNKNOWN_API_KEY_LABEL : value;
}

function toPortalUsageLog(
  log: RemoteUsageLog,
  keyMaskByRemoteName: Map<string, string>
) {
  const mappedKeyMask = keyMaskByRemoteName.get(log.keyMasked);

  return {
    id: log.id,
    keyMasked: mappedKeyMask ?? toPublicUsageLogKey(log.keyMasked),
    modelId: log.modelId,
    status: log.status,
    inputTokens: log.inputTokens,
    outputTokens: log.outputTokens,
    spendUsd: log.spendUsd,
    createdAt: new Date(log.createdAt),
  };
}

async function getUsageLogKeyMaskByRemoteName(portalUserId: string) {
  const rows = await db()
    .select({
      id: newApiKeyBinding.id,
      keyMasked: newApiKeyBinding.keyMasked,
    })
    .from(newApiKeyBinding)
    .where(eq(newApiKeyBinding.portalUserId, portalUserId));

  const keyMaskByRemoteName = new Map<string, string>();
  for (const row of rows) {
    if (row.keyMasked && row.keyMasked !== 'pending') {
      keyMaskByRemoteName.set(deriveRemoteKeyName(row.id), row.keyMasked);
    }
  }

  return keyMaskByRemoteName;
}

function toPortalUsageViewFromSnapshot(
  snapshot: any,
  logs: any[],
  status = snapshot.status,
  errorMessage?: string
): PortalUsageView {
  return {
    summary: {
      balanceUsd: snapshot.balanceUsd,
      quotaRemaining: snapshot.quotaRemaining,
      requestCount: snapshot.requestCount,
      inputTokens: snapshot.inputTokens,
      outputTokens: snapshot.outputTokens,
      spendUsd: snapshot.spendUsd,
      byModel: parseJsonArray(snapshot.byModel),
      status,
      syncedAt: snapshot.syncedAt,
      errorMessage,
    },
    logs: logs.map(toPublicUsageLog),
  };
}

function mapRemoteKeyStatus(
  localStatus: KeyLifecycleStatus,
  remoteStatus: RemoteKey['status']
): KeyLifecycleStatus | undefined {
  if (localStatus === 'deleted') return undefined;

  if (remoteStatus === 'revoked') return 'deleted';
  if (localStatus === 'delete_pending') return undefined;
  if (remoteStatus === 'disabled') return 'disabled';

  if (
    remoteStatus === 'active' &&
    localStatus !== 'disable_pending' &&
    localStatus !== 'remote_created_binding_failed'
  ) {
    return 'active';
  }

  return undefined;
}

export async function getPortalUserBinding(portalUserId: string) {
  const [binding] = await db()
    .select()
    .from(newApiUserBinding)
    .where(eq(newApiUserBinding.portalUserId, portalUserId))
    .limit(1);

  return binding;
}

// 远端 token 名称上限 30 字符，用本地 keyId 压缩出唯一技术名，
// 兼作门户侧幂等键（client.createKey 先查同名 token 再创建）
function deriveRemoteKeyName(localKeyId: string) {
  return `pk_${localKeyId.replace(/-/g, '').slice(0, 24)}`;
}

function deriveNewapiUsername(portalUserId: string) {
  const digest = createHash('sha256').update(portalUserId).digest('hex');
  return `pu_${digest.slice(0, 16)}`;
}

function generateNewapiPassword() {
  // New API 密码校验 8-20 字符；15 字节 base64url 恰为 20 字符
  return randomBytes(15).toString('base64url');
}

export function bindingToUserCredentials(binding: {
  newapiUserId: string;
  newapiAccessTokenEnc?: string | null;
}): NewApiUserCredentials {
  if (!binding.newapiAccessTokenEnc) {
    throw new NewApiBridgeError({
      code: 'not_configured',
      message: 'New API user binding has no stored access token',
    });
  }
  return {
    newapiUserId: binding.newapiUserId,
    accessToken: decryptCredential(binding.newapiAccessTokenEnc),
  };
}

export async function ensurePortalUserBinding(
  user: Pick<User, 'id' | 'email'>,
  client: NewApiClient = createNewApiClient(),
  options: { requiredNewapiGroup?: string } = {}
) {
  const existing = await getPortalUserBinding(user.id);
  const username = existing?.newapiUsername || deriveNewapiUsername(user.id);
  if (
    existing &&
    existing.status === 'active' &&
    existing.newapiAccessTokenEnc
  ) {
    if (options.requiredNewapiGroup) {
      await client.ensureUserGroup({
        newapiUserId: existing.newapiUserId,
        username,
        group: options.requiredNewapiGroup,
      });
    }
    return existing;
  }

  const idempotencyKey = `portal-user:${user.id}`;
  const password = existing?.newapiPasswordEnc
    ? decryptCredential(existing.newapiPasswordEnc)
    : generateNewapiPassword();

  // 凭据先行落库：远端供给中途失败时，重试能用同一套用户名/密码恢复
  // （provisionUser 对已存在的远端用户是幂等的）
  let row = existing;
  if (existing) {
    const [updated] = await db()
      .update(newApiUserBinding)
      .set({
        newapiUsername: username,
        newapiPasswordEnc: encryptCredential(password),
        status: 'pending',
      })
      .where(eq(newApiUserBinding.id, existing.id))
      .returning();
    row = updated;
  } else {
    const [created] = await db()
      .insert(newApiUserBinding)
      .values({
        id: getUuid(),
        portalUserId: user.id,
        newapiUserId: `pending:${getUuid()}`,
        status: 'pending',
        newapiUsername: username,
        newapiPasswordEnc: encryptCredential(password),
      })
      .returning();
    row = created;
  }

  try {
    const remote = await client.provisionUser({
      username,
      password,
      displayName: username,
      group: options.requiredNewapiGroup,
    });

    const [bound] = await db()
      .update(newApiUserBinding)
      .set({
        newapiUserId: remote.newapiUserId,
        newapiAccessTokenEnc: encryptCredential(remote.accessToken),
        status: 'active',
      })
      .where(eq(newApiUserBinding.id, row.id))
      .returning();

    await recordAudit({
      portalUserId: user.id,
      action: 'newapi.user.bind',
      targetType: 'newapi_user',
      targetId: remote.newapiUserId,
      status: 'success',
      idempotencyKey,
      // 审计绝不落凭据，只记用户名与远端 ID
      responseBody: { username, newapiUserId: remote.newapiUserId },
    });
    return bound;
  } catch (error: any) {
    await recordAudit({
      portalUserId: user.id,
      action: 'newapi.user.bind',
      targetType: 'newapi_user',
      status: 'failed',
      idempotencyKey,
      requestBody: { username },
      errorMessage: error?.message || 'bind failed',
    });
    throw error;
  }
}

async function createLocalFallbackPortalApiKey({
  user,
  input,
  group,
  newapiGroup,
  newapiUserId,
  idempotencyKey,
  localKeyId = getUuid(),
  error,
}: {
  user: Pick<User, 'id' | 'email'>;
  input: PortalKeyCreateInput;
  group: any;
  newapiGroup: string;
  newapiUserId?: string;
  idempotencyKey: string;
  localKeyId?: string;
  error?: unknown;
}) {
  const plainKey = createLocalPortalPlainKey();
  const [created] = await db()
    .insert(newApiKeyBinding)
    .values({
      id: localKeyId,
      portalUserId: user.id,
      newapiUserId: newapiUserId || `local:${user.id}`,
      newapiKeyId: `local:${localKeyId}`,
      keyMasked: maskPortalKey(plainKey),
      displayName: input.name,
      status: 'active',
      allowedModels: '[]',
      groupId: group.id,
      newapiGroup,
      quotaLimit: input.quotaLimit,
      ipAllowlist: JSON.stringify(input.ipAllowlist || []),
      idempotencyKey,
      lastRemoteError: getUnknownErrorMessage(error) || null,
    })
    .returning();

  await recordAudit({
    portalUserId: user.id,
    action: 'portal.key.create.local_fallback',
    targetType: 'portal_key',
    targetId: created.id,
    status: 'success',
    idempotencyKey,
    requestBody: input,
    responseBody: {
      localFallback: true,
      remoteError: getUnknownErrorMessage(error) || undefined,
    },
  });

  return {
    binding: toPublicApiKey({
      ...created,
      groupSlug: group.slug,
      groupName: group.name,
    }),
    plainKey,
  };
}

export async function createPortalApiKey(
  user: Pick<User, 'id' | 'email'>,
  input: PortalKeyCreateInput,
  client: NewApiClient = createNewApiClient()
) {
  const group = await getGroupBySlug(input.groupSlug);
  if (!group || group.status !== 'active' || group.allowCreateKey !== true) {
    throw new Error('group not available');
  }
  const newapiGroup = group.newapiGroup.trim();
  if (!newapiGroup) {
    throw new Error('group not available');
  }

  // 同名校验：同一用户下不允许重复的未删除 Key 名（清理失败 / 旧 Key 后可复用同名）。
  // 用普通 Error 且不嵌入用户输入的 name，确保提示透传给前端而非被兜底成内部错误。
  const [duplicateName] = await db()
    .select({ id: newApiKeyBinding.id })
    .from(newApiKeyBinding)
    .where(
      and(
        eq(newApiKeyBinding.portalUserId, user.id),
        eq(newApiKeyBinding.displayName, input.name),
        ne(newApiKeyBinding.status, 'deleted')
      )
    )
    .limit(1);
  if (duplicateName) {
    throw new Error(DUPLICATE_KEY_NAME_MESSAGE);
  }

  const localExistingRows = await db()
    .select()
    .from(newApiKeyBinding)
    .where(eq(newApiKeyBinding.portalUserId, user.id));
  const localExistingKey = localExistingRows.find(occupiesCustomerKeySlot);
  if (localExistingKey) {
    throw new Error(ONE_CUSTOMER_KEY_MESSAGE);
  }

  const idempotencyKey = `portal-key:${user.id}:${getUuid()}`;
  const localKeyId = getUuid();
  let binding: Awaited<ReturnType<typeof ensurePortalUserBinding>>;
  try {
    binding = await ensurePortalUserBinding(user, client, {
      requiredNewapiGroup: newapiGroup,
    });
  } catch (error) {
    if (isLocalKeyFallbackEnabled()) {
      return createLocalFallbackPortalApiKey({
        user,
        input,
        group,
        newapiGroup,
        idempotencyKey,
        localKeyId,
        error,
      });
    }
    throw error;
  }
  const credentials = bindingToUserCredentials(binding);
  const existingRows = await db()
    .select()
    .from(newApiKeyBinding)
    .where(eq(newApiKeyBinding.portalUserId, user.id));
  const syncedExistingRows = await syncPortalApiKeyStatuses(
    user.id,
    existingRows,
    client
  );
  const existingKey = syncedExistingRows.find(occupiesCustomerKeySlot);
  if (existingKey) {
    throw new Error(ONE_CUSTOMER_KEY_MESSAGE);
  }

  const remoteName = deriveRemoteKeyName(localKeyId);
  const pendingRemoteKeyId = `pending:${idempotencyKey}`;

  let pending: typeof newApiKeyBinding.$inferSelect;
  try {
    [pending] = await db()
      .insert(newApiKeyBinding)
      .values({
        id: localKeyId,
        portalUserId: user.id,
        newapiUserId: binding.newapiUserId,
        newapiKeyId: pendingRemoteKeyId,
        keyMasked: 'pending',
        displayName: input.name,
        status: 'creating_remote',
        allowedModels: '[]',
        groupId: group.id,
        newapiGroup,
        quotaLimit: input.quotaLimit,
        ipAllowlist: JSON.stringify(input.ipAllowlist || []),
        idempotencyKey,
      })
      .returning();
  } catch (error) {
    if (isDuplicateKeyNameConstraintError(error)) {
      throw new Error(DUPLICATE_KEY_NAME_MESSAGE);
    }
    throw error;
  }

  let remote: Awaited<ReturnType<NewApiClient['createKey']>>;
  try {
    remote = await client.createKey({
      user: credentials,
      remoteName,
      group: newapiGroup,
      quotaLimitUsd: input.quotaLimit,
      ipAllowlist: input.ipAllowlist || [],
    });
  } catch (error: any) {
    if (isLocalKeyFallbackEnabled()) {
      const plainKey = createLocalPortalPlainKey();
      const [created] = await db()
        .update(newApiKeyBinding)
        .set({
          newapiKeyId: `local:${localKeyId}`,
          keyMasked: maskPortalKey(plainKey),
          status: 'active',
          lastRemoteError: error?.message || null,
        })
        .where(eq(newApiKeyBinding.id, pending.id))
        .returning();

      await recordAudit({
        portalUserId: user.id,
        action: 'portal.key.create.local_fallback',
        targetType: 'portal_key',
        targetId: created.id,
        status: 'success',
        idempotencyKey,
        requestBody: input,
        responseBody: {
          localFallback: true,
          remoteError: error?.message || undefined,
        },
      });

      return {
        binding: toPublicApiKey({
          ...created,
          groupSlug: group.slug,
          groupName: group.name,
        }),
        plainKey,
      };
    }

    const status = getFailedKeyMutationStatus(error);

    await db()
      .update(newApiKeyBinding)
      .set({
        status,
        lastRemoteError: error?.message || 'create key failed',
      })
      .where(eq(newApiKeyBinding.id, pending.id));

    await recordAudit({
      portalUserId: user.id,
      action: 'newapi.key.create',
      targetType: 'newapi_key',
      targetId: pendingRemoteKeyId,
      status: 'failed',
      idempotencyKey,
      requestBody: input,
      errorMessage: error?.message || 'create key failed',
    });
    throw error;
  }

  if (remote.status !== 'active') {
    await db()
      .update(newApiKeyBinding)
      .set({
        newapiKeyId: remote.id,
        keyMasked: remote.maskedKey,
        status: 'failed_retriable',
        lastRemoteError: `Remote create did not return active status: ${remote.status}`,
      })
      .where(eq(newApiKeyBinding.id, pending.id));

    await recordAudit({
      portalUserId: user.id,
      action: 'newapi.key.create',
      targetType: 'newapi_key',
      targetId: remote.id,
      status: 'failed',
      idempotencyKey,
      requestBody: input,
      responseBody: {
        ...remote,
        key: remote.key ? '[redacted]' : undefined,
      },
      errorMessage: `Remote create did not return active status: ${remote.status}`,
    });

    throw new NewApiBridgeError({
      code: 'remote_error',
      message: `Remote create did not return active status: ${remote.status}`,
    });
  }

  try {
    const [created] = await db()
      .update(newApiKeyBinding)
      .set({
        newapiKeyId: remote.id,
        keyMasked: remote.maskedKey,
        status: 'active',
        lastRemoteError: null,
      })
      .where(eq(newApiKeyBinding.id, pending.id))
      .returning();

    await recordAudit({
      portalUserId: user.id,
      action: 'newapi.key.create',
      targetType: 'newapi_key',
      targetId: remote.id,
      status: 'success',
      idempotencyKey,
      requestBody: input,
      responseBody: { ...remote, key: remote.key ? '[redacted]' : undefined },
    });

    return {
      binding: toPublicApiKey({
        ...created,
        groupSlug: group.slug,
        groupName: group.name,
      }),
      plainKey: remote.key,
    };
  } catch (error: any) {
    const localBindingError =
      `local binding update failed for remote key ${remote.id}: ` +
      (error?.message || 'unknown error');

    await db()
      .update(newApiKeyBinding)
      .set({
        keyMasked: remote.maskedKey,
        status: 'remote_created_binding_failed',
        lastRemoteError: localBindingError,
      })
      .where(eq(newApiKeyBinding.id, pending.id));

    await recordAudit({
      portalUserId: user.id,
      action: 'newapi.key.create',
      targetType: 'newapi_key',
      targetId: remote.id,
      status: 'failed',
      idempotencyKey,
      requestBody: input,
      responseBody: { ...remote, key: remote.key ? '[redacted]' : undefined },
      errorMessage: localBindingError,
    });
    throw new NewApiBridgeError({
      code: 'remote_error',
      message:
        'Local key binding failed after remote key creation. Please clean up the failed key and try again.',
    });
  }
}

async function syncPortalApiKeyStatuses(
  portalUserId: string,
  rows: any[],
  client: NewApiClient
) {
  const binding = await getPortalUserBinding(portalUserId);
  if (!binding || binding.status !== 'active') return rows;

  try {
    const remoteKeys = await client.listKeys(bindingToUserCredentials(binding));
    const remoteById = new Map(remoteKeys.map((key) => [key.id, key]));
    const syncedRows = [];

    for (const row of rows) {
      const remote = remoteById.get(row.newapiKeyId);
      const syncedStatus = remote
        ? mapRemoteKeyStatus(row.status as KeyLifecycleStatus, remote.status)
        : undefined;

      if (!remote || !syncedStatus) {
        syncedRows.push(row);
        continue;
      }

      const [updated] = await db()
        .update(newApiKeyBinding)
        .set({
          keyMasked: remote.maskedKey,
          status: syncedStatus,
          deletedAt:
            syncedStatus === 'deleted' && !row.deletedAt
              ? new Date()
              : row.deletedAt,
          lastRemoteError: null,
        })
        .where(eq(newApiKeyBinding.id, row.id))
        .returning();
      if (syncedStatus === 'deleted') {
        continue;
      }
      syncedRows.push(
        updated
          ? { ...updated, groupSlug: row.groupSlug, groupName: row.groupName }
          : row
      );
    }

    return syncedRows;
  } catch {
    return rows;
  }
}

export async function listPortalApiKeys(
  portalUserId: string,
  client: NewApiClient = createNewApiClient()
) {
  const rows = await db()
    .select({
      id: newApiKeyBinding.id,
      portalUserId: newApiKeyBinding.portalUserId,
      newapiUserId: newApiKeyBinding.newapiUserId,
      newapiKeyId: newApiKeyBinding.newapiKeyId,
      keyMasked: newApiKeyBinding.keyMasked,
      displayName: newApiKeyBinding.displayName,
      status: newApiKeyBinding.status,
      allowedModels: newApiKeyBinding.allowedModels,
      groupId: newApiKeyBinding.groupId,
      newapiGroup: newApiKeyBinding.newapiGroup,
      quotaLimit: newApiKeyBinding.quotaLimit,
      ipAllowlist: newApiKeyBinding.ipAllowlist,
      idempotencyKey: newApiKeyBinding.idempotencyKey,
      lastRemoteError: newApiKeyBinding.lastRemoteError,
      createdAt: newApiKeyBinding.createdAt,
      updatedAt: newApiKeyBinding.updatedAt,
      lastUsedAt: newApiKeyBinding.lastUsedAt,
      deletedAt: newApiKeyBinding.deletedAt,
      groupSlug: catalogGroup.slug,
      groupName: catalogGroup.name,
    })
    .from(newApiKeyBinding)
    .leftJoin(catalogGroup, eq(newApiKeyBinding.groupId, catalogGroup.id))
    .where(
      and(
        eq(newApiKeyBinding.portalUserId, portalUserId),
        ne(newApiKeyBinding.status, 'deleted')
      )
    )
    .orderBy(desc(newApiKeyBinding.createdAt));

  const syncedRows = await syncPortalApiKeyStatuses(portalUserId, rows, client);

  return syncedRows.map(toPublicApiKey);
}

export async function listKeysByPortalUser(portalUserId: string) {
  const rows = await db()
    .select({
      id: newApiKeyBinding.id,
      keyMasked: newApiKeyBinding.keyMasked,
      displayName: newApiKeyBinding.displayName,
      status: newApiKeyBinding.status,
      allowedModels: newApiKeyBinding.allowedModels,
      createdAt: newApiKeyBinding.createdAt,
      updatedAt: newApiKeyBinding.updatedAt,
      lastUsedAt: newApiKeyBinding.lastUsedAt,
      deletedAt: newApiKeyBinding.deletedAt,
      groupSlug: catalogGroup.slug,
      groupName: catalogGroup.name,
    })
    .from(newApiKeyBinding)
    .leftJoin(catalogGroup, eq(newApiKeyBinding.groupId, catalogGroup.id))
    .where(
      and(
        eq(newApiKeyBinding.portalUserId, portalUserId),
        ne(newApiKeyBinding.status, 'deleted')
      )
    )
    .orderBy(desc(newApiKeyBinding.createdAt));

  return rows.map(toPublicApiKey);
}

export async function disablePortalApiKey(
  portalUserId: string,
  keyId: string,
  client: NewApiClient = createNewApiClient()
) {
  const [row] = await db()
    .select({
      id: newApiKeyBinding.id,
      portalUserId: newApiKeyBinding.portalUserId,
      newapiKeyId: newApiKeyBinding.newapiKeyId,
      status: newApiKeyBinding.status,
      groupSlug: catalogGroup.slug,
      groupName: catalogGroup.name,
    })
    .from(newApiKeyBinding)
    .leftJoin(catalogGroup, eq(newApiKeyBinding.groupId, catalogGroup.id))
    .where(
      and(
        eq(newApiKeyBinding.id, keyId),
        eq(newApiKeyBinding.portalUserId, portalUserId)
      )
    )
    .limit(1);

  if (!row) throw new Error('API key not found');
  if (!canDisableKeyStatus(row.status as KeyLifecycleStatus)) {
    throw new Error('API key is not in active state');
  }

  const idempotencyKey = `portal-key-disable:${portalUserId}:${keyId}:${getUuid()}`;

  if (isLocalFallbackKeyId(row.newapiKeyId)) {
    const [updated] = await db()
      .update(newApiKeyBinding)
      .set({ status: 'disabled', lastRemoteError: null })
      .where(eq(newApiKeyBinding.id, keyId))
      .returning();

    await recordAudit({
      portalUserId,
      action: 'portal.key.disable.local_fallback',
      targetType: 'portal_key',
      targetId: row.id,
      status: 'success',
      idempotencyKey,
      responseBody: { localFallback: true },
    });
    return toPublicApiKey({
      ...updated,
      groupSlug: row.groupSlug,
      groupName: row.groupName,
    });
  }

  const binding = await getPortalUserBinding(portalUserId);
  if (!binding || binding.status !== 'active') {
    throw new Error('New API user binding not found');
  }
  const credentials = bindingToUserCredentials(binding);

  await db()
    .update(newApiKeyBinding)
    .set({ status: 'disable_pending' })
    .where(eq(newApiKeyBinding.id, keyId));

  try {
    const remote = await client.disableKey(credentials, row.newapiKeyId);
    if (remote.status !== 'disabled') {
      throw new NewApiBridgeError({
        code: 'remote_error',
        message: `Remote disable did not confirm disabled status: ${remote.status}`,
      });
    }

    const [updated] = await db()
      .update(newApiKeyBinding)
      .set({
        status: 'disabled',
      })
      .where(eq(newApiKeyBinding.id, keyId))
      .returning();

    await recordAudit({
      portalUserId,
      action: 'newapi.key.disable',
      targetType: 'newapi_key',
      targetId: row.newapiKeyId,
      status: 'success',
      idempotencyKey,
      responseBody: remote,
    });
    return toPublicApiKey({
      ...updated,
      groupSlug: row.groupSlug,
      groupName: row.groupName,
    });
  } catch (error: any) {
    await db()
      .update(newApiKeyBinding)
      .set({
        status: getFailedKeyMutationStatus(error),
        lastRemoteError: error?.message || 'disable failed',
      })
      .where(eq(newApiKeyBinding.id, keyId));
    await recordAudit({
      portalUserId,
      action: 'newapi.key.disable',
      targetType: 'newapi_key',
      targetId: row.newapiKeyId,
      status: 'failed',
      idempotencyKey,
      errorMessage: error?.message || 'disable failed',
    });
    throw error;
  }
}

export async function deletePortalApiKey(
  portalUserId: string,
  keyId: string,
  client: NewApiClient = createNewApiClient()
) {
  const [row] = await db()
    .select({
      id: newApiKeyBinding.id,
      portalUserId: newApiKeyBinding.portalUserId,
      newapiKeyId: newApiKeyBinding.newapiKeyId,
      status: newApiKeyBinding.status,
      groupSlug: catalogGroup.slug,
      groupName: catalogGroup.name,
    })
    .from(newApiKeyBinding)
    .leftJoin(catalogGroup, eq(newApiKeyBinding.groupId, catalogGroup.id))
    .where(
      and(
        eq(newApiKeyBinding.id, keyId),
        eq(newApiKeyBinding.portalUserId, portalUserId)
      )
    )
    .limit(1);

  if (!row) throw new Error('API key not found');

  const status = row.status as KeyLifecycleStatus;
  const isCleanup = canCleanupKeyStatus(status);
  if (!canDeleteKeyStatus(status) && !isCleanup) {
    throw new Error('API key is not in deletable state');
  }

  const idempotencyKey = `portal-key-delete:${portalUserId}:${keyId}:${getUuid()}`;

  // 清理态（远端未建成 / 孤儿记录）：直接删本地死记录；远端若有残留 token 则尽力删、
  // 失败不阻塞清理，且不要求 active binding（失败态常伴随 binding 凭据失效）。
  if (isLocalFallbackKeyId(row.newapiKeyId)) {
    const [updated] = await db()
      .update(newApiKeyBinding)
      .set({ status: 'deleted', deletedAt: new Date(), lastRemoteError: null })
      .where(eq(newApiKeyBinding.id, keyId))
      .returning();

    await recordAudit({
      portalUserId,
      action: 'portal.key.delete.local_fallback',
      targetType: 'portal_key',
      targetId: row.id,
      status: 'success',
      idempotencyKey,
      responseBody: { localFallback: true, previousStatus: status },
    });
    return toPublicApiKey({
      ...updated,
      groupSlug: row.groupSlug,
      groupName: row.groupName,
    });
  }

  if (isCleanup) {
    const hasRemoteToken =
      !isPendingRemoteKeyId(row.newapiKeyId) &&
      !isLocalFallbackKeyId(row.newapiKeyId);
    const cleanupBinding = await getPortalUserBinding(portalUserId);
    if (
      hasRemoteToken &&
      cleanupBinding?.status === 'active' &&
      cleanupBinding.newapiAccessTokenEnc
    ) {
      try {
        await client.deleteKey(
          bindingToUserCredentials(cleanupBinding),
          row.newapiKeyId
        );
      } catch {
        // 清理场景：远端删除失败（token 不存在 / 凭据失效）不阻塞本地清理
      }
    }
    const [cleaned] = await db()
      .update(newApiKeyBinding)
      .set({ status: 'deleted', deletedAt: new Date() })
      .where(eq(newApiKeyBinding.id, keyId))
      .returning();
    await recordAudit({
      portalUserId,
      action: 'newapi.key.delete',
      targetType: 'newapi_key',
      targetId: row.newapiKeyId,
      status: 'success',
      idempotencyKey,
      responseBody: { cleanup: true, previousStatus: status },
    });
    return toPublicApiKey({
      ...cleaned,
      groupSlug: row.groupSlug,
      groupName: row.groupName,
    });
  }

  const binding = await getPortalUserBinding(portalUserId);
  if (!binding || binding.status !== 'active') {
    throw new Error('New API user binding not found');
  }
  const credentials = bindingToUserCredentials(binding);

  await db()
    .update(newApiKeyBinding)
    .set({ status: 'delete_pending' })
    .where(eq(newApiKeyBinding.id, keyId));

  try {
    const remote = await client.deleteKey(credentials, row.newapiKeyId);
    if (remote.id !== row.newapiKeyId) {
      throw new NewApiBridgeError({
        code: 'remote_error',
        message: `Remote delete did not confirm deleted key: ${row.newapiKeyId}`,
      });
    }

    const [updated] = await db()
      .update(newApiKeyBinding)
      .set({ status: 'deleted', deletedAt: new Date() })
      .where(eq(newApiKeyBinding.id, keyId))
      .returning();
    await recordAudit({
      portalUserId,
      action: 'newapi.key.delete',
      targetType: 'newapi_key',
      targetId: row.newapiKeyId,
      status: 'success',
      idempotencyKey,
      responseBody: remote,
    });
    return toPublicApiKey({
      ...updated,
      groupSlug: row.groupSlug,
      groupName: row.groupName,
    });
  } catch (error: any) {
    await db()
      .update(newApiKeyBinding)
      .set({
        status: getFailedKeyMutationStatus(error),
        lastRemoteError: error?.message || 'delete failed',
      })
      .where(eq(newApiKeyBinding.id, keyId));
    await recordAudit({
      portalUserId,
      action: 'newapi.key.delete',
      targetType: 'newapi_key',
      targetId: row.newapiKeyId,
      status: 'failed',
      idempotencyKey,
      errorMessage: error?.message || 'delete failed',
    });
    throw error;
  }
}

export async function getPortalUsage(
  user: Pick<User, 'id' | 'email'>,
  range: PortalUsageRange = '7d',
  client: NewApiClient = createNewApiClient()
): Promise<PortalUsageView> {
  const binding = await getPortalUserBinding(user.id);
  if (!binding || binding.status !== 'active') {
    return {
      summary: {
        requestCount: 0,
        inputTokens: 0,
        outputTokens: 0,
        byModel: [],
        status: 'empty',
      },
      logs: [],
    };
  }

  const [cachedBeforeSync] = await db()
    .select()
    .from(usageSnapshot)
    .where(
      and(
        eq(usageSnapshot.portalUserId, user.id),
        eq(usageSnapshot.range, range)
      )
    )
    .limit(1);

  if (isFreshSyncingSnapshot(cachedBeforeSync)) {
    const cachedLogs = await listCachedUsageLogs(user.id);
    return toPortalUsageViewFromSnapshot(
      cachedBeforeSync,
      cachedLogs,
      'syncing'
    );
  }

  await db()
    .insert(usageSnapshot)
    .values({
      id: getUuid(),
      portalUserId: user.id,
      newapiUserId: binding.newapiUserId,
      range,
      balanceUsd: cachedBeforeSync?.balanceUsd,
      quotaRemaining: cachedBeforeSync?.quotaRemaining,
      requestCount: cachedBeforeSync?.requestCount ?? 0,
      inputTokens: cachedBeforeSync?.inputTokens ?? 0,
      outputTokens: cachedBeforeSync?.outputTokens ?? 0,
      spendUsd: cachedBeforeSync?.spendUsd,
      byModel: cachedBeforeSync?.byModel ?? '[]',
      status: 'syncing',
      errorMessage: null,
      syncedAt: cachedBeforeSync?.syncedAt,
    })
    .onConflictDoUpdate({
      target: [usageSnapshot.portalUserId, usageSnapshot.range],
      set: {
        status: 'syncing',
        errorMessage: null,
      },
    });

  try {
    const credentials = bindingToUserCredentials(binding);
    const [quota, summary, logs] = await Promise.all([
      client.getQuota(credentials),
      client.getUsageSummary(credentials, range),
      client.listUsageLogs(credentials, 20),
    ]);
    const syncedAt = new Date();
    const keyMaskByRemoteName = await getUsageLogKeyMaskByRemoteName(user.id);
    const portalLogs = logs.map((log) =>
      toPortalUsageLog(log, keyMaskByRemoteName)
    );

    const [snapshot] = await db()
      .insert(usageSnapshot)
      .values({
        id: getUuid(),
        portalUserId: user.id,
        newapiUserId: binding.newapiUserId,
        range,
        balanceUsd: quota.balanceUsd,
        quotaRemaining: quota.quotaRemaining,
        requestCount: summary.requestCount,
        inputTokens: summary.inputTokens,
        outputTokens: summary.outputTokens,
        spendUsd: summary.spendUsd,
        byModel: JSON.stringify(summary.byModel),
        status: summary.requestCount === 0 ? 'empty' : 'ready',
        syncedAt,
      })
      .onConflictDoUpdate({
        target: [usageSnapshot.portalUserId, usageSnapshot.range],
        set: {
          balanceUsd: quota.balanceUsd,
          quotaRemaining: quota.quotaRemaining,
          requestCount: summary.requestCount,
          inputTokens: summary.inputTokens,
          outputTokens: summary.outputTokens,
          spendUsd: summary.spendUsd,
          byModel: JSON.stringify(summary.byModel),
          status: summary.requestCount === 0 ? 'empty' : 'ready',
          errorMessage: null,
          syncedAt,
        },
      })
      .returning();

    // 替换式刷新明细缓存：先清旧日志再写最新，避免同一请求多次同步重复累积
    // （requestCount 来自聚合 usageSnapshot 表，明细累积会导致两者行数口径不一）
    await db()
      .delete(usageLogSnapshot)
      .where(eq(usageLogSnapshot.portalUserId, user.id));

    const requestIdCounts = countRemoteUsageLogIds(logs);
    for (const [index, log] of logs.entries()) {
      const portalLog = portalLogs[index];
      await db()
        .insert(usageLogSnapshot)
        .values({
          id: getUuid(),
          portalUserId: user.id,
          newapiRequestId: toUsageLogSnapshotRequestId(
            log,
            index,
            requestIdCounts
          ),
          keyMasked: portalLog.keyMasked,
          modelId: log.modelId,
          status: log.status,
          inputTokens: log.inputTokens,
          outputTokens: log.outputTokens,
          spendUsd: log.spendUsd,
          createdAt: new Date(log.createdAt),
          syncedAt,
        })
        .onConflictDoNothing();
    }

    return {
      summary: {
        balanceUsd: snapshot.balanceUsd,
        quotaRemaining: snapshot.quotaRemaining,
        requestCount: snapshot.requestCount,
        inputTokens: snapshot.inputTokens,
        outputTokens: snapshot.outputTokens,
        spendUsd: snapshot.spendUsd,
        byModel: parseJsonArray(snapshot.byModel),
        status: snapshot.status,
        syncedAt: snapshot.syncedAt,
      },
      logs: portalLogs,
    };
  } catch (error: any) {
    const publicErrorMessage = getPublicUsageSyncErrorMessage(error);
    const [cached] = await db()
      .select()
      .from(usageSnapshot)
      .where(
        and(
          eq(usageSnapshot.portalUserId, user.id),
          eq(usageSnapshot.range, range)
        )
      )
      .limit(1);

    if (cached && hasUsableUsageSnapshot(cached)) {
      await db()
        .update(usageSnapshot)
        .set({
          status: 'stale',
          errorMessage: publicErrorMessage,
        })
        .where(eq(usageSnapshot.id, cached.id));

      const cachedLogs = await listCachedUsageLogs(user.id);

      return toPortalUsageViewFromSnapshot(
        cached,
        cachedLogs,
        'stale',
        publicErrorMessage
      );
    }

    if (cached) {
      await db()
        .update(usageSnapshot)
        .set({
          status: 'failed',
          errorMessage: publicErrorMessage,
        })
        .where(eq(usageSnapshot.id, cached.id));
    }

    return {
      summary: {
        requestCount: 0,
        inputTokens: 0,
        outputTokens: 0,
        byModel: [],
        status: 'failed',
        errorMessage: publicErrorMessage,
      },
      logs: [],
    };
  }
}

export async function listLedgerEntries(portalUserId: string) {
  const rows = await db()
    .select()
    .from(apipoolLedgerEntry)
    .where(eq(apipoolLedgerEntry.portalUserId, portalUserId))
    .orderBy(desc(apipoolLedgerEntry.createdAt));

  return rows.map(toPublicLedgerEntry);
}

export async function listAdjustmentLedgerByPortalUser(portalUserId: string) {
  const rows = await db()
    .select({
      id: apipoolLedgerEntry.id,
      operatorUserId: apipoolLedgerEntry.operatorUserId,
      newapiUserId: apipoolLedgerEntry.newapiUserId,
      newapiChangeId: apipoolLedgerEntry.newapiChangeId,
      amountUsd: apipoolLedgerEntry.amountUsd,
      source: apipoolLedgerEntry.source,
      status: apipoolLedgerEntry.status,
      reason: apipoolLedgerEntry.reason,
      rollbackStatus: apipoolLedgerEntry.rollbackStatus,
      createdAt: apipoolLedgerEntry.createdAt,
      updatedAt: apipoolLedgerEntry.updatedAt,
      operatorId: userTable.id,
      operatorName: userTable.name,
      operatorEmail: userTable.email,
    })
    .from(apipoolLedgerEntry)
    .leftJoin(userTable, eq(apipoolLedgerEntry.operatorUserId, userTable.id))
    .where(
      and(
        eq(apipoolLedgerEntry.portalUserId, portalUserId),
        eq(apipoolLedgerEntry.source, 'manual_adjustment')
      )
    )
    .orderBy(desc(apipoolLedgerEntry.createdAt));

  const audits = await db()
    .select({
      id: newApiBridgeAuditLog.id,
      operatorUserId: newApiBridgeAuditLog.operatorUserId,
      targetId: newApiBridgeAuditLog.targetId,
      status: newApiBridgeAuditLog.status,
      idempotencyKey: newApiBridgeAuditLog.idempotencyKey,
      requestBody: newApiBridgeAuditLog.requestBody,
      responseBody: newApiBridgeAuditLog.responseBody,
      errorMessage: newApiBridgeAuditLog.errorMessage,
      createdAt: newApiBridgeAuditLog.createdAt,
    })
    .from(newApiBridgeAuditLog)
    .where(
      and(
        eq(newApiBridgeAuditLog.portalUserId, portalUserId),
        eq(newApiBridgeAuditLog.action, 'newapi.quota.adjust')
      )
    )
    .orderBy(desc(newApiBridgeAuditLog.createdAt));

  function findAudit(row: any) {
    return audits.find((audit: any) => {
      if (audit.operatorUserId !== row.operatorUserId) return false;
      if (audit.targetId !== row.newapiUserId) return false;

      const requestBody: any = parseJsonObject(audit.requestBody);
      if (Number(requestBody.amountUsd) !== row.amountUsd) return false;
      if (requestBody.reason !== row.reason) return false;
      if (!row.newapiChangeId) return audit.status === row.status;

      const responseBody: any = parseJsonObject(audit.responseBody);
      return (
        responseBody.changeId === row.newapiChangeId ||
        audit.idempotencyKey === row.newapiChangeId
      );
    });
  }

  return rows.map((row: any) => ({
    id: row.id,
    newapiUserId: row.newapiUserId,
    newapiChangeId: row.newapiChangeId,
    amountUsd: row.amountUsd,
    source: row.source,
    status: row.status,
    reason: row.reason,
    rollbackStatus: row.rollbackStatus,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    operator: row.operatorId
      ? {
          id: row.operatorId,
          name: row.operatorName,
          email: row.operatorEmail,
        }
      : null,
    audit: (() => {
      const audit = findAudit(row);
      return audit
        ? {
            id: audit.id,
            status: audit.status,
            idempotencyKey: audit.idempotencyKey,
            errorMessage: audit.errorMessage,
          }
        : null;
    })(),
  }));
}

export async function listBillingLedgerEntries(
  portalUserId: string
): Promise<BillingLedgerEntry[]> {
  const rows = await db()
    .select({
      orderNo: apipoolLedgerEntry.orderNo,
      amountUsd: apipoolLedgerEntry.amountUsd,
      ledgerStatus: apipoolLedgerEntry.status,
      orderStatus: orderTable.status,
      paymentProvider: orderTable.paymentProvider,
      paidAt: orderTable.paidAt,
      createdAt: apipoolLedgerEntry.createdAt,
    })
    .from(apipoolLedgerEntry)
    .leftJoin(orderTable, eq(apipoolLedgerEntry.orderNo, orderTable.orderNo))
    .where(eq(apipoolLedgerEntry.portalUserId, portalUserId))
    .orderBy(desc(apipoolLedgerEntry.createdAt));

  return rows.map((row: any) => ({
    orderNo: row.orderNo,
    amountUsd: row.amountUsd,
    ledgerStatus: row.ledgerStatus,
    orderStatus: row.orderStatus,
    paymentProvider: row.paymentProvider,
    paidAt: toNullableTimestampMs(row.paidAt),
    createdAt: toTimestampMs(row.createdAt),
  }));
}

async function getLedgerEntryByIdempotencyKey({
  portalUserId,
  idempotencyKey,
}: {
  portalUserId: string;
  idempotencyKey: string;
}) {
  const [entry] = await db()
    .select()
    .from(apipoolLedgerEntry)
    .where(
      and(
        eq(apipoolLedgerEntry.portalUserId, portalUserId),
        eq(apipoolLedgerEntry.idempotencyKey, idempotencyKey)
      )
    )
    .limit(1);

  return entry;
}

export async function adjustPortalQuota(input: {
  portalUser: Pick<User, 'id' | 'email'>;
  operatorUserId: string;
  amountUsd: number;
  reason: string;
  idempotencyKey?: string;
  client?: NewApiClient;
}) {
  const requestedIdempotencyKey = input.idempotencyKey?.trim();
  const idempotencyKey =
    requestedIdempotencyKey ||
    `portal-adjustment:${input.portalUser.id}:${getUuid()}`;
  if (requestedIdempotencyKey) {
    const existing = await getLedgerEntryByIdempotencyKey({
      portalUserId: input.portalUser.id,
      idempotencyKey,
    });
    if (existing) return existing;
  }

  const client = input.client || createNewApiClient();
  const binding = await ensurePortalUserBinding(input.portalUser, client);
  const baseDraft: AdjustmentLedgerDraft = createAdjustmentLedgerDraft({
    portalUserId: input.portalUser.id,
    operatorUserId: input.operatorUserId,
    amountUsd: input.amountUsd,
    reason: input.reason,
    newapiUserId: binding.newapiUserId,
  });

  let pending: typeof apipoolLedgerEntry.$inferSelect;
  try {
    [pending] = await db()
      .insert(apipoolLedgerEntry)
      .values({
        id: getUuid(),
        portalUserId: baseDraft.portalUserId,
        operatorUserId: baseDraft.operatorUserId,
        newapiUserId: baseDraft.newapiUserId,
        newapiChangeId: null,
        orderNo: null,
        idempotencyKey,
        amountUsd: baseDraft.amountUsd,
        source: baseDraft.source,
        status: baseDraft.status,
        executor: baseDraft.executor,
        reason: baseDraft.reason,
        rollbackStatus: baseDraft.rollbackStatus,
      })
      .returning();
  } catch (error) {
    if (isQuotaIdempotencyConstraintError(error)) {
      const existing = await getLedgerEntryByIdempotencyKey({
        portalUserId: input.portalUser.id,
        idempotencyKey,
      });
      if (existing) return existing;
    }
    throw error;
  }

  try {
    const remote = await client.adjustQuota({
      user: bindingToUserCredentials(binding),
      amountUsd: input.amountUsd,
      reason: input.reason,
      reference: idempotencyKey,
    });
    const [updated] = await db()
      .update(apipoolLedgerEntry)
      .set({
        status: 'applied',
        newapiChangeId: remote.changeId,
      })
      .where(eq(apipoolLedgerEntry.id, pending.id))
      .returning();

    await recordAudit({
      portalUserId: input.portalUser.id,
      operatorUserId: input.operatorUserId,
      action: 'newapi.quota.adjust',
      targetType: 'newapi_user',
      targetId: binding.newapiUserId,
      status: 'success',
      idempotencyKey,
      requestBody: { amountUsd: input.amountUsd, reason: input.reason },
      responseBody: remote,
    });

    return updated;
  } catch (error: any) {
    const needsReconciliation = isQuotaAdjustmentReconciliationError(error);
    const [failed] = await db()
      .update(apipoolLedgerEntry)
      .set({
        status: needsReconciliation ? 'reconciliation_required' : 'failed',
        newapiChangeId: needsReconciliation ? error.changeId : undefined,
        rollbackStatus: 'not_required',
      })
      .where(eq(apipoolLedgerEntry.id, pending.id))
      .returning();

    await recordAudit({
      portalUserId: input.portalUser.id,
      operatorUserId: input.operatorUserId,
      action: 'newapi.quota.adjust',
      targetType: 'newapi_user',
      targetId: binding.newapiUserId,
      status: 'failed',
      idempotencyKey,
      requestBody: { amountUsd: input.amountUsd, reason: input.reason },
      responseBody: needsReconciliation
        ? { changeId: error.changeId, reconciliationRequired: true }
        : undefined,
      errorMessage: error?.message || 'adjust quota failed',
    });

    return failed;
  }
}
