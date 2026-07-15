import 'server-only';

import { createHash } from 'node:crypto';
import {
  createNewApiClient,
  type NewApiClient,
} from '@/features/newapi-bridge/server/client';
import {
  decryptCredential,
  encryptCredential,
} from '@/features/newapi-bridge/server/crypto';
import {
  bindingToUserCredentials,
  ensurePortalUserBinding,
} from '@/features/newapi-bridge/server/portal';
import { and, eq, inArray, isNull } from 'drizzle-orm';

import { db } from '@/core/db';
import {
  credentialRetirement,
  newApiUserBinding,
  runtimeCredential,
  user as userTable,
} from '@/config/db/schema';
import { getUuid } from '@/shared/lib/hash';
import { recordPortalAdminAudit } from '@/shared/models/portal-admin-audit';

const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX = 1000;
const INVALID_DEBOUNCE_MS = 5 * 60 * 1000;

const cache = new Map<
  string,
  { credentialId: string; runtimeKey: string; expiresAt: number }
>();

export type EnsureCredentialResult =
  | { status: 'ok'; credentialId: string; runtimeKey: string }
  | { status: 'pending' }
  | { status: 'disabled' };

export function buildRuntimeCredentialName(
  portalUserId: string,
  newapiGroup: string
): string {
  const digest = createHash('sha256')
    .update(`${portalUserId}:${newapiGroup}`)
    .digest('hex')
    .slice(0, 24);
  return `rk_${digest}`;
}

function cacheKey(portalUserId: string, newapiGroup: string) {
  return `${portalUserId}:${newapiGroup}`;
}

function cacheCredential(
  portalUserId: string,
  newapiGroup: string,
  credentialId: string,
  runtimeKey: string
) {
  const key = cacheKey(portalUserId, newapiGroup);
  cache.delete(key);
  cache.set(key, {
    credentialId,
    runtimeKey,
    expiresAt: Date.now() + CACHE_TTL_MS,
  });
  while (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

export function invalidateCredentialCache(
  portalUserId: string,
  newapiGroup?: string
) {
  if (newapiGroup) {
    cache.delete(cacheKey(portalUserId, newapiGroup));
    return;
  }
  const prefix = `${portalUserId}:`;
  for (const key of cache.keys()) {
    if (key.startsWith(prefix)) cache.delete(key);
  }
}

export async function ensureRuntimeCredential(
  userId: string,
  newapiGroup: string
): Promise<EnsureCredentialResult> {
  const key = cacheKey(userId, newapiGroup);
  const cached = cache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    cache.delete(key);
    cache.set(key, cached);
    return {
      status: 'ok',
      credentialId: cached.credentialId,
      runtimeKey: cached.runtimeKey,
    };
  }
  if (cached) cache.delete(key);

  let [row] = await db()
    .select()
    .from(runtimeCredential)
    .where(
      and(
        eq(runtimeCredential.portalUserId, userId),
        eq(runtimeCredential.newapiGroup, newapiGroup)
      )
    )
    .limit(1);

  if (!row) {
    await db()
      .insert(runtimeCredential)
      .values({
        id: getUuid(),
        portalUserId: userId,
        newapiGroup,
        remoteName: buildRuntimeCredentialName(userId, newapiGroup),
        status: 'pending',
      })
      .onConflictDoNothing();
    return { status: 'pending' };
  }

  if (row.status === 'active' && row.tokenEnc) {
    const runtimeKey = decryptCredential(row.tokenEnc);
    cacheCredential(userId, newapiGroup, row.id, runtimeKey);
    return { status: 'ok', credentialId: row.id, runtimeKey };
  }

  if (row.status === 'disabled') {
    const [binding] = await db()
      .select({ status: newApiUserBinding.status })
      .from(newApiUserBinding)
      .where(eq(newApiUserBinding.portalUserId, userId))
      .limit(1);
    if (binding?.status === 'disabled') return { status: 'disabled' };

    [row] = await db()
      .update(runtimeCredential)
      .set({ status: 'pending', lastError: null })
      .where(
        and(
          eq(runtimeCredential.id, row.id),
          eq(runtimeCredential.status, 'disabled')
        )
      )
      .returning();
    if (row) return { status: 'pending' };
  }

  return { status: 'pending' };
}

async function enqueueRetirement(
  writer: any,
  credentialId: string,
  newapiTokenId: string,
  reason: 'invalid' | 'user_disable' | 'rotate'
) {
  const [existing] = await writer
    .select({ id: credentialRetirement.id })
    .from(credentialRetirement)
    .where(
      and(
        eq(credentialRetirement.credentialId, credentialId),
        eq(credentialRetirement.newapiTokenId, newapiTokenId)
      )
    )
    .limit(1);
  if (existing) return;
  await writer.insert(credentialRetirement).values({
    id: getUuid(),
    credentialId,
    newapiTokenId,
    reason,
  });
}

function isEnabledToken(item: any) {
  return item?.status === 1 || item?.status === 'active';
}

function maskRuntimeKey(runtimeKey: string) {
  return `sk-…${runtimeKey.slice(-4)}`;
}

async function loadRetirementBlacklist(credentialId: string) {
  const rows = await db()
    .select({ newapiTokenId: credentialRetirement.newapiTokenId })
    .from(credentialRetirement)
    .where(eq(credentialRetirement.credentialId, credentialId));
  return new Set(rows.map((row: any) => row.newapiTokenId));
}

async function processCredential(
  row: typeof runtimeCredential.$inferSelect,
  client: NewApiClient,
  ensureBinding: typeof ensurePortalUserBinding
): Promise<void> {
  const historicalTokenId = row.newapiTokenId;
  if (row.status === 'invalid') {
    if (row.newapiTokenId) {
      await enqueueRetirement(db(), row.id, row.newapiTokenId, 'invalid');
    }
    const [pending] = await db()
      .update(runtimeCredential)
      .set({
        status: 'pending',
        newapiTokenId: null,
        tokenEnc: null,
        keyMasked: null,
      })
      .where(eq(runtimeCredential.id, row.id))
      .returning();
    row = pending;
  }

  const [portalUser] = await db()
    .select({ id: userTable.id, email: userTable.email })
    .from(userTable)
    .where(eq(userTable.id, row.portalUserId))
    .limit(1);
  if (!portalUser) throw new Error('portal user not found');

  const binding = await ensureBinding(portalUser, client);
  const credentials = bindingToUserCredentials(binding);
  const blacklist = await loadRetirementBlacklist(row.id);
  if (historicalTokenId) blacklist.add(historicalTokenId);

  const tryAdopt = async (): Promise<'adopted' | 'missing' | 'mismatch'> => {
    const allMatches = await client.findTokensByNameExact(
      credentials,
      row.remoteName
    );
    const candidates = allMatches.filter(
      (item: any) => isEnabledToken(item) && !blacklist.has(String(item.id))
    );
    if (candidates.length === 0) return 'missing';

    const tokenIds = candidates.map((item: any) => String(item.id));
    if (
      candidates.length !== 1 ||
      String(candidates[0].group ?? '') !== row.newapiGroup
    ) {
      const mismatchIds = tokenIds.length > 0 ? tokenIds : ['unknown'];
      await db()
        .update(runtimeCredential)
        .set({ lastError: `adoption_mismatch:${mismatchIds.join(',')}` })
        .where(eq(runtimeCredential.id, row.id));
      console.warn(
        `runtime credential adoption mismatch: ${row.id} ${mismatchIds.join(',')}`
      );
      return 'mismatch';
    }

    const tokenId = tokenIds[0];
    const runtimeKey = await client.getTokenKey(credentials, tokenId);
    const [activated] = await db()
      .update(runtimeCredential)
      .set({
        status: 'active',
        newapiUserId: binding.newapiUserId,
        newapiTokenId: tokenId,
        tokenEnc: encryptCredential(runtimeKey),
        keyMasked: maskRuntimeKey(runtimeKey),
        lastError: null,
      })
      .where(
        and(
          eq(runtimeCredential.id, row.id),
          eq(runtimeCredential.status, 'pending')
        )
      )
      .returning();
    if (!activated) throw new Error('runtime credential state changed');
    invalidateCredentialCache(row.portalUserId, row.newapiGroup);
    return 'adopted';
  };

  const firstAttempt = await tryAdopt();
  if (firstAttempt === 'adopted') return;
  if (firstAttempt === 'mismatch') {
    throw new Error('adoption_mismatch');
  }

  await client.createTokenRaw(credentials, {
    name: row.remoteName,
    group: row.newapiGroup,
    unlimitedQuota: true,
  });
  const secondAttempt = await tryAdopt();
  if (secondAttempt !== 'adopted') {
    if (secondAttempt === 'missing') {
      throw new Error('created runtime token could not be located');
    }
    throw new Error('adoption_mismatch');
  }
}

async function processRetirement(
  retirement: typeof credentialRetirement.$inferSelect,
  client: NewApiClient,
  ensureBinding: typeof ensurePortalUserBinding
) {
  const [credential] = await db()
    .select({ portalUserId: runtimeCredential.portalUserId })
    .from(runtimeCredential)
    .where(eq(runtimeCredential.id, retirement.credentialId))
    .limit(1);
  if (!credential) throw new Error('runtime credential not found');
  const [portalUser] = await db()
    .select({ id: userTable.id, email: userTable.email })
    .from(userTable)
    .where(eq(userTable.id, credential.portalUserId))
    .limit(1);
  if (!portalUser) throw new Error('portal user not found');
  const binding = await ensureBinding(portalUser, client);
  await client.disableKey(
    bindingToUserCredentials(binding),
    retirement.newapiTokenId
  );
  await db()
    .update(credentialRetirement)
    .set({ disabledAt: new Date(), lastError: null })
    .where(eq(credentialRetirement.id, retirement.id));
}

export async function runCredentialWorkerOnce(
  deps: {
    client?: NewApiClient;
    ensureBinding?: typeof ensurePortalUserBinding;
    keepAlive?: () => Promise<boolean>;
  } = {}
): Promise<{ processed: number; failed: number }> {
  const client = deps.client ?? createNewApiClient();
  const ensureBinding = deps.ensureBinding ?? ensurePortalUserBinding;
  const keepAlive = deps.keepAlive ?? (async () => true);
  let processed = 0;
  let failed = 0;

  const retirements = await db()
    .select()
    .from(credentialRetirement)
    .where(isNull(credentialRetirement.disabledAt));
  for (const retirement of retirements) {
    if (!(await keepAlive())) return { processed, failed };
    processed += 1;
    try {
      await processRetirement(retirement, client, ensureBinding);
    } catch (error: any) {
      failed += 1;
      const message = error?.message || 'credential retirement failed';
      await db()
        .update(credentialRetirement)
        .set({ lastError: message })
        .where(eq(credentialRetirement.id, retirement.id));
      console.warn(`runtime credential retirement failed: ${message}`);
    }
  }

  const pendingRows = await db()
    .select()
    .from(runtimeCredential)
    .where(inArray(runtimeCredential.status, ['pending', 'invalid']));
  for (const row of pendingRows) {
    if (!(await keepAlive())) return { processed, failed };
    processed += 1;
    try {
      await processCredential(row, client, ensureBinding);
    } catch (error: any) {
      failed += 1;
      const [current] = await db()
        .select({ lastError: runtimeCredential.lastError })
        .from(runtimeCredential)
        .where(eq(runtimeCredential.id, row.id))
        .limit(1);
      const message = error?.message || 'runtime credential creation failed';
      if (!current?.lastError?.startsWith('adoption_mismatch:')) {
        await db()
          .update(runtimeCredential)
          .set({ status: 'pending', lastError: message })
          .where(eq(runtimeCredential.id, row.id));
      }
      console.warn(`runtime credential worker failed: ${row.id} ${message}`);
    }
  }
  return { processed, failed };
}

export async function disableRuntimeCredentialsForUser(
  userId: string,
  reason: 'user_disable'
): Promise<void> {
  await db().transaction(async (tx: any) => {
    const rows = await tx
      .select()
      .from(runtimeCredential)
      .where(eq(runtimeCredential.portalUserId, userId));
    for (const row of rows) {
      if (row.newapiTokenId) {
        await enqueueRetirement(tx, row.id, row.newapiTokenId, reason);
      }
    }
    await tx
      .update(runtimeCredential)
      .set({
        status: 'disabled',
        newapiTokenId: null,
        tokenEnc: null,
        keyMasked: null,
      })
      .where(eq(runtimeCredential.portalUserId, userId));
  });
  invalidateCredentialCache(userId);
}

export async function markCredentialInvalid(
  credentialId: string,
  error: string
): Promise<void> {
  const [row] = await db()
    .select()
    .from(runtimeCredential)
    .where(eq(runtimeCredential.id, credentialId))
    .limit(1);
  if (!row) return;
  if (
    row.status === 'invalid' &&
    row.updatedAt.getTime() > Date.now() - INVALID_DEBOUNCE_MS
  ) {
    return;
  }
  await db()
    .update(runtimeCredential)
    .set({ status: 'invalid', lastError: error })
    .where(
      and(
        eq(runtimeCredential.id, credentialId),
        inArray(runtimeCredential.status, ['active', 'invalid'])
      )
    );
  invalidateCredentialCache(row.portalUserId, row.newapiGroup);
}

export async function rotateRuntimeCredential(
  credentialId: string,
  operatorUserId: string
): Promise<void> {
  let before: typeof runtimeCredential.$inferSelect | undefined;
  await db().transaction(async (tx: any) => {
    [before] = await tx
      .select()
      .from(runtimeCredential)
      .where(eq(runtimeCredential.id, credentialId))
      .limit(1);
    if (!before) throw new Error('runtime credential not found');
    if (before.newapiTokenId) {
      await enqueueRetirement(tx, before.id, before.newapiTokenId, 'rotate');
    }
    await tx
      .update(runtimeCredential)
      .set({
        status: 'pending',
        newapiTokenId: null,
        tokenEnc: null,
        keyMasked: null,
        lastError: null,
      })
      .where(eq(runtimeCredential.id, credentialId));
  });
  invalidateCredentialCache(before!.portalUserId, before!.newapiGroup);
  await recordPortalAdminAudit({
    action: 'credential.rotate',
    operatorUserId,
    targetType: 'runtime_credential',
    targetId: credentialId,
    beforeJson: {
      status: before!.status,
      newapiTokenId: before!.newapiTokenId,
    },
    afterJson: { status: 'pending' },
    reason: 'rotate',
  });
}
