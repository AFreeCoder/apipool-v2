import 'server-only';

import {
  computePerCallChargeMicroUsd,
  computeTokenChargeMicroUsd,
  type RatesMap,
} from '@/features/gateway/lib/billing';
import { gatewayConfig } from '@/features/gateway/lib/config';
import type {
  BillingScheme,
  MeterKey,
  MeterQuantities,
} from '@/features/gateway/lib/meters';
import {
  appendLedgerEntryInTx,
  ensureWalletAccount,
} from '@/features/wallet/server/ledger';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';

import { db } from '@/core/db';
import {
  modelPriceVersion,
  requestLedger,
  walletAccount,
} from '@/config/db/schema';

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
  usage: SettlementUsage
): Promise<SettleResult> {
  const [ledger] = await db()
    .select()
    .from(requestLedger)
    .where(eq(requestLedger.id, ledgerId))
    .limit(1);
  if (!ledger) return 'not_found';
  return settleRow(ledger, usage);
}

export async function settleByNewapiRequestId(
  newapiRequestId: string,
  usage: SettlementUsage
): Promise<SettleResult> {
  const [ledger] = await db()
    .select()
    .from(requestLedger)
    .where(eq(requestLedger.newapiRequestId, newapiRequestId))
    .limit(1);
  if (!ledger) return 'not_found';
  return settleRow(ledger, usage);
}

async function settleRow(
  ledger: any,
  usage: SettlementUsage
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

  const billingScheme = price.billingScheme as BillingScheme;
  const flags = [...new Set(usage.flags)];
  let charged: bigint;
  let skuKey: string | null = null;
  let unitCount: number | null = null;
  if (billingScheme === 'token') {
    const rates = parsePriceMap(price.ratesJson, '价格 rates_json') as RatesMap;
    const result = computeTokenChargeMicroUsd(usage.meters, rates, {
      webSearchCount: usage.webSearchCount,
      webSearchPriceMicroUsd: rates.web_search ?? null,
    });
    charged = result.charged;
    for (const meter of result.unpricedMeters) {
      flags.push(`unpriced:${meter}`);
    }
    if (usage.webSearchCount > 0 && rates.web_search === undefined) {
      flags.push('unpriced:web_search');
    }
  } else if (billingScheme === 'per_call') {
    const tiers = parsePriceMap(price.tiersJson, '价格 tiers_json');
    skuKey = usage.skuKey ?? 'default';
    unitCount = usage.unitCount ?? 0;
    if (!Number.isSafeInteger(unitCount) || unitCount <= 0) {
      throw new Error('per_call 结算需要正整数 unitCount');
    }
    const tierPrice = tiers[skuKey];
    if (!Number.isSafeInteger(tierPrice) || tierPrice <= 0) {
      throw new Error(`per_call 结算缺少 SKU 价格：${skuKey}`);
    }
    charged = computePerCallChargeMicroUsd(unitCount, tierPrice);
  } else {
    throw new Error(`不支持的计费方案：${price.billingScheme}`);
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
      return 'settled' as const;
    });
  } catch (error) {
    if (error instanceof SettleConflict) return 'already_finalized';
    throw error;
  }
}
