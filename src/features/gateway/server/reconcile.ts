import 'server-only';

import {
  computeChargeMicroUsd,
  normalizeBackfillUsage,
  type PriceVector,
  type UsageBuckets,
} from '@/features/gateway/lib/billing';
import { and, eq, isNull, lt, or } from 'drizzle-orm';

import { db } from '@/core/db';
import {
  gatewayJobLock,
  modelPriceVersion,
  newApiUserBinding,
  reconcileOrphanObservation,
  requestLedger,
  runtimeCredential,
  walletAccount,
  walletLedger,
} from '@/config/db/schema';
import { getUuid } from '@/shared/lib/hash';

import { settleByNewapiRequestId } from './settlement';

const LOCK_ID = 'singleton';
const DEFAULT_SLICE_MS = 10 * 60_000;
const DEFAULT_SLICE_PAGE_LIMIT = 50;
const DEFAULT_MAX_SLICES_PER_RUN = 12;
const OVERLAP_MS = 10 * 60_000;
const DEFAULT_LOOKBACK_MS = 24 * 60 * 60_000;
const WAIVED_ALERT_THRESHOLD = 10;

type UsageLog = {
  requestId?: string;
  keyMasked?: string;
  tokenName?: string;
  modelId?: string;
  inputTokens: number;
  outputTokens: number;
  spendUsd?: number;
  createdAt: string;
  [key: string]: unknown;
};

type Slice = { start: number; end: number };
type SliceResult = 'complete' | 'overflow' | 'lost_lock';

function quotaFromLog(log: UsageLog): number | null {
  if (log.spendUsd === undefined || !Number.isFinite(log.spendUsd)) {
    return null;
  }
  return Math.round(log.spendUsd * 500_000);
}

function logTokenName(log: UsageLog) {
  return String(log.keyMasked ?? log.tokenName ?? '');
}

function ledgerBuckets(row: typeof requestLedger.$inferSelect): UsageBuckets {
  return {
    uncachedInput: row.uncachedInputTokens ?? 0,
    cachedRead: row.cachedReadTokens ?? 0,
    cacheWrite5m: row.cacheWrite5mTokens ?? 0,
    cacheWrite1h: row.cacheWrite1hTokens ?? 0,
    output: row.outputTokens ?? 0,
    reasoning: row.reasoningTokens ?? 0,
  };
}

function retailPrice(row: typeof modelPriceVersion.$inferSelect): PriceVector {
  return {
    inputMicroUsdPerM: row.inputMicroUsdPerM,
    cachedInputMicroUsdPerM: row.cachedInputMicroUsdPerM,
    cacheWrite5mMicroUsdPerM: row.cacheWrite5mMicroUsdPerM,
    cacheWrite1hMicroUsdPerM: row.cacheWrite1hMicroUsdPerM,
    outputMicroUsdPerM: row.outputMicroUsdPerM,
  };
}

function referencePrice(
  row: typeof modelPriceVersion.$inferSelect,
  buckets: UsageBuckets
): { price: PriceVector | null; missing: string[] } {
  const dimensions = [
    ['uncached_input', buckets.uncachedInput, row.newapiRefInputMicroUsdPerM],
    ['cached_read', buckets.cachedRead, row.newapiRefCachedInputMicroUsdPerM],
    [
      'cache_write_5m',
      buckets.cacheWrite5m,
      row.newapiRefCacheWrite5mMicroUsdPerM,
    ],
    [
      'cache_write_1h',
      buckets.cacheWrite1h,
      row.newapiRefCacheWrite1hMicroUsdPerM,
    ],
    ['output', buckets.output, row.newapiRefOutputMicroUsdPerM],
  ] as const;
  const missing = dimensions
    .filter(([, tokens, price]) => tokens > 0 && price === null)
    .map(([name]) => name);
  if (missing.length > 0) return { price: null, missing };
  return {
    price: {
      inputMicroUsdPerM: row.newapiRefInputMicroUsdPerM ?? 0,
      cachedInputMicroUsdPerM: row.newapiRefCachedInputMicroUsdPerM ?? 0,
      cacheWrite5mMicroUsdPerM:
        row.newapiRefCacheWrite5mMicroUsdPerM ?? 0,
      cacheWrite1hMicroUsdPerM:
        row.newapiRefCacheWrite1hMicroUsdPerM ?? 0,
      outputMicroUsdPerM: row.newapiRefOutputMicroUsdPerM ?? 0,
    },
    missing,
  };
}

async function reconcileSettled(
  row: typeof requestLedger.$inferSelect,
  log: UsageLog,
  telemetry: Record<string, unknown>
) {
  const [price] = await db()
    .select()
    .from(modelPriceVersion)
    .where(eq(modelPriceVersion.id, row.priceVersionId))
    .limit(1);
  if (!price) throw new Error(`price version missing: ${row.priceVersionId}`);

  const buckets = ledgerBuckets(row);
  const notes: string[] = [];
  const tokenMismatch =
    log.inputTokens !==
      buckets.uncachedInput +
        buckets.cachedRead +
        buckets.cacheWrite5m +
        buckets.cacheWrite1h || log.outputTokens !== buckets.output;
  const modelMismatch = log.modelId !== row.newapiModelId;
  if (modelMismatch) notes.push('model_mismatch');

  const internalExpected = Number(
    computeChargeMicroUsd(buckets, retailPrice(price))
  );
  const internalMismatch = internalExpected !== row.chargedMicroUsd;
  if (internalMismatch) notes.push('internal_amount_mismatch');

  const quota = quotaFromLog(log);
  const ref = referencePrice(price, buckets);
  let externalMismatch = false;
  if (ref.missing.length > 0) {
    notes.push(...ref.missing.map((name) => `ref_missing:${name}`));
  } else if (quota === null) {
    notes.push('quota_missing');
  } else {
    const actualMicroUsd = quota * 2;
    const expectedMicroUsd = Number(
      computeChargeMicroUsd(buckets, ref.price!)
    );
    const tolerance = Math.max(10, Math.ceil(Math.abs(actualMicroUsd) * 0.01));
    externalMismatch =
      Math.abs(actualMicroUsd - expectedMicroUsd) > tolerance;
    if (externalMismatch) notes.push('external_amount_mismatch');
  }

  const reconcileStatus =
    tokenMismatch || modelMismatch
      ? 'token_mismatch'
      : internalMismatch || externalMismatch
        ? 'amount_mismatch'
        : 'matched';
  await db()
    .update(requestLedger)
    .set({
      ...telemetry,
      reconcileStatus,
      reconcileNote: notes.length > 0 ? notes.join(',') : null,
      reconciledAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(requestLedger.id, row.id));
}

async function recordOrphan(log: UsageLog): Promise<boolean> {
  const tokenName = logTokenName(log);
  if (!tokenName.startsWith('rk_')) {
    console.warn('[reconcile] out_of_scope_consumption', {
      requestId: log.requestId,
    });
    return false;
  }
  const [credential] = await db()
    .select()
    .from(runtimeCredential)
    .where(eq(runtimeCredential.remoteName, tokenName))
    .limit(1);
  const [inserted] = await db()
    .insert(reconcileOrphanObservation)
    .values({
      id: getUuid(),
      newapiRequestId: log.requestId!,
      portalUserId: credential?.portalUserId ?? null,
      newapiGroup: credential?.newapiGroup ?? null,
      newapiModelId: credential ? String(log.modelId ?? '') : null,
      credentialId: credential?.id ?? null,
      tokenName,
      newapiQuota: quotaFromLog(log),
      newapiPromptTokens: log.inputTokens,
      newapiCompletionTokens: log.outputTokens,
      logCreatedAt: Number.isFinite(Date.parse(log.createdAt))
        ? new Date(log.createdAt)
        : null,
    })
    .onConflictDoNothing({
      target: reconcileOrphanObservation.newapiRequestId,
    })
    .returning();
  return Boolean(inserted);
}

async function processUsageLog(
  log: UsageLog,
  counters: { waivedOrOrphans: number }
) {
  if (!log.requestId) return;
  const [row] = await db()
    .select()
    .from(requestLedger)
    .where(eq(requestLedger.newapiRequestId, log.requestId))
    .limit(1);
  if (!row) {
    if (await recordOrphan(log)) counters.waivedOrOrphans += 1;
    return;
  }

  const telemetry = {
    newapiQuota: quotaFromLog(log),
    newapiPromptTokens: log.inputTokens,
    newapiCompletionTokens: log.outputTokens,
    newapiTokenName: logTokenName(log),
  };
  if (row.status === 'settled') {
    await reconcileSettled(row, log, telemetry);
    return;
  }
  if (row.status === 'open' || row.status === 'pending_backfill') {
    await db()
      .update(requestLedger)
      .set({ ...telemetry, updatedAt: new Date() })
      .where(eq(requestLedger.id, row.id));
    await settleByNewapiRequestId(log.requestId, {
      buckets: normalizeBackfillUsage(log),
      usageSource: 'log_backfill',
    });
    return;
  }
  if (row.status === 'failed_unbilled') {
    const firstWaiver = row.reconcileStatus !== 'waived_by_failure';
    await db()
      .update(requestLedger)
      .set({
        ...telemetry,
        reconcileStatus: 'waived_by_failure',
        reconciledAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(requestLedger.id, row.id));
    if (firstWaiver) counters.waivedOrOrphans += 1;
  }
}

async function updateWatermarkMonotonic(end: number) {
  await db()
    .update(gatewayJobLock)
    .set({ reconcileWatermarkAt: new Date(end) })
    .where(
      and(
        eq(gatewayJobLock.id, LOCK_ID),
        or(
          isNull(gatewayJobLock.reconcileWatermarkAt),
          lt(gatewayJobLock.reconcileWatermarkAt, new Date(end))
        )
      )
    );
}

export async function runReconcileSyncOnce(
  deps: {
    client?: any;
    keepAlive?: () => Promise<boolean>;
    now?: () => number;
    sliceMs?: number;
    slicePageLimit?: number;
    maxSlicesPerRun?: number;
  } = {}
): Promise<{ processed: number; truncated: boolean }> {
  const { createNewApiClient } = await import(
    '@/features/newapi-bridge/server/client'
  );
  const { bindingToUserCredentials } = await import(
    '@/features/newapi-bridge/server/portal'
  );
  const client = deps.client ?? createNewApiClient();
  const keepAlive = deps.keepAlive ?? (async () => true);
  const now = deps.now?.() ?? Date.now();
  const sliceMs = deps.sliceMs ?? DEFAULT_SLICE_MS;
  const pageLimit = deps.slicePageLimit ?? DEFAULT_SLICE_PAGE_LIMIT;
  const maxSlices = deps.maxSlicesPerRun ?? DEFAULT_MAX_SLICES_PER_RUN;
  const counters = { waivedOrOrphans: 0 };
  let processed = 0;

  const [lockRow] = await db()
    .select({ watermark: gatewayJobLock.reconcileWatermarkAt })
    .from(gatewayJobLock)
    .where(eq(gatewayJobLock.id, LOCK_ID))
    .limit(1);
  let currentWatermark =
    lockRow?.watermark?.getTime() ?? now - DEFAULT_LOOKBACK_MS;
  const queue: Slice[] = [];
  for (let start = currentWatermark - OVERLAP_MS; start < now; ) {
    const end = Math.min(start + sliceMs, now);
    queue.push({ start, end });
    start = end;
  }

  const processLogs = async (logs: UsageLog[]) => {
    for (const log of logs) {
      if (!(await keepAlive())) return false;
      await processUsageLog(log, counters);
      processed += 1;
    }
    return true;
  };

  const processFallback = async (slice: Slice): Promise<SliceResult> => {
    const bindings = await db()
      .select()
      .from(newApiUserBinding)
      .where(eq(newApiUserBinding.status, 'active'));
    for (const binding of bindings) {
      const credentials = bindingToUserCredentials(binding);
      for (let page = 1; ; page += 1) {
        if (!(await keepAlive())) return 'lost_lock';
        if (page === pageLimit + 1) {
          console.error('[reconcile] reconcile_slice_overflow', slice);
          if (slice.end - slice.start > 1000) return 'overflow';
        }
        const result = await client.listUserUsageLogsPage(credentials, {
          page,
          startTimestamp: Math.floor(slice.start / 1000),
          endTimestamp: Math.ceil(slice.end / 1000),
        });
        if (!(await processLogs(result.logs))) return 'lost_lock';
        if (!result.full) break;
      }
    }
    return 'complete';
  };

  const processSlice = async (slice: Slice): Promise<SliceResult> => {
    try {
      for (let page = 1; ; page += 1) {
        if (!(await keepAlive())) return 'lost_lock';
        if (page === pageLimit + 1) {
          console.error('[reconcile] reconcile_slice_overflow', slice);
          if (slice.end - slice.start > 1000) return 'overflow';
        }
        const result = await client.listAdminUsageLogsPage({
          page,
          startTimestamp: Math.floor(slice.start / 1000),
          endTimestamp: Math.ceil(slice.end / 1000),
        });
        if (!(await processLogs(result.logs))) return 'lost_lock';
        if (!result.full) return 'complete';
      }
    } catch (error) {
      console.warn('[reconcile] admin logs unavailable, using user fallback', {
        error: String(error),
      });
      return processFallback(slice);
    }
  };

  let completedSlices = 0;
  while (queue.length > 0 && completedSlices < maxSlices) {
    const slice = queue.shift()!;
    const result = await processSlice(slice);
    if (result === 'lost_lock') {
      return { processed, truncated: true };
    }
    if (result === 'overflow') {
      const middle = Math.floor((slice.start + slice.end) / 2);
      queue.unshift(
        { start: slice.start, end: middle },
        { start: middle, end: slice.end }
      );
      continue;
    }
    currentWatermark = Math.max(currentWatermark, slice.end);
    await updateWatermarkMonotonic(currentWatermark);
    completedSlices += 1;
  }

  if (counters.waivedOrOrphans > WAIVED_ALERT_THRESHOLD) {
    console.error('[reconcile] waived_by_failure_high', {
      count: counters.waivedOrOrphans,
    });
  }
  return { processed, truncated: queue.length > 0 };
}

export async function runWalletInvariantCheckOnce(): Promise<{
  broken: string[];
}> {
  const accounts = await db().select().from(walletAccount);
  const entries = await db().select().from(walletLedger);
  const sums = new Map<string, number>();
  for (const entry of entries) {
    sums.set(
      entry.userId,
      (sums.get(entry.userId) ?? 0) + entry.signedAmountMicroUsd
    );
  }
  const broken = accounts
    .filter(
      (account: typeof walletAccount.$inferSelect) =>
        account.balanceMicroUsd !== (sums.get(account.userId) ?? 0)
    )
    .map((account: typeof walletAccount.$inferSelect) => account.userId);
  if (broken.length > 0) {
    console.error('[reconcile] wallet_invariant_broken', { broken });
  }
  return { broken };
}
