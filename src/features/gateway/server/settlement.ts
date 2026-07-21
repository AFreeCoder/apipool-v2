import 'server-only';

import {
  computeChargeMicroUsd,
  priceVectorFromRatesJson,
  type UsageBuckets,
} from '@/features/gateway/lib/billing';
import { gatewayConfig } from '@/features/gateway/lib/config';
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
  buckets: UsageBuckets;
  usageSource: 'response' | 'log_backfill';
}

export type SettleResult = 'settled' | 'already_finalized' | 'not_found';

class SettleConflict extends Error {}

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

  const charged = computeChargeMicroUsd(
    usage.buckets,
    priceVectorFromRatesJson(price.ratesJson)
  );
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
          uncachedInputTokens: usage.buckets.uncachedInput,
          cachedReadTokens: usage.buckets.cachedRead,
          cacheWrite5mTokens: usage.buckets.cacheWrite5m,
          cacheWrite1hTokens: usage.buckets.cacheWrite1h,
          outputTokens: usage.buckets.output,
          reasoningTokens: usage.buckets.reasoning,
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
