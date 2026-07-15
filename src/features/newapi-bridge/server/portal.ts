import 'server-only';

import { createHash, randomBytes } from 'node:crypto';
import { getGroupBySlug } from '@/features/api-catalog/server/catalog-service';
import { getPublicUsageSyncErrorMessage } from '@/features/api-console/lib/public-errors';
import {
  AdjustmentLedgerDraft,
  createAdjustmentLedgerDraft,
} from '@/features/apipool-ledger/lib/ledger';
import { generatePortalKey } from '@/features/gateway/server/auth';
import { ensureWalletAccount } from '@/features/wallet/server/ledger';
import { and, desc, eq, inArray, ne } from 'drizzle-orm';

import { db } from '@/core/db';
import {
  apipoolLedgerEntry,
  catalogGroup,
  newApiBridgeAuditLog,
  newApiKeyBinding,
  newApiUserBinding,
  order as orderTable,
  portalApiKey,
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
    'uniq_portal_api_key_user_name_live',
    'portal_api_key.user_id',
    'portal_api_key.name',
  ]);
}

function isQuotaIdempotencyConstraintError(error: unknown) {
  return isConstraintErrorFor(error, [
    'idx_apipool_ledger_idempotency',
    'apipool_ledger_entry.idempotency_key',
  ]);
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
  const keyPrefix = row.keyPrefix ?? row.keyMasked;
  return {
    id: row.id,
    keyPrefix,
    keyMasked: keyPrefix,
    displayName: row.displayName ?? row.name,
    status: row.status,
    allowedModels: parseJsonArray<string>(row.allowedModels),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    lastUsedAt: row.lastUsedAt,
    deletedAt: row.deletedAt,
    groupSlug: row.groupSlug ?? null,
    groupName: row.groupName ?? null,
    legacy: row.legacy === true,
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

    // 供给在飞时管理员可能已把绑定停用；此处按 id 无条件写 active 会静默
    // 撤销那个更晚的停用决定。只在行仍未被停用时才落 active。
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
      .where(
        and(
          eq(newApiUserBinding.id, row.id),
          ne(newApiUserBinding.status, 'disabled')
        )
      )
      .returning();

    if (!bound) {
      throw new NewApiBridgeError({
        code: 'forbidden',
        message: 'New API user binding is disabled',
      });
    }

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
    // 同样不能覆盖在飞期间落地的停用：失败态写回也要给 disabled 让路，
    // 否则 disabled 会被改写成 username_sync_failed，停用决定被静默吞掉。
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
      .where(
        and(
          eq(newApiUserBinding.id, row.id),
          ne(newApiUserBinding.status, 'disabled')
        )
      );

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

  const { disableRuntimeCredentialsForUser } = await import(
    '@/features/gateway/server/credentials'
  );
  await disableRuntimeCredentialsForUser(input.portalUserId, 'user_disable');

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

  // 原子 claim：check-then-act 会让两个并发恢复都通过检查，也会让
  // 「读到 disabled」与「写 provisioning」之间落地的新停用被静默吞掉。
  const [claimed] = await db()
    .update(newApiUserBinding)
    .set({
      status: 'provisioning',
      lastSyncAction: 'admin_restore',
      lastSyncErrorCode: null,
      lastSyncError: null,
      lastSyncAttemptedAt: new Date(),
    })
    .where(
      and(
        eq(newApiUserBinding.id, existing.id),
        eq(newApiUserBinding.status, 'disabled')
      )
    )
    .returning();

  if (!claimed) {
    throw new Error('New API user binding is not disabled');
  }

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
  _client: NewApiClient = createNewApiClient()
) {
  void _client;
  const group = await getGroupBySlug(input.groupSlug);
  if (!group || group.status !== 'active' || group.allowCreateKey !== true) {
    throw new Error('group not available');
  }
  if (!group.newapiGroup.trim()) {
    throw new Error('group not available');
  }

  const [duplicateName] = await db()
    .select({ id: portalApiKey.id })
    .from(portalApiKey)
    .where(
      and(
        eq(portalApiKey.userId, user.id),
        eq(portalApiKey.name, input.name),
        ne(portalApiKey.status, 'deleted')
      )
    )
    .limit(1);
  if (duplicateName) {
    throw new Error(DUPLICATE_KEY_NAME_MESSAGE);
  }

  await ensureWalletAccount(user.id);
  const generated = generatePortalKey();
  let created: typeof portalApiKey.$inferSelect;
  try {
    [created] = await db()
      .insert(portalApiKey)
      .values({
        id: getUuid(),
        userId: user.id,
        groupId: group.id,
        keyHash: generated.hash,
        keyPrefix: generated.prefix,
        status: 'active',
        name: input.name,
      })
      .returning();
  } catch (error) {
    if (isDuplicateKeyNameConstraintError(error)) {
      throw new Error(DUPLICATE_KEY_NAME_MESSAGE);
    }
    throw error;
  }

  await recordAudit({
    portalUserId: user.id,
    action: 'portal.key.create_local',
    targetType: 'portal_api_key',
    targetId: created.id,
    status: 'success',
    idempotencyKey: `portal-key-local:${created.id}`,
    requestBody: input,
    responseBody: { id: created.id, keyPrefix: created.keyPrefix },
  });

  return {
    binding: toPublicApiKey({
      ...created,
      groupSlug: group.slug,
      groupName: group.name,
    }),
    plainKey: generated.plain,
  };
}

async function findLegacyPortalApiKey(portalUserId: string, keyId: string) {
  const [legacy] = await db()
    .select({ id: newApiKeyBinding.id })
    .from(newApiKeyBinding)
    .where(
      and(
        eq(newApiKeyBinding.id, keyId),
        eq(newApiKeyBinding.portalUserId, portalUserId)
      )
    )
    .limit(1);
  return legacy ?? null;
}

export async function listPortalApiKeys(
  portalUserId: string,
  _client: NewApiClient = createNewApiClient()
) {
  void _client;
  const localRows = await db()
    .select({
      id: portalApiKey.id,
      keyPrefix: portalApiKey.keyPrefix,
      name: portalApiKey.name,
      status: portalApiKey.status,
      createdAt: portalApiKey.createdAt,
      updatedAt: portalApiKey.updatedAt,
      lastUsedAt: portalApiKey.lastUsedAt,
      deletedAt: portalApiKey.deletedAt,
      groupSlug: catalogGroup.slug,
      groupName: catalogGroup.name,
    })
    .from(portalApiKey)
    .leftJoin(catalogGroup, eq(portalApiKey.groupId, catalogGroup.id))
    .where(
      and(
        eq(portalApiKey.userId, portalUserId),
        ne(portalApiKey.status, 'deleted')
      )
    );

  const legacyRows = await db()
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
    );

  return [
    ...localRows.map(toPublicApiKey),
    ...legacyRows.map((row: any) => toPublicApiKey({ ...row, legacy: true })),
  ].sort(
    (left, right) =>
      new Date(right.createdAt).getTime() - new Date(left.createdAt).getTime()
  );
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
  _client: NewApiClient = createNewApiClient()
) {
  const [row] = await db()
    .select({
      id: portalApiKey.id,
      keyPrefix: portalApiKey.keyPrefix,
      name: portalApiKey.name,
      status: portalApiKey.status,
      createdAt: portalApiKey.createdAt,
      updatedAt: portalApiKey.updatedAt,
      lastUsedAt: portalApiKey.lastUsedAt,
      deletedAt: portalApiKey.deletedAt,
      groupSlug: catalogGroup.slug,
      groupName: catalogGroup.name,
    })
    .from(portalApiKey)
    .leftJoin(catalogGroup, eq(portalApiKey.groupId, catalogGroup.id))
    .where(
      and(eq(portalApiKey.id, keyId), eq(portalApiKey.userId, portalUserId))
    )
    .limit(1);

  if (!row) {
    if (await findLegacyPortalApiKey(portalUserId, keyId)) {
      throw new Error('Legacy API keys are read-only');
    }
    throw new Error('API key not found');
  }
  if (row.status === 'disabled') return toPublicApiKey(row);
  if (row.status !== 'active') {
    throw new Error('API key is not in active state');
  }

  const disabledAt = new Date();
  const [updated] = await db()
    .update(portalApiKey)
    .set({ status: 'disabled', disabledAt })
    .where(
      and(
        eq(portalApiKey.id, keyId),
        eq(portalApiKey.userId, portalUserId),
        eq(portalApiKey.status, 'active')
      )
    )
    .returning();
  if (!updated) {
    return disablePortalApiKey(portalUserId, keyId, _client);
  }

  await recordAudit({
    portalUserId,
    action: 'portal.key.disable_local',
    targetType: 'portal_api_key',
    targetId: keyId,
    status: 'success',
    idempotencyKey: `portal-key-disable-local:${keyId}`,
  });
  return toPublicApiKey({
    ...updated,
    groupSlug: row.groupSlug,
    groupName: row.groupName,
  });
}

export async function deletePortalApiKey(
  portalUserId: string,
  keyId: string,
  _client: NewApiClient = createNewApiClient()
) {
  const [row] = await db()
    .select({
      id: portalApiKey.id,
      keyPrefix: portalApiKey.keyPrefix,
      name: portalApiKey.name,
      status: portalApiKey.status,
      createdAt: portalApiKey.createdAt,
      updatedAt: portalApiKey.updatedAt,
      lastUsedAt: portalApiKey.lastUsedAt,
      deletedAt: portalApiKey.deletedAt,
      groupSlug: catalogGroup.slug,
      groupName: catalogGroup.name,
    })
    .from(portalApiKey)
    .leftJoin(catalogGroup, eq(portalApiKey.groupId, catalogGroup.id))
    .where(
      and(eq(portalApiKey.id, keyId), eq(portalApiKey.userId, portalUserId))
    )
    .limit(1);

  if (!row) {
    if (await findLegacyPortalApiKey(portalUserId, keyId)) {
      throw new Error('Legacy API keys are read-only');
    }
    throw new Error('API key not found');
  }
  if (row.status === 'deleted') return toPublicApiKey(row);
  if (row.status !== 'active' && row.status !== 'disabled') {
    throw new Error('API key is not in deletable state');
  }

  const deletedAt = new Date();
  const [updated] = await db()
    .update(portalApiKey)
    .set({ status: 'deleted', deletedAt })
    .where(
      and(
        eq(portalApiKey.id, keyId),
        eq(portalApiKey.userId, portalUserId),
        ne(portalApiKey.status, 'deleted')
      )
    )
    .returning();
  if (!updated) {
    return deletePortalApiKey(portalUserId, keyId, _client);
  }

  await recordAudit({
    portalUserId,
    action: 'portal.key.delete_local',
    targetType: 'portal_api_key',
    targetId: keyId,
    status: 'success',
    idempotencyKey: `portal-key-delete-local:${keyId}`,
  });
  return toPublicApiKey({
    ...updated,
    groupSlug: row.groupSlug,
    groupName: row.groupName,
  });
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
      orderNo: apipoolLedgerEntry.orderNo,
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
    // 充值行必须一起展示：用户投诉「付了钱没到账」时，只看人工调额
    // 等于看不见任何证据（pending / reconciliation_required 全在充值行上）。
    .where(
      and(
        eq(apipoolLedgerEntry.portalUserId, portalUserId),
        inArray(apipoolLedgerEntry.source, ['manual_adjustment', 'recharge'])
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
        inArray(newApiBridgeAuditLog.action, [
          'newapi.quota.adjust',
          'newapi.recharge.apply',
        ])
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
    orderNo: row.orderNo,
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

/**
 * 未结清的人工调额状态。带着这些状态的行意味着「远端结局未知或正在进行」，
 * 此时**绝不能**再发起一次调额——前端幂等键只活在内存里（收到响应即清空、
 * 刷新即丢失），指望它去重等于没有去重。
 */
const UNRESOLVED_ADJUSTMENT_STATUSES = [
  'pending',
  'processing',
  'reconciliation_required',
];
const ADJUSTMENT_RECLAIM_AFTER_MS = 5 * 60 * 1000;

/**
 * 供 route 层原样透出给管理员：不能带 `code` 字段，措辞也不得触发
 * `INTERNAL_ERROR_PATTERNS`（例如出现 "New API" 就会被整条替换成通用文案），
 * 否则管理员看到的将是「稍后重试」而不是「有一笔调额待对账」。
 */
export class UnresolvedQuotaAdjustmentError extends Error {
  constructor(public readonly ledgerId: string) {
    super(
      `An unresolved quota adjustment (${ledgerId}) is blocking new adjustments for this user. Reconcile that entry with the upstream provider before retrying.`
    );
    this.name = 'UnresolvedQuotaAdjustmentError';
  }
}

/**
 * 把未结清的人工调额分成两类：必须挡住的（远端结局未知，或仍在飞），
 * 与可以安全回收的（陈旧且 `remoteAttemptAt`/`newapiChangeId` 皆为 null——
 * 这两个标记写在任何远端副作用之前，同时为 null 才是「远端什么都没发生」的证据）。
 */
async function triageUnresolvedAdjustments(dbOrTx: any, portalUserId: string) {
  const rows = await dbOrTx
    .select()
    .from(apipoolLedgerEntry)
    .where(
      and(
        eq(apipoolLedgerEntry.portalUserId, portalUserId),
        eq(apipoolLedgerEntry.source, 'manual_adjustment'),
        inArray(apipoolLedgerEntry.status, UNRESOLVED_ADJUSTMENT_STATUSES)
      )
    );

  const now = Date.now();
  const reclaimable: string[] = [];
  for (const row of rows) {
    const remoteOutcomeUnknown =
      row.status === 'reconciliation_required' ||
      row.remoteAttemptAt !== null ||
      row.newapiChangeId !== null;
    const stillInFlight =
      now - (row.updatedAt?.getTime() ?? now) <= ADJUSTMENT_RECLAIM_AFTER_MS;

    if (remoteOutcomeUnknown || stillInFlight) {
      return { blockingLedgerId: row.id as string, reclaimable: [] };
    }
    reclaimable.push(row.id as string);
  }

  return { blockingLedgerId: null, reclaimable };
}

/**
 * 未结清调额的人工裁决出口。守卫是 fail-closed 的：一条 `reconciliation_required`
 * 或带远端标记的陈旧 `pending` 会永久挡住该用户的后续调额。没有这个出口，
 * 解封就只能靠改数据库——一次网络超时即成事故。
 *
 * 门户**无法**替管理员判断远端到底有没有入账（New API 没有可查兑换状态的接口，
 * 见 docs/04），所以这里不做任何远端调用：管理员按 `newapiChangeId` 去 New API
 * 侧核对后，把结论连同依据（note）写回来，全过程留审计。
 */
export async function resolveQuotaAdjustment(input: {
  ledgerId: string;
  operatorUserId: string;
  resolution: 'confirm_applied' | 'mark_void';
  note: string;
}) {
  const note = input.note?.trim();
  if (!note) {
    throw new Error('A reconciliation note is required');
  }

  const [entry] = await db()
    .select()
    .from(apipoolLedgerEntry)
    .where(eq(apipoolLedgerEntry.id, input.ledgerId));

  if (!entry) {
    throw new Error('Ledger entry not found');
  }
  if (!UNRESOLVED_ADJUSTMENT_STATUSES.includes(entry.status)) {
    throw new Error(
      `Ledger entry ${input.ledgerId} is not awaiting reconciliation (status: ${entry.status})`
    );
  }

  const nextStatus =
    input.resolution === 'confirm_applied' ? 'applied' : 'failed';

  // 条件更新：并发裁决只有一个能落地，另一个会看到「已结清」而不是静默覆盖
  const [updated] = await db()
    .update(apipoolLedgerEntry)
    .set({ status: nextStatus, rollbackStatus: 'not_required' })
    .where(
      and(
        eq(apipoolLedgerEntry.id, input.ledgerId),
        inArray(apipoolLedgerEntry.status, UNRESOLVED_ADJUSTMENT_STATUSES)
      )
    )
    .returning();

  if (!updated) {
    throw new Error(
      `Ledger entry ${input.ledgerId} is not awaiting reconciliation`
    );
  }

  await recordAudit({
    portalUserId: entry.portalUserId,
    operatorUserId: input.operatorUserId,
    action: 'newapi.quota.adjust_resolve',
    targetType: 'newapi_user',
    targetId: entry.newapiUserId,
    status: 'success',
    idempotencyKey: entry.idempotencyKey || undefined,
    requestBody: {
      ledgerId: input.ledgerId,
      previousStatus: entry.status,
      resolution: input.resolution,
      note,
      newapiChangeId: entry.newapiChangeId,
      amountUsd: entry.amountUsd,
    },
    responseBody: { status: nextStatus },
  });

  return updated;
}

/**
 * 调额失败的真实原因只落在审计表里（例如「扣减会使余额为负」），
 * ledger 行上只有一个 `failed`。管理员是这条错误的受众，把它取出来。
 */
export async function getAdjustmentFailureReason(
  ledgerId: string
): Promise<string | null> {
  const [entry] = await db()
    .select({ idempotencyKey: apipoolLedgerEntry.idempotencyKey })
    .from(apipoolLedgerEntry)
    .where(eq(apipoolLedgerEntry.id, ledgerId));

  if (!entry?.idempotencyKey) return null;

  const [audit] = await db()
    .select({ errorMessage: newApiBridgeAuditLog.errorMessage })
    .from(newApiBridgeAuditLog)
    .where(
      and(
        eq(newApiBridgeAuditLog.idempotencyKey, entry.idempotencyKey),
        eq(newApiBridgeAuditLog.status, 'failed')
      )
    )
    .orderBy(desc(newApiBridgeAuditLog.createdAt));

  return audit?.errorMessage || null;
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

  // 只读快速失败：未结清时连远端用户供给都不该触发（真正的判定在下面的事务里）
  const preflight = await triageUnresolvedAdjustments(
    db(),
    input.portalUser.id
  );
  if (preflight.blockingLedgerId) {
    throw new UnresolvedQuotaAdjustmentError(preflight.blockingLedgerId);
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
    // 「判定未结清 + 插入 pending 行」必须原子：否则两个并发提交（各自
    // 携带不同的前端幂等键）会双双通过检查，各发一次远端写。
    pending = await db().transaction(async (tx: any) => {
      const triage = await triageUnresolvedAdjustments(tx, input.portalUser.id);
      if (triage.blockingLedgerId) {
        throw new UnresolvedQuotaAdjustmentError(triage.blockingLedgerId);
      }
      for (const staleId of triage.reclaimable) {
        await tx
          .update(apipoolLedgerEntry)
          .set({ status: 'failed', rollbackStatus: 'not_required' })
          .where(eq(apipoolLedgerEntry.id, staleId));
      }

      const [inserted] = await tx
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
      return inserted;
    });
  } catch (error) {
    if (error instanceof UnresolvedQuotaAdjustmentError) throw error;
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
  let quotaWriteDispatched = false;
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
      // 负向调额：改余额的 PUT 已发出，响应丢失也不得判为可重试的失败
      onQuotaWriteDispatched: () => {
        quotaWriteDispatched = true;
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
      remoteAdjusted ||
      needsReconciliation ||
      redemptionDispatched ||
      quotaWriteDispatched;
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
