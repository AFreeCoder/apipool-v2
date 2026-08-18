import 'server-only';

import { and, eq, inArray, isNull, sql } from 'drizzle-orm';

import {
  modelPriceVersion,
  requestLedger,
  walletAccount,
} from '@/config/db/schema';
import { db } from '@/core/db';
import { gatewayConfig } from '@/features/gateway/lib/config';
import type { MeterKey, MeterQuantities } from '@/features/gateway/lib/meters';
import {
  computePricingCharge,
  legacyBillingSchemeForBasis,
  parsePricingSpec,
} from '@/features/gateway/lib/pricing-spec';
import {
  appendLedgerEntryInTx,
  ensureWalletAccount,
} from '@/features/wallet/server/ledger';

export interface SettlementUsage {
  meters: MeterQuantities;
  flags: string[];
  webSearchCount: number;
  rawUsage: unknown;
  usageSource: 'response' | 'log_backfill';
  skuKey?: string;
  unitCount?: number;
}

export type SettleResult = 'settled' | 'already_finalized' | 'not_found';

export interface SettlementOptions {
  onSettled?: (tx: any) => Promise<void>;
}

class SettleConflict extends Error {}

const LEDGER_METER_COLUMNS = {
  uncachedInputTokens: ['input', 'input_long'],
  cachedReadTokens: ['cached_input', 'cached_input_long'],
  cacheWriteTokens: ['cache_write', 'cache_write_long'],
  cacheWrite5mTokens: ['cache_write_5m'],
  cacheWrite1hTokens: ['cache_write_1h'],
  outputTokens: ['output', 'output_long'],
  imageInputTokens: ['image_input'],
  cachedImageInputTokens: ['cached_image_input'],
  imageOutputTokens: ['image_output'],
} as const satisfies Record<string, readonly MeterKey[]>;

function quantity(meters: MeterQuantities, ...keys: MeterKey[]) {
  return keys.reduce((total, key) => total + (meters[key] ?? 0), 0);
}

function ledgerMeterColumns(meters: MeterQuantities) {
  return Object.fromEntries(
    Object.entries(LEDGER_METER_COLUMNS).map(([column, keys]) => [
      column,
      quantity(meters, ...keys),
    ])
  ) as Record<keyof typeof LEDGER_METER_COLUMNS, number>;
}

function reasoningTokens(rawUsage: unknown): number {
  if (!rawUsage || typeof rawUsage !== 'object') return 0;
  const usage = rawUsage as Record<string, unknown>;
  for (const key of ['completion_tokens_details', 'output_tokens_details']) {
    const details = usage[key];
    if (!details || typeof details !== 'object') continue;
    const value = (details as Record<string, unknown>).reasoning_tokens;
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
      return value;
    }
  }
  return 0;
}

function serializeRawUsage(rawUsage: unknown): string {
  try {
    return JSON.stringify(rawUsage ?? null);
  } catch (error) {
    throw new Error('原始 usage 凭证无法序列化', { cause: error });
  }
}

export async function settleByLedgerId(
  ledgerId: string,
  usage: SettlementUsage,
  options: SettlementOptions = {}
): Promise<SettleResult> {
  const [ledger] = await db()
    .select()
    .from(requestLedger)
    .where(eq(requestLedger.id, ledgerId))
    .limit(1);
  if (!ledger) return 'not_found';
  return settleRow(ledger, usage, options);
}

export async function settleByNewapiRequestId(
  newapiRequestId: string,
  usage: SettlementUsage,
  options: SettlementOptions = {}
): Promise<SettleResult> {
  const [ledger] = await db()
    .select()
    .from(requestLedger)
    .where(eq(requestLedger.newapiRequestId, newapiRequestId))
    .limit(1);
  if (!ledger) return 'not_found';
  return settleRow(ledger, usage, options);
}

async function settleRow(
  ledger: any,
  usage: SettlementUsage,
  options: SettlementOptions
): Promise<SettleResult> {
  if (ledger.status === 'settled' || ledger.status === 'failed_unbilled') {
    return 'already_finalized';
  }
  if (!ledger.newapiRequestId) {
    throw new Error(
      `settlement requires captured newapi_request_id (ledger ${ledger.id})`
    );
  }
  const [price] = await db()
    .select()
    .from(modelPriceVersion)
    .where(eq(modelPriceVersion.id, ledger.priceVersionId))
    .limit(1);
  if (!price) throw new Error(`price version ${ledger.priceVersionId} missing`);

  const pricingSpec = parsePricingSpec(price.pricingSpecJson);
  const billingScheme = legacyBillingSchemeForBasis(pricingSpec.basis);
  const flags = [...new Set(usage.flags)];
  let charged: bigint;
  let skuKey: string | null = null;
  let unitCount: number | null = null;
  if (pricingSpec.basis !== 'token') {
    skuKey = usage.skuKey ?? 'default';
    unitCount = usage.unitCount ?? 0;
  }
  const computed = computePricingCharge(pricingSpec, {
    meters: usage.meters,
    webSearchCount: usage.webSearchCount,
    skuKey,
    quantity: unitCount,
  });
  charged = computed.charged;
  for (const meter of computed.unpricedMeters) {
    flags.push(`unpriced:${meter}`);
  }
  if (charged > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('charge exceeds safe integer');
  }
  const chargedNumber = Number(charged);
  const freezeThreshold = gatewayConfig().overdraftFreezeMicroUsd;
  const now = new Date();

  try {
    return await db().transaction(async (tx: any) => {
      const [updated] = await tx
        .update(requestLedger)
        .set({
          status: 'settled',
          billingScheme,
          pricingBasis: pricingSpec.basis,
          quantityMeter: pricingSpec.quantityMeter ?? null,
          ...ledgerMeterColumns(usage.meters),
          reasoningTokens: reasoningTokens(usage.rawUsage),
          skuKey,
          unitCount,
          longContextApplied: Object.keys(usage.meters).some((key) =>
            key.endsWith('_long')
          ),
          billingFlagsJson:
            flags.length > 0 ? JSON.stringify([...new Set(flags)]) : null,
          rawUsageJson: serializeRawUsage(usage.rawUsage),
          webSearchCount: usage.webSearchCount,
          usageSource: usage.usageSource,
          chargedMicroUsd: chargedNumber,
          settledAt: now,
          updatedAt: now,
        })
        .where(
          and(
            eq(requestLedger.id, ledger.id),
            inArray(requestLedger.status, ['open', 'pending_backfill'])
          )
        )
        .returning();
      if (!updated) throw new SettleConflict();

      await ensureWalletAccount(ledger.userId, tx);
      await appendLedgerEntryInTx(tx, {
        userId: ledger.userId,
        entryType: 'request_charge',
        signedAmountMicroUsd: -chargedNumber,
        requestLedgerId: ledger.id,
      });

      await tx
        .update(walletAccount)
        .set({
          frozenAt: now,
          freezeReason: 'overdraft_auto',
          frozenBy: 'system',
          updatedAt: now,
        })
        .where(
          and(
            eq(walletAccount.userId, ledger.userId),
            isNull(walletAccount.frozenAt),
            sql`${walletAccount.balanceMicroUsd} < ${-freezeThreshold}`
          )
        );
      await options.onSettled?.(tx);
      return 'settled' as const;
    });
  } catch (error) {
    if (error instanceof SettleConflict) return 'already_finalized';
    throw error;
  }
}
