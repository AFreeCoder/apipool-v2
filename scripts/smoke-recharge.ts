#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { and, eq } from 'drizzle-orm';

import { db } from '@/core/db';
import {
  credit,
  order as orderTable,
  walletAccount,
  walletLedger,
} from '@/config/db/schema';
import { applyManualAdjustment } from '@/features/wallet/server/ledger';
import { PaymentStatus, PaymentType } from '@/extensions/payment/types';
import {
  createOrder,
  findOrderByOrderNo,
  OrderStatus,
} from '@/shared/models/order';
import { findUserById } from '@/shared/models/user';
import { handleCheckoutSuccess } from '@/shared/services/payment';

function requiredEnv(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function invariant(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(`recharge smoke invariant failed: ${message}`);
}

export async function main() {
  invariant(
    process.env.WALLET_LEDGER_WRITE_ENABLED === 'true',
    'WALLET_LEDGER_WRITE_ENABLED must be true'
  );
  const userId = requiredEnv('APIPOOL_SMOKE_PORTAL_USER_ID');
  const user = await findUserById(userId);
  invariant(user, `smoke user not found: ${userId}`);

  const amount = Number(process.env.APIPOOL_SMOKE_RECHARGE_CENTS || '100');
  invariant(Number.isSafeInteger(amount) && amount > 0, 'amount must be cents');
  const orderNo = `cutover-recharge-${Date.now()}-${randomUUID()}`;
  const created = await createOrder({
    id: randomUUID(),
    orderNo,
    userId,
    userEmail: user.email,
    status: OrderStatus.CREATED,
    amount,
    currency: 'USD',
    productId: `cutover-smoke-${amount}`,
    paymentType: PaymentType.ONE_TIME,
    paymentInterval: 'one-time',
    paymentProvider: 'cutover-smoke',
    checkoutInfo: '',
    createdAt: new Date(),
    productName: 'Cutover recharge smoke',
    description: 'Controlled internal recharge smoke',
    callbackUrl: '',
    creditsAmount: amount,
    creditsValidDays: 0,
    planName: '',
    paymentProductId: '',
  });
  const session = {
    provider: 'cutover-smoke',
    paymentStatus: PaymentStatus.SUCCESS,
    paymentResult: { id: `fixture-${orderNo}` },
    paymentInfo: {
      paymentAmount: amount,
      paymentCurrency: 'USD',
      paidAt: new Date(),
      transactionId: `fixture-${orderNo}`,
    },
  };

  let cleanupApplied = false;
  try {
    await handleCheckoutSuccess({ order: created, session });
    const paid = await findOrderByOrderNo(orderNo);
    invariant(paid?.status === OrderStatus.PAID, 'order must be PAID');

    const rechargeRows = await db()
      .select()
      .from(walletLedger)
      .where(
        and(
          eq(walletLedger.orderNo, orderNo),
          eq(walletLedger.entryType, 'recharge')
        )
      );
    invariant(rechargeRows.length === 1, 'order must have exactly one recharge');
    const expectedMicroUsd = amount * 10_000;
    invariant(
      rechargeRows[0].signedAmountMicroUsd === expectedMicroUsd,
      `amount * 10_000 mismatch: ${rechargeRows[0].signedAmountMicroUsd}`
    );
    const creditRows = await db()
      .select({ id: credit.id })
      .from(credit)
      .where(eq(credit.orderNo, orderNo));
    invariant(creditRows.length === 0, 'wallet mode must not write credit');

    const allEntries = await db()
      .select({ signed: walletLedger.signedAmountMicroUsd })
      .from(walletLedger)
      .where(eq(walletLedger.userId, userId));
    const [account] = await db()
      .select()
      .from(walletAccount)
      .where(eq(walletAccount.userId, userId));
    invariant(
      account.balanceMicroUsd ===
        allEntries.reduce(
          (sum: number, entry: { signed: number }) => sum + entry.signed,
          0
        ),
      'wallet balance must equal ledger sum'
    );

    await handleCheckoutSuccess({ order: created, session });
    const replayRows = await db()
      .select({ id: walletLedger.id })
      .from(walletLedger)
      .where(
        and(
          eq(walletLedger.orderNo, orderNo),
          eq(walletLedger.entryType, 'recharge')
        )
      );
    invariant(replayRows.length === 1, 'replay must remain idempotent');
    const [afterReplay] = await db()
      .select()
      .from(walletAccount)
      .where(eq(walletAccount.userId, userId));
    invariant(
      afterReplay.balanceMicroUsd === account.balanceMicroUsd,
      'replay must not change balance'
    );

    await applyManualAdjustment({
      userId,
      signedAmountMicroUsd: -expectedMicroUsd,
      reason: `recharge smoke cleanup for ${orderNo}`,
      operatorUserId: userId,
      idempotencyKey: `smoke-recharge-cleanup:${orderNo}`,
      audit: {
        action: 'wallet.manual_adjustment',
        targetType: 'wallet_account',
        targetId: userId,
        beforeJson: { orderNo, smokeRechargeMicroUsd: expectedMicroUsd },
        afterJson: { cleanup: true },
      },
    });
    cleanupApplied = true;
    console.log(
      `Recharge smoke passed: order=${orderNo}, recharge=${expectedMicroUsd} micro-USD, credit=0, replay=idempotent, cleanup=manual_adjustment`
    );
  } catch (error) {
    if (!cleanupApplied) {
      const [recharge] = await db()
        .select({ amount: walletLedger.signedAmountMicroUsd })
        .from(walletLedger)
        .where(
          and(
            eq(walletLedger.orderNo, orderNo),
            eq(walletLedger.entryType, 'recharge')
          )
        )
        .limit(1);
      if (recharge?.amount) {
        await applyManualAdjustment({
          userId,
          signedAmountMicroUsd: -recharge.amount,
          reason: `failed recharge smoke cleanup for ${orderNo}`,
          operatorUserId: userId,
          idempotencyKey: `smoke-recharge-cleanup:${orderNo}`,
          audit: {
            action: 'wallet.manual_adjustment',
            targetType: 'wallet_account',
            targetId: userId,
            afterJson: { cleanup: true, failedSmoke: true },
          },
        }).catch(() => undefined);
      }
    }
    await db()
      .update(orderTable)
      .set({ description: 'Controlled internal recharge smoke failed' })
      .where(eq(orderTable.orderNo, orderNo))
      .catch(() => undefined);
    throw error;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(error?.message || error);
    process.exit(1);
  });
}
