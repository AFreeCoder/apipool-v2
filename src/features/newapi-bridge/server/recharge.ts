import 'server-only';

import { eq } from 'drizzle-orm';

import { db } from '@/core/db';
import { apipoolLedgerEntry } from '@/config/db/schema';
import { getUuid } from '@/shared/lib/hash';

import {
  createNewApiClient,
  NewApiBridgeError,
  NewApiClient,
  type NewApiBridgeErrorCode,
} from './client';
import {
  bindingToUserCredentials,
  ensurePortalUserBinding,
  recordAudit,
} from './portal';

// 充值加额执行器（docs/06）：订单 paid 且本地 credit 入账后，
// 通过兑换码把同额 quota 加到 New API。幂等靠 ledger.orderNo 唯一索引；
// 失败绝不抛出（webhook 必须成功返回），留 pending/failed 待重试。

export type RechargeOrderInput = {
  orderNo: string;
  userId: string;
  userEmail?: string | null;
  amount: number; // 美分
  currency: string;
};

export type RechargeResult = {
  outcome:
    | 'applied'
    | 'already_applied'
    | 'pending_retry'
    | 'failed'
    | 'skipped';
  ledgerId?: string;
  detail?: string;
};

// 终态错误重试也无意义，标 failed 等运营介入；其余保持 pending 可重试
const TERMINAL_RECHARGE_ERROR_CODES = new Set<NewApiBridgeErrorCode>([
  'unauthorized',
  'forbidden',
  'malformed_response',
]);

function toAmountUsd(amountCents: number) {
  return amountCents / 100;
}

async function findLedgerByOrderNo(orderNo: string) {
  const [row] = await db()
    .select()
    .from(apipoolLedgerEntry)
    .where(eq(apipoolLedgerEntry.orderNo, orderNo))
    .limit(1);
  return row;
}

async function executeRecharge(
  ledgerId: string,
  input: RechargeOrderInput,
  client: NewApiClient
): Promise<RechargeResult> {
  const amountUsd = toAmountUsd(input.amount);
  try {
    const binding = await ensurePortalUserBinding(
      { id: input.userId, email: input.userEmail || '' },
      client
    );
    const remote = await client.adjustQuota({
      user: bindingToUserCredentials(binding),
      amountUsd,
      reason: `recharge order ${input.orderNo}`,
      reference: `recharge:${input.orderNo}`,
    });

    const [applied] = await db()
      .update(apipoolLedgerEntry)
      .set({
        status: 'applied',
        newapiChangeId: remote.changeId,
        newapiUserId: binding.newapiUserId,
      })
      .where(eq(apipoolLedgerEntry.id, ledgerId))
      .returning();

    await recordAudit({
      portalUserId: input.userId,
      action: 'newapi.recharge.apply',
      targetType: 'newapi_user',
      targetId: applied?.newapiUserId || undefined,
      status: 'success',
      idempotencyKey: `recharge:${input.orderNo}`,
      requestBody: { orderNo: input.orderNo, amountUsd },
      responseBody: { changeId: remote.changeId },
    });

    return { outcome: 'applied', ledgerId };
  } catch (error: any) {
    const isTerminal =
      error instanceof NewApiBridgeError &&
      TERMINAL_RECHARGE_ERROR_CODES.has(error.code);

    await db()
      .update(apipoolLedgerEntry)
      .set({ status: isTerminal ? 'failed' : 'pending' })
      .where(eq(apipoolLedgerEntry.id, ledgerId));

    await recordAudit({
      portalUserId: input.userId,
      action: 'newapi.recharge.apply',
      targetType: 'newapi_user',
      status: 'failed',
      idempotencyKey: `recharge:${input.orderNo}`,
      requestBody: { orderNo: input.orderNo, amountUsd },
      errorMessage: error?.message || 'recharge failed',
    });

    return {
      outcome: isTerminal ? 'failed' : 'pending_retry',
      ledgerId,
      detail: error?.message,
    };
  }
}

/**
 * 支付成功后调用（payment.ts 钩子与 admin 重试共用）。
 * 可重复调用：已 applied 直接短路；pending/failed 恢复执行。
 */
export async function applyRechargeForOrder(
  input: RechargeOrderInput,
  client: NewApiClient = createNewApiClient()
): Promise<RechargeResult> {
  if (!input.orderNo || !input.userId) {
    return { outcome: 'skipped', detail: 'missing order identity' };
  }
  if (input.currency?.toLowerCase() !== 'usd') {
    return { outcome: 'skipped', detail: `unsupported currency ${input.currency}` };
  }
  if (!Number.isFinite(input.amount) || input.amount <= 0) {
    return { outcome: 'skipped', detail: 'non-positive amount' };
  }

  const existing = await findLedgerByOrderNo(input.orderNo);
  if (existing) {
    if (existing.status === 'applied') {
      return { outcome: 'already_applied', ledgerId: existing.id };
    }
    // pending/failed：恢复执行（兑换码一码一兑，重试不会重复加额；
    // 中途失败可能留下未兑换的孤儿码，由 New API 的 DeleteInvalidRedemption 清理）
    return executeRecharge(existing.id, input, client);
  }

  try {
    const [created] = await db()
      .insert(apipoolLedgerEntry)
      .values({
        id: getUuid(),
        portalUserId: input.userId,
        operatorUserId: input.userId, // 自助充值，操作者即用户本人
        newapiUserId: 'pending',
        orderNo: input.orderNo,
        amountUsd: toAmountUsd(input.amount),
        source: 'recharge',
        status: 'pending',
        executor: 'newapi',
        reason: `recharge order ${input.orderNo}`,
        rollbackStatus: 'not_required',
      })
      .returning();

    // newapiUserId 占位 'pending'，executeRecharge 成功后回填真实值
    return executeRecharge(created.id, input, client);
  } catch (error: any) {
    // 唯一索引冲突 = 并发 webhook 已建行，读回按既有行处理
    const conflict = await findLedgerByOrderNo(input.orderNo);
    if (conflict) {
      if (conflict.status === 'applied') {
        return { outcome: 'already_applied', ledgerId: conflict.id };
      }
      return {
        outcome: 'pending_retry',
        ledgerId: conflict.id,
        detail: 'concurrent recharge in progress',
      };
    }
    return { outcome: 'failed', detail: error?.message };
  }
}
