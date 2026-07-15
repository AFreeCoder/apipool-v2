import 'server-only';

import { and, eq, isNotNull, isNull } from 'drizzle-orm';

import { db } from '@/core/db';
import { walletAccount } from '@/config/db/schema';
import { recordPortalAdminAudit } from '@/shared/models/portal-admin-audit';

export async function freezeWallet(input: {
  userId: string;
  reason: 'overdraft_auto' | 'manual' | 'refund_in_progress';
  frozenBy: string;
}): Promise<boolean> {
  const [row] = await db()
    .update(walletAccount)
    .set({
      frozenAt: new Date(),
      freezeReason: input.reason,
      frozenBy: input.frozenBy,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(walletAccount.userId, input.userId),
        isNull(walletAccount.frozenAt)
      )
    )
    .returning();
  return Boolean(row);
}

export async function unfreezeWallet(input: {
  userId: string;
  operatorUserId: string;
  reason: string;
}): Promise<boolean> {
  if (!input.reason.trim()) throw new Error('unfreeze requires reason');
  const [row] = await db()
    .update(walletAccount)
    .set({
      frozenAt: null,
      freezeReason: null,
      frozenBy: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(walletAccount.userId, input.userId),
        isNotNull(walletAccount.frozenAt)
      )
    )
    .returning();
  if (row) {
    await recordPortalAdminAudit({
      action: 'wallet.unfreeze',
      operatorUserId: input.operatorUserId,
      targetType: 'wallet_account',
      targetId: input.userId,
      reason: input.reason,
    });
  }
  return Boolean(row);
}
