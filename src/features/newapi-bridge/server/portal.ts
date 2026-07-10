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
import { findUserById, User } from '@/shared/models/user';

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

type NewApiBridgeDbWriter = {
  insert: ReturnType<typeof db>['insert'];
  update: ReturnType<typeof db>['update'];
  select: ReturnType<typeof db>['select'];
};

const TERMINAL_KEY_MUTATION_ERROR_CODES = new Set<NewApiBridgeErrorCode>([
  'unauthorized',
  'forbidden',
  'malformed_response',
]);
const USAGE_SYNC_LOCK_TTL_MS = 60_000;
const DUPLICATE_USAGE_LOG_ID_SEPARATOR = '#apipool-duplicate-';
const DUPLICATE_KEY_NAME_MESSAGE =
  'A key with this name already exists. Delete the existing key or choose another name.';
const MAX_REMOTE_NEWAPI_USERNAME_LENGTH = 20;

export type NewapiUsernameEmailDiagnosis =
  | {
      ok: true;
      username: string;
      remoteUsername: string;
      usesSurrogateUsername: boolean;
    }
  | {
      ok: false;
      code: 'portal_user_email_missing';
      normalizedEmail?: string;
      message: string;
    };

export function normalizeNewapiUsernameEmail(
  email: string | null | undefined
): NewapiUsernameEmailDiagnosis {
  const normalizedEmail = String(email || '')
    .trim()
    .toLowerCase();
  if (!normalizedEmail) {
    return {
      ok: false,
      code: 'portal_user_email_missing',
      message: 'Portal user email is missing',
    };
  }
  return {
    ok: true,
    username: normalizedEmail,
    remoteUsername:
      normalizedEmail.length <= MAX_REMOTE_NEWAPI_USERNAME_LENGTH
        ? normalizedEmail
        : '',
    usesSurrogateUsername:
      normalizedEmail.length > MAX_REMOTE_NEWAPI_USERNAME_LENGTH,
  };
}

function buildSurrogateNewapiUsername(portalUserId: string, email: string) {
  const hash = createHash('sha256')
    .update(`${portalUserId}:${email}`)
    .digest('hex')
    .slice(0, MAX_REMOTE_NEWAPI_USERNAME_LENGTH - 3);
  return `pu_${hash}`;
}

function isUsableRemoteNewapiUsername(username: string | null | undefined) {
  const normalized = String(username || '').trim();
  return (
    normalized.length > 0 &&
    normalized.length <= MAX_REMOTE_NEWAPI_USERNAME_LENGTH &&
    !normalized.startsWith('pending:')
  );
}

function resolveRemoteNewapiUsername(input: {
  portalUserId: string;
  diagnosis: Extract<NewapiUsernameEmailDiagnosis, { ok: true }>;
  existing?: typeof newApiUserBinding.$inferSelect | null;
}) {
  if (!input.diagnosis.usesSurrogateUsername) return input.diagnosis.username;
  if (isUsableRemoteNewapiUsername(input.existing?.newapiUsername)) {
    return String(input.existing?.newapiUsername).trim().toLowerCase();
  }
  return buildSurrogateNewapiUsername(
    input.portalUserId,
    input.diagnosis.username
  );
}

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

function sanitizeAuditBody(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeAuditBody);
  if (!value || typeof value !== 'object') return value;

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, entry]) => {
      const normalizedKey = key.toLowerCase();
      if (
        key === 'key' ||
        normalizedKey.includes('password') ||
        normalizedKey.includes('token') ||
        normalizedKey.includes('secret') ||
        normalizedKey.includes('credential')
      ) {
        return [key, '[redacted]'];
      }
      return [key, sanitizeAuditBody(entry)];
    })
  );
}

function serialize(value: unknown) {
  if (value === undefined) return undefined;
  try {
    return JSON.stringify(sanitizeAuditBody(value));
  } catch {
    return String(value);
  }
}

export async function recordAudit(input: AuditInput, writer: any = db()) {
  await writer.insert(newApiBridgeAuditLog).values({
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
    keyMasked: row.keyMasked,
    modelId: row.modelId,
    status: row.status,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    cacheTokens: row.cacheTokens,
    cacheRatio: row.cacheRatio,
    cacheCreationTokens: row.cacheCreationTokens,
    cacheCreationRatio: row.cacheCreationRatio,
    cacheCreationTokens5m: row.cacheCreationTokens5m,
    cacheCreationRatio5m: row.cacheCreationRatio5m,
    cacheCreationTokens1h: row.cacheCreationTokens1h,
    cacheCreationRatio1h: row.cacheCreationRatio1h,
    usageSemantic: row.usageSemantic,
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

function toPortalUsageViewFromSnapshot(
  snapshot: any,
  logs: any[],
  status = snapshot.status,
  errorMessage?: string
): PortalUsageView {
  return {
    summary: {
      // snapshot 里没有余额 = 从未成功同步过，保持 undefined 让 UI 显示「—」
      balanceUsd: snapshot.balanceUsd ?? undefined,
      quotaRemaining: snapshot.quotaRemaining ?? undefined,
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

function emptyPortalUsageView(
  status: PortalUsageView['summary']['status'] = 'empty',
  errorMessage?: string
): PortalUsageView {
  // 同步失败 != 余额为零：我们根本没读到远端余额。写 0 会让控制台显示
  // $0.00 并误弹「余额不足，去充值」（isLowBalance 对 undefined 不告警）。
  // status='empty' 是「从未同步过的新用户」，其余额确实是 0，提示充值正确。
  const unknownBalance = status === 'failed' || status === 'stale';

  return {
    summary: {
      balanceUsd: unknownBalance ? undefined : 0,
      quotaRemaining: unknownBalance ? undefined : 0,
      requestCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      byModel: [],
      status,
      errorMessage,
    },
    logs: [],
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

async function recordUsernameSyncBlocked(input: {
  portalUserId: string;
  operatorUserId?: string;
  targetNewapiUsername?: string;
  code: 'portal_user_email_missing';
  message: string;
  action: string;
  idempotencyKey: string;
}) {
  const existing = await getPortalUserBinding(input.portalUserId);
  const attemptedAt = new Date();
  const values = {
    status: 'username_sync_failed',
    targetNewapiUsername: input.targetNewapiUsername ?? null,
    lastSyncErrorCode: input.code,
    lastSyncError: input.message,
    lastSyncAction: input.action,
    lastSyncAttemptedAt: attemptedAt,
  };

  const [row] = existing
    ? await db()
        .update(newApiUserBinding)
        .set(values)
        .where(eq(newApiUserBinding.id, existing.id))
        .returning()
    : await db()
        .insert(newApiUserBinding)
        .values({
          id: getUuid(),
          portalUserId: input.portalUserId,
          newapiUserId: `pending:${getUuid()}`,
          ...values,
        })
        .returning();

  await recordAudit({
    portalUserId: input.portalUserId,
    operatorUserId: input.operatorUserId,
    action: 'newapi.user.username_sync',
    targetType: 'newapi_user',
    targetId: existing?.newapiUserId,
    status: 'failed',
    idempotencyKey: input.idempotencyKey,
    requestBody: { targetNewapiUsername: input.targetNewapiUsername },
    errorMessage: input.message,
  });

  return row;
}

// 远端 token 名称上限 30 字符，用本地 keyId 压缩出唯一技术名，
// 兼作门户侧幂等键（client.createKey 先查同名 token 再创建）
function deriveRemoteKeyName(localKeyId: string) {
  return `pk_${localKeyId.replace(/-/g, '').slice(0, 24)}`;
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
  options: {
    requiredNewapiGroup?: string;
    syncAction?: string;
    operatorUserId?: string;
  } = {}
) {
  const existing = await getPortalUserBinding(user.id);
  const syncAction = options.syncAction || 'lazy_provision';
  const idempotencyKey = `portal-user:${user.id}:username-sync`;
  if (existing?.status === 'disabled') {
    throw new NewApiBridgeError({
      code: 'forbidden',
      message: 'New API user binding is disabled',
    });
  }

  const diagnosis = normalizeNewapiUsernameEmail(user.email);
  if (!diagnosis.ok) {
    await recordUsernameSyncBlocked({
      portalUserId: user.id,
      operatorUserId: options.operatorUserId,
      targetNewapiUsername: diagnosis.normalizedEmail,
      code: diagnosis.code,
      message: diagnosis.message,
      action: syncAction,
      idempotencyKey,
    });
    throw new NewApiBridgeError({
      code: diagnosis.code,
      message: diagnosis.message,
    });
  }

  const targetUsername = diagnosis.username;
  const username = resolveRemoteNewapiUsername({
    portalUserId: user.id,
    diagnosis,
    existing,
  });
  if (
    existing &&
    existing.status === 'active' &&
    existing.newapiAccessTokenEnc
  ) {
    if (existing.newapiUsername !== username) {
      const attemptedAt = new Date();
      await db()
        .update(newApiUserBinding)
        .set({
          status: 'username_sync_pending',
          targetNewapiUsername: targetUsername,
          lastSyncErrorCode: null,
          lastSyncError: null,
          lastSyncAction: syncAction,
          lastSyncAttemptedAt: attemptedAt,
        })
        .where(eq(newApiUserBinding.id, existing.id));

      try {
        const remote = await client.updateUserProfile({
          newapiUserId: existing.newapiUserId,
          currentUsername: existing.newapiUsername || undefined,
          username,
          displayName: username,
          group: options.requiredNewapiGroup,
          remark: `apipool:portalUserId:${user.id};email:${targetUsername}`,
        });
        const syncedAt = new Date();
        const [synced] = await db()
          .update(newApiUserBinding)
          .set({
            status: 'active',
            newapiUsername: remote.username,
            targetNewapiUsername: targetUsername,
            lastSyncErrorCode: null,
            lastSyncError: null,
            lastSyncAction: syncAction,
            lastSyncedAt: syncedAt,
            lastSyncAttemptedAt: attemptedAt,
            conflictNewapiUserId: null,
          })
          .where(eq(newApiUserBinding.id, existing.id))
          .returning();

        await recordAudit({
          portalUserId: user.id,
          operatorUserId: options.operatorUserId,
          action: 'newapi.user.username_sync',
          targetType: 'newapi_user',
          targetId: existing.newapiUserId,
          status: 'success',
          idempotencyKey,
          requestBody: {
            currentUsername: existing.newapiUsername,
            targetNewapiUsername: targetUsername,
            remoteUsername: username,
          },
          responseBody: {
            username: remote.username,
            newapiUserId: remote.newapiUserId,
          },
        });

        return synced;
      } catch (error: any) {
        const status =
          error?.code === 'conflict_requires_review'
            ? 'conflict_requires_review'
            : 'username_sync_failed';
        const conflictNewapiUserId =
          error?.code === 'conflict_requires_review'
            ? error?.conflictNewapiUserId || null
            : null;
        const message = error?.message || 'New API username sync failed';
        const [failed] = await db()
          .update(newApiUserBinding)
          .set({
            status,
            targetNewapiUsername: targetUsername,
            lastSyncErrorCode: error?.code || 'remote_error',
            lastSyncError: message,
            lastSyncAction: syncAction,
            lastSyncAttemptedAt: attemptedAt,
            conflictNewapiUserId,
          })
          .where(eq(newApiUserBinding.id, existing.id))
          .returning();

        await recordAudit({
          portalUserId: user.id,
          operatorUserId: options.operatorUserId,
          action: 'newapi.user.username_sync',
          targetType: 'newapi_user',
          targetId: existing.newapiUserId,
          status: 'failed',
          idempotencyKey,
          requestBody: {
            currentUsername: existing.newapiUsername,
            targetNewapiUsername: targetUsername,
            remoteUsername: username,
          },
          responseBody: conflictNewapiUserId
            ? { conflictNewapiUserId }
            : undefined,
          errorMessage: message,
        });

        throw new NewApiBridgeError({
          code: (error?.code || 'remote_error') as NewApiBridgeErrorCode,
          message: failed.lastSyncError || message,
        });
      }
    }

    if (options.requiredNewapiGroup) {
      await client.ensureUserGroup({
        newapiUserId: existing.newapiUserId,
        username,
        group: options.requiredNewapiGroup,
      });
    }
    if (
      existing.targetNewapiUsername !== targetUsername ||
      existing.lastSyncErrorCode ||
      existing.lastSyncError
    ) {
      const [updated] = await db()
        .update(newApiUserBinding)
        .set({
          targetNewapiUsername: targetUsername,
          lastSyncErrorCode: null,
          lastSyncError: null,
          lastSyncAction: syncAction,
          lastSyncedAt: new Date(),
          lastSyncAttemptedAt: new Date(),
          conflictNewapiUserId: null,
        })
        .where(eq(newApiUserBinding.id, existing.id))
        .returning();
      return updated;
    }
    return existing;
  }

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
        targetNewapiUsername: targetUsername,
        newapiPasswordEnc: encryptCredential(password),
        status: 'provisioning',
        lastSyncErrorCode: null,
        lastSyncError: null,
        lastSyncAction: syncAction,
        lastSyncAttemptedAt: new Date(),
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
        status: 'provisioning',
        newapiUsername: username,
        targetNewapiUsername: targetUsername,
        newapiPasswordEnc: encryptCredential(password),
        lastSyncAction: syncAction,
        lastSyncAttemptedAt: new Date(),
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
        newapiUsername: username,
        targetNewapiUsername: targetUsername,
        lastSyncErrorCode: null,
        lastSyncError: null,
        lastSyncAction: syncAction,
        lastSyncedAt: new Date(),
        conflictNewapiUserId: null,
      })
      .where(eq(newApiUserBinding.id, row.id))
      .returning();

    await recordAudit({
      portalUserId: user.id,
      operatorUserId: options.operatorUserId,
      action: 'newapi.user.bind',
      targetType: 'newapi_user',
      targetId: remote.newapiUserId,
      status: 'success',
      idempotencyKey,
      // 审计绝不落凭据，只记用户名与远端 ID
      responseBody: {
        username,
        targetNewapiUsername: targetUsername,
        newapiUserId: remote.newapiUserId,
      },
    });
    return bound;
  } catch (error: any) {
    const status =
      error?.code === 'conflict_requires_review'
        ? 'conflict_requires_review'
        : 'username_sync_failed';
    const conflictNewapiUserId =
      error?.code === 'conflict_requires_review'
        ? error?.conflictNewapiUserId || null
        : null;
    const message = error?.message || 'New API user provision failed';
    await db()
      .update(newApiUserBinding)
      .set({
        status,
        targetNewapiUsername: targetUsername,
        lastSyncErrorCode: error?.code || 'remote_error',
        lastSyncError: message,
        lastSyncAction: syncAction,
        lastSyncAttemptedAt: new Date(),
        conflictNewapiUserId,
      })
      .where(eq(newApiUserBinding.id, row.id));

    await recordAudit({
      portalUserId: user.id,
      operatorUserId: options.operatorUserId,
      action: 'newapi.user.bind',
      targetType: 'newapi_user',
      status: 'failed',
      idempotencyKey,
      requestBody: { username },
      responseBody: conflictNewapiUserId
        ? { conflictNewapiUserId, targetNewapiUsername: targetUsername }
        : { targetNewapiUsername: targetUsername },
      errorMessage: message,
    });
    if (error instanceof NewApiBridgeError) throw error;
    throw new NewApiBridgeError({
      code: 'remote_error',
      message,
    });
  }
}

export async function provisionPortalUserAfterSignup(
  user: Pick<User, 'id' | 'email'>,
  client: NewApiClient = createNewApiClient()
): Promise<void> {
  const diagnosis = normalizeNewapiUsernameEmail(user.email);
  if (!diagnosis.ok) {
    await recordUsernameSyncBlocked({
      portalUserId: user.id,
      targetNewapiUsername: diagnosis.normalizedEmail,
      code: diagnosis.code,
      message: diagnosis.message,
      action: 'signup_provision',
      idempotencyKey: `portal-user:${user.id}:signup-provision`,
    });
    return;
  }

  try {
    await ensurePortalUserBinding(user, client, {
      syncAction: 'signup_provision',
    });
  } catch {
    // ensurePortalUserBinding already records binding state and audit.
  }
}

export function toAdminBindingDto(
  binding: typeof newApiUserBinding.$inferSelect
) {
  return {
    portalUserId: binding.portalUserId,
    status: binding.status,
    newapiUsername: binding.newapiUsername,
    targetNewapiUsername: binding.targetNewapiUsername,
    lastSyncErrorCode: binding.lastSyncErrorCode,
    lastSyncError: binding.lastSyncError,
    lastSyncAction: binding.lastSyncAction,
    lastSyncAttemptedAt: binding.lastSyncAttemptedAt,
    lastSyncedAt: binding.lastSyncedAt,
    conflictNewapiUserId: binding.conflictNewapiUserId,
  };
}

export async function updatePortalUserEmailWithNewapiSync(input: {
  portalUserId: string;
  newEmail: string;
  operatorUserId: string;
  client?: NewApiClient;
}): Promise<{
  status: 'active' | 'username_sync_failed' | 'conflict_requires_review';
}> {
  const portalUser = await findUserById(input.portalUserId);
  if (!portalUser) throw new Error('portal user not found');

  const diagnosis = normalizeNewapiUsernameEmail(input.newEmail);
  const idempotencyKey = `portal-user:${input.portalUserId}:email-change`;
  if (!diagnosis.ok) {
    await recordUsernameSyncBlocked({
      portalUserId: input.portalUserId,
      operatorUserId: input.operatorUserId,
      targetNewapiUsername: diagnosis.normalizedEmail,
      code: diagnosis.code,
      message: diagnosis.message,
      action: 'email_change',
      idempotencyKey,
    });
    return { status: 'username_sync_failed' };
  }

  const client = input.client || createNewApiClient();
  const existingBinding = await getPortalUserBinding(input.portalUserId);
  if (existingBinding?.status === 'disabled') {
    throw new NewApiBridgeError({
      code: 'forbidden',
      message: 'New API user binding is disabled',
    });
  }

  const targetUsername = diagnosis.username;
  const username = resolveRemoteNewapiUsername({
    portalUserId: input.portalUserId,
    diagnosis,
    existing: existingBinding,
  });
  let binding: typeof newApiUserBinding.$inferSelect | undefined;
  const attemptedAt = new Date();

  try {
    let remote: {
      newapiUserId: string;
      username: string;
      displayName: string;
      group: string;
      role: number;
      remark: string;
    };

    if (existingBinding?.status === 'active') {
      if (existingBinding.newapiUsername !== username) {
        await db()
          .update(newApiUserBinding)
          .set({
            status: 'username_sync_pending',
            targetNewapiUsername: targetUsername,
            lastSyncErrorCode: null,
            lastSyncError: null,
            lastSyncAction: 'email_change',
            lastSyncAttemptedAt: attemptedAt,
          })
          .where(eq(newApiUserBinding.id, existingBinding.id));

        remote = await client.updateUserProfile({
          newapiUserId: existingBinding.newapiUserId,
          currentUsername: existingBinding.newapiUsername || undefined,
          username,
          displayName: username,
          remark: `apipool:portalUserId:${input.portalUserId};email:${targetUsername}`,
        });
      } else {
        remote = {
          newapiUserId: existingBinding.newapiUserId,
          username,
          displayName: username,
          group: '',
          role: 0,
          remark: '',
        };
      }
      binding = existingBinding;
    } else {
      binding = await ensurePortalUserBinding(
        { id: portalUser.id, email: targetUsername },
        client,
        {
          syncAction: 'email_change',
          operatorUserId: input.operatorUserId,
        }
      );
      if (!binding) {
        throw new NewApiBridgeError({
          code: 'remote_error',
          message: 'New API user binding was not prepared',
        });
      }
      remote = {
        newapiUserId: binding.newapiUserId,
        username: binding.newapiUsername || username,
        displayName: binding.newapiUsername || username,
        group: '',
        role: 0,
        remark: '',
      };
    }

    const confirmedBinding = binding;
    if (!confirmedBinding) {
      throw new NewApiBridgeError({
        code: 'remote_error',
        message: 'New API user binding was not prepared',
      });
    }
    if (
      remote.newapiUserId !== confirmedBinding.newapiUserId ||
      remote.username !== username
    ) {
      throw new NewApiBridgeError({
        code: 'remote_error',
        message: 'New API username update was not confirmed',
      });
    }

    try {
      await db().transaction(async (tx: NewApiBridgeDbWriter) => {
        await tx
          .update(userTable)
          .set({ email: targetUsername })
          .where(eq(userTable.id, input.portalUserId));

        await tx
          .update(newApiUserBinding)
          .set({
            status: 'active',
            newapiUserId: remote.newapiUserId,
            newapiUsername: remote.username,
            targetNewapiUsername: targetUsername,
            lastSyncErrorCode: null,
            lastSyncError: null,
            lastSyncAction: 'email_change',
            lastSyncedAt: new Date(),
            lastSyncAttemptedAt: attemptedAt,
            conflictNewapiUserId: null,
          })
          .where(eq(newApiUserBinding.id, confirmedBinding.id));

        await recordAudit(
          {
            portalUserId: input.portalUserId,
            operatorUserId: input.operatorUserId,
            action: 'newapi.user.username_sync',
            targetType: 'newapi_user',
            targetId: confirmedBinding.newapiUserId,
            status: 'success',
            idempotencyKey,
            requestBody: {
              previousEmail: portalUser.email,
              newEmail: targetUsername,
            },
            responseBody: {
              username: remote.username,
              displayName: remote.displayName,
              group: remote.group,
              role: remote.role,
              remark: remote.remark,
            },
          },
          tx
        );
      });
    } catch (localError: any) {
      const message =
        'local_commit_failed: remote username may already be updated; local email/binding commit requires admin compensation';
      await db()
        .update(newApiUserBinding)
        .set({
          status: 'username_sync_failed',
          targetNewapiUsername: targetUsername,
          lastSyncErrorCode: 'local_commit_failed',
          lastSyncError: message,
          lastSyncAction: 'email_change',
          lastSyncAttemptedAt: new Date(),
        })
        .where(eq(newApiUserBinding.id, confirmedBinding.id));
      await recordAudit({
        portalUserId: input.portalUserId,
        operatorUserId: input.operatorUserId,
        action: 'newapi.user.username_sync',
        targetType: 'newapi_user',
        targetId: confirmedBinding.newapiUserId,
        status: 'failed',
        idempotencyKey,
        requestBody: {
          previousEmail: portalUser.email,
          newEmail: targetUsername,
        },
        responseBody: { remoteUpdatedUsername: remote.username },
        errorMessage: `${message}: ${
          localError?.message || 'local commit failed'
        }`,
      });
      return { status: 'username_sync_failed' };
    }

    return { status: 'active' };
  } catch (error: any) {
    const status =
      error?.code === 'conflict_requires_review'
        ? 'conflict_requires_review'
        : 'username_sync_failed';
    const conflictNewapiUserId =
      error?.code === 'conflict_requires_review'
        ? error?.conflictNewapiUserId || null
        : null;
    const message = error?.message || 'New API username sync failed';
    const failedBinding =
      binding || (await getPortalUserBinding(input.portalUserId));
    if (failedBinding) {
      await db()
        .update(newApiUserBinding)
        .set({
          status,
          targetNewapiUsername: targetUsername,
          lastSyncErrorCode: error?.code || 'remote_error',
          lastSyncError: message,
          lastSyncAction: 'email_change',
          lastSyncAttemptedAt: new Date(),
          conflictNewapiUserId,
        })
        .where(eq(newApiUserBinding.id, failedBinding.id));
    }
    await recordAudit({
      portalUserId: input.portalUserId,
      operatorUserId: input.operatorUserId,
      action: 'newapi.user.username_sync',
      targetType: 'newapi_user',
      targetId: failedBinding?.newapiUserId,
      status: 'failed',
      idempotencyKey,
      requestBody: {
        targetNewapiUsername: targetUsername,
        remoteUsername: username,
      },
      responseBody: conflictNewapiUserId ? { conflictNewapiUserId } : undefined,
      errorMessage: message,
    });
    return { status };
  }
}

export async function retryNewapiUserBindingForAdmin(input: {
  portalUserId: string;
  operatorUserId?: string;
  client?: NewApiClient;
}) {
  const portalUser = await findUserById(input.portalUserId);
  if (!portalUser) throw new Error('portal user not found');
  const binding = await ensurePortalUserBinding(
    portalUser,
    input.client || createNewApiClient(),
    { syncAction: 'manual_retry', operatorUserId: input.operatorUserId }
  );
  const [updated] = await db()
    .update(newApiUserBinding)
    .set({
      lastSyncAction: 'manual_retry',
      lastSyncAttemptedAt: new Date(),
    })
    .where(eq(newApiUserBinding.id, binding.id))
    .returning();

  await recordAudit({
    portalUserId: input.portalUserId,
    operatorUserId: input.operatorUserId,
    action: 'newapi.user.username_sync',
    targetType: 'newapi_user',
    targetId: binding.newapiUserId,
    status: 'success',
    idempotencyKey: `portal-user:${input.portalUserId}:manual-retry`,
    requestBody: { action: 'manual_retry' },
    responseBody: {
      status: updated.status,
      newapiUsername: updated.newapiUsername,
      targetNewapiUsername: updated.targetNewapiUsername,
    },
  });

  return toAdminBindingDto(updated);
}

export async function disableNewapiUserBindingForAdmin(input: {
  portalUserId: string;
  reason: string;
  operatorUserId?: string;
}) {
  const existing = await getPortalUserBinding(input.portalUserId);
  if (!existing) throw new Error('New API user binding not found');

  const [binding] = await db()
    .update(newApiUserBinding)
    .set({
      status: 'disabled',
      lastSyncAction: 'admin_disable',
      lastSyncError: input.reason,
      lastSyncAttemptedAt: new Date(),
    })
    .where(eq(newApiUserBinding.id, existing.id))
    .returning();

  await recordAudit({
    portalUserId: input.portalUserId,
    operatorUserId: input.operatorUserId,
    action: 'newapi.user.binding_disable',
    targetType: 'newapi_user',
    targetId: existing.newapiUserId,
    status: 'success',
    requestBody: { reason: input.reason },
  });

  return toAdminBindingDto(binding);
}

/**
 * 停用的逆操作：disable 只翻本地状态、无远端副作用，恢复也只需把
 * 状态翻出 disabled，再复用既有的手动重试管线（provisionUser 对
 * 已存在的远端用户按用户名+存储密码幂等恢复）。远端重试失败不抛：
 * 本地已离开 disabled，同步失败会照常记录在 binding 行上供页面展示。
 */
export async function restoreNewapiUserBindingForAdmin(input: {
  portalUserId: string;
  operatorUserId?: string;
  client?: NewApiClient;
}) {
  const existing = await getPortalUserBinding(input.portalUserId);
  if (!existing) throw new Error('New API user binding not found');
  if (existing.status !== 'disabled') {
    throw new Error('New API user binding is not disabled');
  }

  await db()
    .update(newApiUserBinding)
    .set({
      status: 'provisioning',
      lastSyncAction: 'admin_restore',
      lastSyncErrorCode: null,
      lastSyncError: null,
      lastSyncAttemptedAt: new Date(),
    })
    .where(eq(newApiUserBinding.id, existing.id));

  await recordAudit({
    portalUserId: input.portalUserId,
    operatorUserId: input.operatorUserId,
    action: 'newapi.user.binding_restore',
    targetType: 'newapi_user',
    targetId: existing.newapiUserId,
    status: 'success',
    requestBody: { previousStatus: existing.status },
  });

  try {
    return await retryNewapiUserBindingForAdmin({
      portalUserId: input.portalUserId,
      operatorUserId: input.operatorUserId,
      client: input.client,
    });
  } catch {
    const current = await getPortalUserBinding(input.portalUserId);
    return toAdminBindingDto(current!);
  }
}

export async function confirmNewapiUserConflictForAdmin(input: {
  portalUserId: string;
  newapiUserId: string;
  operatorUserId?: string;
  client?: Pick<NewApiClient, 'getUserProfile'>;
}) {
  const existing = await getPortalUserBinding(input.portalUserId);
  if (!existing) throw new Error('New API user binding not found');
  if (existing.status !== 'conflict_requires_review') {
    throw new Error('New API user binding is not waiting for conflict review');
  }
  if (existing.conflictNewapiUserId !== input.newapiUserId) {
    throw new Error('New API conflict candidate does not match this binding');
  }
  if (!existing.targetNewapiUsername) {
    throw new Error('New API conflict target username is missing');
  }

  const [owner] = await db()
    .select({
      id: newApiUserBinding.id,
      portalUserId: newApiUserBinding.portalUserId,
    })
    .from(newApiUserBinding)
    .where(eq(newApiUserBinding.newapiUserId, input.newapiUserId))
    .limit(1);
  if (owner && owner.portalUserId !== input.portalUserId) {
    throw new Error('New API user is already bound to another portal user');
  }

  const client = input.client || createNewApiClient();
  const remote = await client.getUserProfile({
    newapiUserId: input.newapiUserId,
    username: existing.targetNewapiUsername,
  });
  if (
    remote.newapiUserId !== input.newapiUserId ||
    remote.username !== existing.targetNewapiUsername
  ) {
    throw new Error('New API conflict candidate was not confirmed');
  }

  let activeBinding: typeof newApiUserBinding.$inferSelect | undefined;
  await db().transaction(async (tx: NewApiBridgeDbWriter) => {
    const [updated] = await tx
      .update(newApiUserBinding)
      .set({
        newapiUserId: remote.newapiUserId,
        status: 'active',
        newapiUsername: remote.username,
        targetNewapiUsername: remote.username,
        lastSyncErrorCode: null,
        lastSyncError: null,
        lastSyncAction: 'admin_confirm_conflict',
        lastSyncedAt: new Date(),
        lastSyncAttemptedAt: new Date(),
        conflictNewapiUserId: null,
      })
      .where(eq(newApiUserBinding.id, existing.id))
      .returning();
    activeBinding = updated;

    await recordAudit(
      {
        portalUserId: input.portalUserId,
        operatorUserId: input.operatorUserId,
        action: 'newapi.user.conflict_confirm',
        targetType: 'newapi_user',
        targetId: remote.newapiUserId,
        status: 'success',
        idempotencyKey: `portal-user:${input.portalUserId}:conflict-confirm:${remote.newapiUserId}`,
        requestBody: {
          targetNewapiUsername: existing.targetNewapiUsername,
          conflictNewapiUserId: input.newapiUserId,
        },
        responseBody: {
          username: remote.username,
          displayName: remote.displayName,
          group: remote.group,
          role: remote.role,
          remark: remote.remark,
        },
      },
      tx
    );
  });

  if (!activeBinding) throw new Error('New API conflict confirmation failed');
  return toAdminBindingDto(activeBinding);
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

  const binding = await ensurePortalUserBinding(user, client, {
    requiredNewapiGroup: newapiGroup,
  });
  const credentials = bindingToUserCredentials(binding);
  const idempotencyKey = `portal-key:${user.id}:${getUuid()}`;
  const localKeyId = getUuid();
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

  const binding = await getPortalUserBinding(portalUserId);
  if (!binding || binding.status !== 'active') {
    throw new Error('New API user binding not found');
  }
  const credentials = bindingToUserCredentials(binding);

  const idempotencyKey = `portal-key-disable:${portalUserId}:${keyId}:${getUuid()}`;

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
  if (isCleanup) {
    const hasRemoteToken = !row.newapiKeyId.startsWith('pending:');
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
  let binding = await getPortalUserBinding(user.id);
  if (!binding || binding.status !== 'active') {
    try {
      binding = await ensurePortalUserBinding(user, client, {
        syncAction: 'usage_lazy_provision',
      });
    } catch (error: any) {
      return emptyPortalUsageView(
        'failed',
        getPublicUsageSyncErrorMessage(error)
      );
    }
  }

  if (!binding || binding.status !== 'active') {
    return emptyPortalUsageView();
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
          keyMasked: log.keyMasked,
          modelId: log.modelId,
          status: log.status,
          inputTokens: log.inputTokens,
          outputTokens: log.outputTokens,
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
      logs: logs.map((log) => ({
        id: log.id,
        keyMasked: log.keyMasked,
        modelId: log.modelId,
        status: log.status,
        inputTokens: log.inputTokens,
        outputTokens: log.outputTokens,
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
        createdAt: new Date(log.createdAt),
      })),
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
        balanceUsd: 0,
        quotaRemaining: 0,
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

  // 与 recharge.ts 同一套崩溃防线（docs/06 §5）：
  // 兑换码一旦发出，远端就可能已入账，此后任何失败都不能落终态 failed——
  // 管理员换个幂等键重试会生成第二张码 → 双倍到账。
  let remoteAdjusted = false;
  let redemptionDispatched = false;
  try {
    // 在任何远端副作用之前落下持久化标记：进程若在「码已创建、码值
    // 尚未落库」之间被杀，靠它证明远端结局未知。
    await db()
      .update(apipoolLedgerEntry)
      .set({ remoteAttemptAt: new Date() })
      .where(eq(apipoolLedgerEntry.id, pending.id));

    const remote = await client.adjustQuota({
      user: bindingToUserCredentials(binding),
      amountUsd: input.amountUsd,
      reason: input.reason,
      reference: idempotencyKey,
      // 在兑换请求发出之前落库码值：崩溃后据此判定「不可自动重试」
      onRedemptionCreated: async (code) => {
        redemptionDispatched = true;
        await db()
          .update(apipoolLedgerEntry)
          .set({ newapiChangeId: code })
          .where(eq(apipoolLedgerEntry.id, pending.id));
      },
    });
    remoteAdjusted = true;
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
    const unknownOutcome =
      remoteAdjusted || needsReconciliation || redemptionDispatched;
    const [failed] = await db()
      .update(apipoolLedgerEntry)
      .set({
        status: unknownOutcome ? 'reconciliation_required' : 'failed',
        // 码值可能已由 onRedemptionCreated 落库；这里只在拿到更权威的
        // changeId 时覆盖，为空则保留已有值（撞唯一索引的风险同 recharge）。
        ...(needsReconciliation && error.changeId
          ? { newapiChangeId: error.changeId }
          : {}),
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
