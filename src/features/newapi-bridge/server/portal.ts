import 'server-only';

import { createHash, randomBytes } from 'node:crypto';
import { getGroupBySlug } from '@/features/api-catalog/server/catalog-service';
import { getPublicUsageSyncErrorMessage } from '@/features/api-console/lib/public-errors';
import {
  canDeleteKeyStatus,
  canDisableKeyStatus,
  getUsageSyncState,
  type KeyLifecycleStatus,
} from '@/features/api-console/lib/status';
import {
  AdjustmentLedgerDraft,
  createAdjustmentLedgerDraft,
} from '@/features/apipool-ledger/lib/ledger';
import { and, desc, eq } from 'drizzle-orm';

import { db } from '@/core/db';
import {
  apipoolLedgerEntry,
  catalogGroup,
  newApiBridgeAuditLog,
  newApiKeyBinding,
  newApiUserBinding,
  usageLogSnapshot,
  usageSnapshot,
} from '@/config/db/schema';
import { getUuid } from '@/shared/lib/hash';
import { User } from '@/shared/models/user';

import {
  createNewApiClient,
  NewApiBridgeError,
  NewApiClient,
  type NewApiBridgeErrorCode,
  type NewApiUserCredentials,
  type RemoteKey,
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

function toPublicUsageLog(row: any) {
  return {
    id: row.newapiRequestId || row.id,
    keyMasked: row.keyMasked,
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
  client: NewApiClient = createNewApiClient()
) {
  const existing = await getPortalUserBinding(user.id);
  if (
    existing &&
    existing.status === 'active' &&
    existing.newapiAccessTokenEnc
  ) {
    return existing;
  }

  const idempotencyKey = `portal-user:${user.id}`;
  const username = existing?.newapiUsername || deriveNewapiUsername(user.id);
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

export async function createPortalApiKey(
  user: Pick<User, 'id' | 'email'>,
  input: PortalKeyCreateInput,
  client: NewApiClient = createNewApiClient()
) {
  const group = await getGroupBySlug(input.groupSlug);
  if (!group || group.status !== 'active' || group.allowCreateKey !== true) {
    throw new Error('group not available');
  }

  const binding = await ensurePortalUserBinding(user, client);
  const credentials = bindingToUserCredentials(binding);
  const idempotencyKey = `portal-key:${user.id}:${getUuid()}`;
  const localKeyId = getUuid();
  const remoteName = deriveRemoteKeyName(localKeyId);
  const pendingRemoteKeyId = `pending:${idempotencyKey}`;

  const [pending] = await db()
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
      newapiGroup: group.newapiGroup,
      quotaLimit: input.quotaLimit,
      ipAllowlist: JSON.stringify(input.ipAllowlist || []),
      idempotencyKey,
    })
    .returning();

  let remote: Awaited<ReturnType<NewApiClient['createKey']>>;
  try {
    remote = await client.createKey({
      user: credentials,
      remoteName,
      group: group.newapiGroup,
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
      binding: toPublicApiKey({ ...created, groupName: group.name }),
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
    throw error;
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
      syncedRows.push(updated ? { ...updated, groupName: row.groupName } : row);
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
      groupName: catalogGroup.name,
    })
    .from(newApiKeyBinding)
    .leftJoin(catalogGroup, eq(newApiKeyBinding.groupId, catalogGroup.id))
    .where(eq(newApiKeyBinding.portalUserId, portalUserId))
    .orderBy(desc(newApiKeyBinding.createdAt));

  const syncedRows = await syncPortalApiKeyStatuses(portalUserId, rows, client);

  return syncedRows.map(toPublicApiKey);
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
    return toPublicApiKey({ ...updated, groupName: row.groupName });
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
  if (!canDeleteKeyStatus(row.status as KeyLifecycleStatus)) {
    throw new Error('API key is not in deletable state');
  }

  const binding = await getPortalUserBinding(portalUserId);
  if (!binding || binding.status !== 'active') {
    throw new Error('New API user binding not found');
  }
  const credentials = bindingToUserCredentials(binding);

  const idempotencyKey = `portal-key-delete:${portalUserId}:${keyId}:${getUuid()}`;

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
    return toPublicApiKey({ ...updated, groupName: row.groupName });
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

    for (const log of logs) {
      await db()
        .insert(usageLogSnapshot)
        .values({
          id: getUuid(),
          portalUserId: user.id,
          newapiRequestId: log.id,
          keyMasked: log.keyMasked,
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
      logs: logs.map((log) => ({
        id: log.id,
        keyMasked: log.keyMasked,
        modelId: log.modelId,
        status: log.status,
        inputTokens: log.inputTokens,
        outputTokens: log.outputTokens,
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
      const state = getUsageSyncState(cached.syncedAt || null);
      await db()
        .update(usageSnapshot)
        .set({
          status: state === 'failed' ? 'failed' : 'stale',
          errorMessage: publicErrorMessage,
        })
        .where(eq(usageSnapshot.id, cached.id));

      const cachedLogs = await listCachedUsageLogs(user.id);

      return toPortalUsageViewFromSnapshot(
        cached,
        cachedLogs,
        state === 'failed' ? 'failed' : 'stale',
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

export async function adjustPortalQuota(input: {
  portalUser: Pick<User, 'id' | 'email'>;
  operatorUserId: string;
  amountUsd: number;
  reason: string;
  client?: NewApiClient;
}) {
  const client = input.client || createNewApiClient();
  const binding = await ensurePortalUserBinding(input.portalUser, client);
  const idempotencyKey = `portal-adjustment:${input.portalUser.id}:${getUuid()}`;
  const baseDraft: AdjustmentLedgerDraft = createAdjustmentLedgerDraft({
    portalUserId: input.portalUser.id,
    operatorUserId: input.operatorUserId,
    amountUsd: input.amountUsd,
    reason: input.reason,
    newapiUserId: binding.newapiUserId,
  });

  const [pending] = await db()
    .insert(apipoolLedgerEntry)
    .values({
      id: getUuid(),
      portalUserId: baseDraft.portalUserId,
      operatorUserId: baseDraft.operatorUserId,
      newapiUserId: baseDraft.newapiUserId,
      amountUsd: baseDraft.amountUsd,
      source: baseDraft.source,
      status: baseDraft.status,
      executor: baseDraft.executor,
      reason: baseDraft.reason,
      rollbackStatus: baseDraft.rollbackStatus,
    })
    .returning();

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
    const [failed] = await db()
      .update(apipoolLedgerEntry)
      .set({
        status: 'failed',
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
      errorMessage: error?.message || 'adjust quota failed',
    });

    return failed;
  }
}
