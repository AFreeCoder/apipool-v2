import 'server-only';

import {
  computePerCallChargeMicroUsd,
  computeTokenChargeMicroUsd,
  type RatesMap,
} from '@/features/gateway/lib/billing';
import type {
  BillingScheme,
  MeterKey,
  MeterQuantities,
} from '@/features/gateway/lib/meters';
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

import { markFailedUnbilled as defaultMarkFailedUnbilled } from './admission';

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
  quota?: number;
  spendUsd?: number;
  createdAt: string;
  [key: string]: unknown;
};

type Slice = { start: number; end: number };
type SliceResult = 'complete' | 'overflow' | 'lost_lock';
type ReconcileCounters = {
  settledByLog: number;
  orphans: number;
  waivedOrOrphans: number;
  flaggedLedgerIds: Set<string>;
};

function quotaFromLog(log: UsageLog): number | null {
  if (
    typeof log.quota === 'number' &&
    Number.isSafeInteger(log.quota) &&
    log.quota >= 0
  ) {
    return log.quota;
  }
  if (log.spendUsd === undefined || !Number.isFinite(log.spendUsd)) {
    return null;
  }
  return Math.round(log.spendUsd * 500_000);
}

function logTokenName(log: UsageLog) {
  return String(log.keyMasked ?? log.tokenName ?? '');
}

function addMeter(
  meters: MeterQuantities,
  key: MeterKey,
  value: number | null
) {
  if (value && value > 0) meters[key] = value;
}

function ledgerMeters(row: typeof requestLedger.$inferSelect): MeterQuantities {
  const meters: MeterQuantities = {};
  const long = row.longContextApplied === true;
  addMeter(meters, long ? 'input_long' : 'input', row.uncachedInputTokens);
  addMeter(
    meters,
    long ? 'cached_input_long' : 'cached_input',
    row.cachedReadTokens
  );
  addMeter(
    meters,
    long ? 'cache_write_long' : 'cache_write',
    row.cacheWriteTokens
  );
  addMeter(meters, 'cache_write_5m', row.cacheWrite5mTokens);
  addMeter(meters, 'cache_write_1h', row.cacheWrite1hTokens);
  addMeter(meters, long ? 'output_long' : 'output', row.outputTokens);
  addMeter(meters, 'image_input', row.imageInputTokens);
  addMeter(meters, 'cached_image_input', row.cachedImageInputTokens);
  addMeter(meters, 'image_output', row.imageOutputTokens);
  return meters;
}

function parsePriceMap(raw: string, label: string): Record<string, number> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${label} 无法解析`, { cause: error });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${label} 必须是对象`);
  }
  const result: Record<string, number> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (!Number.isSafeInteger(value) || Number(value) < 0) {
      throw new Error(`${label} 的 ${key} 不是有效非负整数`);
    }
    result[key] = Number(value);
  }
  return result;
}

function retailExpectedCharge(
  price: typeof modelPriceVersion.$inferSelect,
  row: typeof requestLedger.$inferSelect,
  meters: MeterQuantities
) {
  const billingScheme = price.billingScheme as BillingScheme;
  if (billingScheme === 'token') {
    const rates = parsePriceMap(price.ratesJson, '价格 rates_json') as RatesMap;
    return computeTokenChargeMicroUsd(meters, rates, {
      webSearchCount: row.webSearchCount ?? 0,
      webSearchPriceMicroUsd: rates.web_search ?? null,
    }).charged;
  }
  if (billingScheme === 'per_call') {
    const tiers = parsePriceMap(price.tiersJson, '价格 tiers_json');
    const skuKey = row.skuKey ?? 'default';
    const unitCount = row.unitCount ?? 0;
    const tierPrice = tiers[skuKey];
    if (!Number.isSafeInteger(unitCount) || unitCount <= 0) {
      throw new Error('per_call 对账缺少正整数 unit_count');
    }
    if (!Number.isSafeInteger(tierPrice) || tierPrice <= 0) {
      throw new Error(`per_call 对账缺少 SKU 价格：${skuKey}`);
    }
    return computePerCallChargeMicroUsd(unitCount, tierPrice);
  }
  throw new Error(`不支持的计费方案：${price.billingScheme}`);
}

function referenceExpectedCharge(
  price: typeof modelPriceVersion.$inferSelect,
  row: typeof requestLedger.$inferSelect,
  meters: MeterQuantities
): { charged: bigint | null; missing: string[] } {
  if (price.billingScheme === 'per_call') {
    const tiers = parsePriceMap(
      price.newapiRefTiersJson,
      'New API 参照 tiers_json'
    );
    const skuKey = row.skuKey ?? 'default';
    const tierPrice = tiers[skuKey];
    if (!Number.isSafeInteger(tierPrice) || tierPrice <= 0) {
      return { charged: null, missing: [`per_call:${skuKey}`] };
    }
    const unitCount = row.unitCount ?? 0;
    if (!Number.isSafeInteger(unitCount) || unitCount <= 0) {
      return { charged: null, missing: ['unit_count'] };
    }
    return {
      charged: computePerCallChargeMicroUsd(unitCount, tierPrice),
      missing: [],
    };
  }
  let rates = parsePriceMap(
    price.newapiRefRatesJson,
    'New API 参照 rates_json'
  ) as RatesMap;
  if (Object.keys(rates).length === 0) {
    // 兼容升级前已生成的不可变快照。
    rates = {
      ...(price.newapiRefInputMicroUsdPerM !== null
        ? { input: price.newapiRefInputMicroUsdPerM }
        : {}),
      ...(price.newapiRefCachedInputMicroUsdPerM !== null
        ? { cached_input: price.newapiRefCachedInputMicroUsdPerM }
        : {}),
      ...(price.newapiRefCacheWrite5mMicroUsdPerM !== null
        ? { cache_write_5m: price.newapiRefCacheWrite5mMicroUsdPerM }
        : {}),
      ...(price.newapiRefCacheWrite1hMicroUsdPerM !== null
        ? { cache_write_1h: price.newapiRefCacheWrite1hMicroUsdPerM }
        : {}),
      ...(price.newapiRefOutputMicroUsdPerM !== null
        ? { output: price.newapiRefOutputMicroUsdPerM }
        : {}),
    };
  }
  const missing = (Object.entries(meters) as [MeterKey, number][])
    .filter(([key, quantity]) => quantity > 0 && rates[key] === undefined)
    .map(([key]) => key);
  if ((row.webSearchCount ?? 0) > 0 && rates.web_search === undefined) {
    missing.push('web_search');
  }
  const uniqueMissing = [...new Set(missing)];
  if (uniqueMissing.length > 0) {
    return { charged: null, missing: uniqueMissing };
  }
  return {
    charged: computeTokenChargeMicroUsd(meters, rates, {
      webSearchCount: row.webSearchCount ?? 0,
      webSearchPriceMicroUsd: rates.web_search ?? null,
    }).charged,
    missing: [],
  };
}

const INPUT_METER_KEYS: MeterKey[] = [
  'input',
  'input_long',
  'cached_input',
  'cached_input_long',
  'cache_write',
  'cache_write_long',
  'cache_write_5m',
  'cache_write_1h',
  'image_input',
  'cached_image_input',
];
const OUTPUT_METER_KEYS: MeterKey[] = ['output', 'output_long', 'image_output'];

function meterTotal(meters: MeterQuantities, keys: MeterKey[]) {
  return keys.reduce((total, key) => total + (meters[key] ?? 0), 0);
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

  const meters = ledgerMeters(row);
  const notes: string[] = [];
  const tokenMismatch =
    log.inputTokens !== meterTotal(meters, INPUT_METER_KEYS) ||
    log.outputTokens !== meterTotal(meters, OUTPUT_METER_KEYS);
  const modelMismatch = log.modelId !== row.newapiModelId;
  if (modelMismatch) notes.push('model_mismatch');

  let internalMismatch = false;
  try {
    const internalExpected = Number(retailExpectedCharge(price, row, meters));
    internalMismatch = internalExpected !== row.chargedMicroUsd;
  } catch (error) {
    internalMismatch = true;
    notes.push(`internal_recompute_failed:${String(error)}`);
  }
  if (internalMismatch) notes.push('internal_amount_mismatch');

  const quota = quotaFromLog(log);
  const ref = referenceExpectedCharge(price, row, meters);
  let externalMismatch = false;
  if (ref.missing.length > 0) {
    notes.push(...ref.missing.map((name) => `ref_missing:${name}`));
  } else if (quota === null) {
    notes.push('quota_missing');
  } else {
    const actualMicroUsd = quota * 2;
    const expectedMicroUsd = Number(ref.charged!);
    const tolerance = Math.max(10, Math.ceil(Math.abs(actualMicroUsd) * 0.01));
    externalMismatch = Math.abs(actualMicroUsd - expectedMicroUsd) > tolerance;
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
  counters: ReconcileCounters,
  markFailedUnbilled: typeof defaultMarkFailedUnbilled
) {
  if (!log.requestId) return;
  const [row] = await db()
    .select()
    .from(requestLedger)
    .where(eq(requestLedger.newapiRequestId, log.requestId))
    .limit(1);
  if (!row) {
    if (await recordOrphan(log)) {
      counters.orphans += 1;
      counters.waivedOrOrphans += 1;
    }
    return;
  }
  if (row.billingFlagsJson && row.billingFlagsJson !== '[]') {
    counters.flaggedLedgerIds.add(row.id);
  }

  const telemetry = {
    newapiQuota: quotaFromLog(log),
    newapiPromptTokens: log.inputTokens,
    newapiCompletionTokens: log.outputTokens,
    newapiTokenName: logTokenName(log),
  };
  if (row.status === 'settled') {
    await reconcileSettled(row, log, telemetry);
    counters.settledByLog += 1;
    return;
  }
  if (row.status === 'open' || row.status === 'pending_backfill') {
    const waived = await markFailedUnbilled(row.id, {
      errorCode: 'usage_missing_waived',
      billingScheme: row.billingScheme === 'per_call' ? 'per_call' : 'token',
      billingFlags: ['usage_missing_waived'],
    });
    if (waived) {
      await db()
        .update(requestLedger)
        .set({
          ...telemetry,
          reconcileStatus: 'waived_by_missing_usage',
          reconciledAt: new Date(),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(requestLedger.id, row.id),
            eq(requestLedger.status, 'failed_unbilled')
          )
        );
      counters.waivedOrOrphans += 1;
    } else {
      const [current] = await db()
        .select()
        .from(requestLedger)
        .where(eq(requestLedger.id, row.id))
        .limit(1);
      if (current?.status === 'settled') {
        await reconcileSettled(current, log, telemetry);
        counters.settledByLog += 1;
      }
    }
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
      .where(
        and(
          eq(requestLedger.id, row.id),
          eq(requestLedger.status, 'failed_unbilled')
        )
      );
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
    markFailedUnbilled?: typeof defaultMarkFailedUnbilled;
  } = {}
): Promise<{
  scanned: number;
  settledByLog: number;
  orphans: number;
  flaggedRequests: number;
  truncated: boolean;
}> {
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
  const markFailedUnbilled =
    deps.markFailedUnbilled ?? defaultMarkFailedUnbilled;
  const counters: ReconcileCounters = {
    settledByLog: 0,
    orphans: 0,
    waivedOrOrphans: 0,
    flaggedLedgerIds: new Set<string>(),
  };
  let scanned = 0;

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
      await processUsageLog(log, counters, markFailedUnbilled);
      scanned += 1;
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
      return {
        scanned,
        settledByLog: counters.settledByLog,
        orphans: counters.orphans,
        flaggedRequests: counters.flaggedLedgerIds.size,
        truncated: true,
      };
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
  return {
    scanned,
    settledByLog: counters.settledByLog,
    orphans: counters.orphans,
    flaggedRequests: counters.flaggedLedgerIds.size,
    truncated: queue.length > 0,
  };
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
