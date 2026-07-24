import 'server-only';

import { eq, sql } from 'drizzle-orm';

import { walletAccount, walletLedger } from '@/config/db/schema';
import { db } from '@/core/db';
import { getUuid } from '@/shared/lib/hash';

export type WalletEntryType =
  | 'recharge'
  | 'request_charge'
  | 'manual_adjustment';

const SIGN_OK: Record<WalletEntryType, (amount: number) => boolean> = {
  recharge: (amount) => amount > 0,
  request_charge: (amount) => amount < 0,
  manual_adjustment: (amount) => amount !== 0,
};

export async function ensureWalletAccount(
  userId: string,
  tx: any = db()
): Promise<void> {
  await tx.insert(walletAccount).values({ userId }).onConflictDoNothing();
}

export async function getWalletAccount(userId: string): Promise<any | null> {
  const [row] = await db()
    .select()
    .from(walletAccount)
    .where(eq(walletAccount.userId, userId))
    .limit(1);
  return row ?? null;
}

export async function appendLedgerEntryInTx(
  tx: any,
  entry: {
    userId: string;
    entryType: WalletEntryType;
    signedAmountMicroUsd: number;
    requestLedgerId?: string;
    orderNo?: string;
    idempotencyKey?: string;
    operatorUserId?: string;
    reason?: string;
  }
): Promise<{ ledgerId: string; balanceAfterMicroUsd: number }> {
  const amount = entry.signedAmountMicroUsd;
  if (!Number.isSafeInteger(amount)) {
    throw new Error('wallet amount exceeds safe integer');
  }
  if (!SIGN_OK[entry.entryType](amount)) {
    throw new Error(`invalid sign for ${entry.entryType}: ${amount}`);
  }
  if (
    entry.entryType === 'manual_adjustment' &&
    (!entry.reason || !entry.operatorUserId)
  ) {
    throw new Error('manual_adjustment requires reason and operatorUserId');
  }

  const [account] = await tx
    .update(walletAccount)
    .set({
      balanceMicroUsd: sql`${walletAccount.balanceMicroUsd} + ${amount}`,
      updatedAt: new Date(),
    })
    .where(eq(walletAccount.userId, entry.userId))
    .returning();
  if (!account) throw new Error(`wallet account missing for ${entry.userId}`);

  const ledgerId = getUuid();
  await tx.insert(walletLedger).values({
    id: ledgerId,
    userId: entry.userId,
    entryType: entry.entryType,
    signedAmountMicroUsd: amount,
    balanceAfterMicroUsd: account.balanceMicroUsd,
    requestLedgerId: entry.requestLedgerId,
    orderNo: entry.orderNo,
    idempotencyKey: entry.idempotencyKey,
    operatorUserId: entry.operatorUserId,
    reason: entry.reason,
  });
  return {
    ledgerId,
    balanceAfterMicroUsd: account.balanceMicroUsd as number,
  };
}

export class IdempotencyConflictError extends Error {}

function isSqliteBusy(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /SQLITE_BUSY|database is locked/i.test(message);
}

async function waitForRetry(attempt: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, Math.min(5 * 2 ** attempt, 80));
  });
}

export async function applyManualAdjustment(input: {
  userId: string;
  signedAmountMicroUsd: number;
  reason: string;
  operatorUserId: string;
  idempotencyKey: string;
  audit?: {
    action: string;
    targetType: string;
    targetId?: string;
    beforeJson?: unknown;
    afterJson?: unknown;
  };
}): Promise<{
  ledgerId: string;
  balanceAfterMicroUsd: number;
  alreadyApplied: boolean;
}> {
  const readBack = async () => {
    const [row] = await db()
      .select()
      .from(walletLedger)
      .where(eq(walletLedger.idempotencyKey, input.idempotencyKey))
      .limit(1);
    if (!row) return undefined;
    const payloadMatches =
      row.userId === input.userId &&
      row.signedAmountMicroUsd === input.signedAmountMicroUsd &&
      row.reason === input.reason &&
      row.operatorUserId === input.operatorUserId;
    if (!payloadMatches) {
      throw new IdempotencyConflictError(
        `idempotency key ${input.idempotencyKey} was used with a different payload`
      );
    }
    return row;
  };

  const existing = await readBack();
  if (existing) {
    return {
      ledgerId: existing.id,
      balanceAfterMicroUsd: existing.balanceAfterMicroUsd,
      alreadyApplied: true,
    };
  }

  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      const result = await db().transaction(async (tx: any) => {
        await ensureWalletAccount(input.userId, tx);
        const entry = await appendLedgerEntryInTx(tx, {
          userId: input.userId,
          entryType: 'manual_adjustment',
          signedAmountMicroUsd: input.signedAmountMicroUsd,
          reason: input.reason,
          operatorUserId: input.operatorUserId,
          idempotencyKey: input.idempotencyKey,
        });
        if (input.audit) {
          const { recordPortalAdminAudit } = await import(
            '@/shared/models/portal-admin-audit'
          );
          await recordPortalAdminAudit(
            {
              ...input.audit,
              operatorUserId: input.operatorUserId,
              reason: input.reason,
            },
            tx
          );
        }
        return entry;
      });
      return { ...result, alreadyApplied: false };
    } catch (error) {
      const row = await readBack();
      if (row) {
        return {
          ledgerId: row.id,
          balanceAfterMicroUsd: row.balanceAfterMicroUsd,
          alreadyApplied: true,
        };
      }
      if (isSqliteBusy(error) && attempt < 4) {
        await waitForRetry(attempt);
        continue;
      }
      throw error;
    }
  }
  throw new Error('manual adjustment retry exhausted');
}

export async function reverseRequestCharge(input: {
  walletLedgerId: string;
  operatorUserId: string;
}): Promise<{ ledgerId: string; alreadyApplied: boolean }> {
  const [original] = await db()
    .select()
    .from(walletLedger)
    .where(eq(walletLedger.id, input.walletLedgerId))
    .limit(1);
  if (!original || original.entryType !== 'request_charge') {
    throw new Error('target is not a request_charge entry');
  }
  return applyManualAdjustment({
    userId: original.userId,
    signedAmountMicroUsd: Math.abs(original.signedAmountMicroUsd),
    reason: `reverse:${original.id}`,
    operatorUserId: input.operatorUserId,
    idempotencyKey: `reverse:${original.id}`,
    audit: {
      action: 'wallet.adjust',
      targetType: 'wallet_account',
      targetId: original.userId,
      afterJson: {
        reverseWalletLedgerId: original.id,
        signedAmountMicroUsd: Math.abs(original.signedAmountMicroUsd),
      },
    },
  });
}
