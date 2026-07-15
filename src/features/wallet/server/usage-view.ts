import 'server-only';

import { and, desc, eq, gte } from 'drizzle-orm';

import {
  requestLedger,
  walletAccount,
  walletLedger,
} from '@/config/db/schema';
import { db } from '@/core/db';

export type WalletUsageRange = '7d' | '30d' | 'month';

function rangeStart(range: WalletUsageRange, now = new Date()) {
  if (range === 'month') {
    return new Date(now.getFullYear(), now.getMonth(), 1);
  }
  return new Date(
    now.getTime() - (range === '30d' ? 30 : 7) * 24 * 60 * 60 * 1_000
  );
}

function microUsdToUsd(value: number) {
  return Number((value / 1_000_000).toFixed(6));
}

function inputTokenCount(row: typeof requestLedger.$inferSelect) {
  const values = [
    row.uncachedInputTokens,
    row.cachedReadTokens,
    row.cacheWrite5mTokens,
    row.cacheWrite1hTokens,
  ];
  if (values.every((value) => value === null)) return null;
  return values.reduce<number>((sum, value) => sum + (value ?? 0), 0);
}

function displayStatus(
  status: string
): 'settled' | 'billing' | 'failed_unbilled' {
  if (status === 'settled') return 'settled';
  if (status === 'open' || status === 'pending_backfill') return 'billing';
  return 'failed_unbilled';
}

export async function getWalletUsageView(
  userId: string,
  range: WalletUsageRange
): Promise<{
  summary: {
    balanceUsd: number;
    requestCount: number;
    inputTokens: number;
    outputTokens: number;
    spendUsd: number;
    byModel: {
      modelId: string;
      requestCount: number;
      spendUsd: number;
    }[];
    status: 'ok';
    syncedAt: string;
  };
  logs: {
    id: string;
    modelId: string;
    status: 'settled' | 'billing' | 'failed_unbilled';
    chargedUsd: number | null;
    inputTokens: number | null;
    outputTokens: number | null;
    createdAt: string;
  }[];
}> {
  const [[account], rows] = await Promise.all([
    db()
      .select()
      .from(walletAccount)
      .where(eq(walletAccount.userId, userId))
      .limit(1),
    db()
      .select()
      .from(requestLedger)
      .where(
        and(
          eq(requestLedger.userId, userId),
          gte(requestLedger.createdAt, rangeStart(range))
        )
      )
      .orderBy(desc(requestLedger.createdAt)),
  ]);
  const userRows = rows;
  const byModel = new Map<
    string,
    { modelId: string; requestCount: number; spendMicroUsd: number }
  >();
  let inputTokens = 0;
  let outputTokens = 0;
  let spendMicroUsd = 0;
  for (const row of userRows) {
    inputTokens += inputTokenCount(row) ?? 0;
    outputTokens += row.outputTokens ?? 0;
    const charged =
      row.status === 'settled' ? (row.chargedMicroUsd ?? 0) : 0;
    spendMicroUsd += charged;
    const aggregate = byModel.get(row.portalModelId) ?? {
      modelId: row.portalModelId,
      requestCount: 0,
      spendMicroUsd: 0,
    };
    aggregate.requestCount += 1;
    aggregate.spendMicroUsd += charged;
    byModel.set(row.portalModelId, aggregate);
  }

  return {
    summary: {
      balanceUsd: microUsdToUsd(account?.balanceMicroUsd ?? 0),
      requestCount: userRows.length,
      inputTokens,
      outputTokens,
      spendUsd: microUsdToUsd(spendMicroUsd),
      byModel: [...byModel.values()]
        .sort((left, right) => left.modelId.localeCompare(right.modelId))
        .map(({ modelId, requestCount, spendMicroUsd: modelSpend }) => ({
          modelId,
          requestCount,
          spendUsd: microUsdToUsd(modelSpend),
        })),
      status: 'ok',
      syncedAt: new Date().toISOString(),
    },
    logs: userRows.map((row: typeof requestLedger.$inferSelect) => ({
      id: row.id,
      modelId: row.portalModelId,
      status: displayStatus(row.status),
      chargedUsd:
        row.status === 'settled' && row.chargedMicroUsd !== null
          ? microUsdToUsd(row.chargedMicroUsd)
          : null,
      inputTokens: inputTokenCount(row),
      outputTokens: row.outputTokens,
      createdAt: row.createdAt.toISOString(),
    })),
  };
}

export async function getWalletBillingView(userId: string): Promise<{
  balance: { balanceUsd: number; frozen: boolean };
  ledger: {
    id: string;
    entryType: string;
    signedAmountUsd: number;
    balanceAfterUsd: number;
    orderNo: string | null;
    reason: string | null;
    createdAt: string;
  }[];
}> {
  const [[account], rows] = await Promise.all([
    db()
      .select()
      .from(walletAccount)
      .where(eq(walletAccount.userId, userId))
      .limit(1),
    db()
      .select()
      .from(walletLedger)
      .where(eq(walletLedger.userId, userId))
      .orderBy(desc(walletLedger.createdAt)),
  ]);
  return {
    balance: {
      balanceUsd: microUsdToUsd(account?.balanceMicroUsd ?? 0),
      frozen: Boolean(account?.frozenAt),
    },
    ledger: rows.map((row: typeof walletLedger.$inferSelect) => ({
      id: row.id,
      entryType: row.entryType,
      signedAmountUsd: microUsdToUsd(row.signedAmountMicroUsd),
      balanceAfterUsd: microUsdToUsd(row.balanceAfterMicroUsd),
      orderNo: row.orderNo,
      reason: row.reason,
      createdAt: row.createdAt.toISOString(),
    })),
  };
}
