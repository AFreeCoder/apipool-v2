import 'server-only';

import { and, eq, inArray, isNull, lte, or } from 'drizzle-orm';

import { db } from '@/core/db';
import { apipoolLedgerEntry } from '@/config/db/schema';
import { getUuid } from '@/shared/lib/hash';

import {
  createNewApiClient,
  isQuotaAdjustmentReconciliationError,
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
// 通过兑换码把同额 quota 加到 New API。幂等靠 ledger.orderNo 唯一索引
// 和 processing claim；远端已执行但本地无法确认时进入人工核对状态。

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

const CLAIMABLE_RECHARGE_STATUSES = ['pending', 'failed'];

// 进程在 claim 后崩溃（OOM、滚动部署）会把行永久留在 processing。
// 超过该时长且「未发出兑换码」的行可安全重夺——远端什么都没发生。
// 已发出兑换码的卡死行绝不自动重试，只升级为人工核对。
// 单次远端调用最长约 15s×3 次请求，5 分钟留足余量，不会夺走仍在执行的行。
const PROCESSING_RECLAIM_AFTER_MS = 5 * 60 * 1000;

function processingReclaimCutoff() {
  return new Date(Date.now() - PROCESSING_RECLAIM_AFTER_MS);
}

async function recordRechargeAudit(input: Parameters<typeof recordAudit>[0]) {
  try {
    await recordAudit(input);
  } catch (error: any) {
    console.error('failed to record recharge audit', error?.message || error);
  }
}

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

async function findLedgerById(ledgerId: string) {
  const [row] = await db()
    .select()
    .from(apipoolLedgerEntry)
    .where(eq(apipoolLedgerEntry.id, ledgerId))
    .limit(1);
  return row;
}

async function claimLedgerForRecharge(ledgerId: string) {
  const [claimed] = await db()
    .update(apipoolLedgerEntry)
    .set({ status: 'processing' })
    .where(
      and(
        eq(apipoolLedgerEntry.id, ledgerId),
        // 不变量：一旦码值落库，远端就可能已入账，任何自动重试都被禁止。
        isNull(apipoolLedgerEntry.newapiChangeId),
        or(
          inArray(apipoolLedgerEntry.status, CLAIMABLE_RECHARGE_STATUSES),
          and(
            eq(apipoolLedgerEntry.status, 'processing'),
            lte(apipoolLedgerEntry.updatedAt, processingReclaimCutoff()),
            // 崩溃的 processing 行只有在「远端从未被尝试」时才可安全重夺。
            // changeId 为空不足以证明这一点：进程可能死在
            // 「兑换码已创建、码值尚未落库」之间。
            isNull(apipoolLedgerEntry.remoteAttemptAt)
          )
        )
      )
    )
    .returning();
  return claimed;
}

async function unclaimedRechargeResult(
  ledgerId: string
): Promise<RechargeResult> {
  const current = await findLedgerById(ledgerId);
  if (current?.status === 'applied') {
    return { outcome: 'already_applied', ledgerId };
  }
  if (current?.status === 'reconciliation_required') {
    return {
      outcome: 'failed',
      ledgerId,
      detail: 'manual reconciliation required',
    };
  }

  // 远端已被尝试但结局未知（码值已落库，或进程死在创建兑换码之后）：
  // 重试会再创建一张码。升级人工核对——码值在 newapiChangeId，
  // 若连码值都没落库，可用 reference 的确定性短哈希在 New API 侧按名反查。
  // processing 且尚新 = 另一进程正在执行，交还 pending_retry 由其收敛。
  const stillRunning =
    current?.status === 'processing' &&
    current.updatedAt > processingReclaimCutoff();

  const remoteOutcomeUnknown = Boolean(
    current?.newapiChangeId || current?.remoteAttemptAt
  );

  if (current && remoteOutcomeUnknown && !stillRunning) {
    await db()
      .update(apipoolLedgerEntry)
      .set({ status: 'reconciliation_required' })
      .where(eq(apipoolLedgerEntry.id, ledgerId));

    return {
      outcome: 'failed',
      ledgerId,
      detail: 'manual reconciliation required',
    };
  }

  return {
    outcome: 'pending_retry',
    ledgerId,
    detail: 'concurrent recharge in progress',
  };
}

async function executeRecharge(
  ledgerId: string,
  input: RechargeOrderInput,
  client: NewApiClient
): Promise<RechargeResult> {
  const amountUsd = toAmountUsd(input.amount);
  const claimed = await claimLedgerForRecharge(ledgerId);
  if (!claimed) {
    return unclaimedRechargeResult(ledgerId);
  }

  let remoteAdjusted = false;
  // 兑换码一旦发出，远端就可能已入账：此后禁止任何自动重试
  let redemptionDispatched = false;
  try {
    const binding = await ensurePortalUserBinding(
      { id: input.userId, email: input.userEmail || '' },
      client
    );

    // 在任何远端副作用之前落下持久化标记。进程若在
    // 「兑换码已创建、码值尚未落库」之间被杀，靠它证明远端结局未知，
    // 从而阻止 TTL 重夺把该行当成「什么都没发生」重试。
    await db()
      .update(apipoolLedgerEntry)
      .set({ remoteAttemptAt: new Date() })
      .where(eq(apipoolLedgerEntry.id, ledgerId));

    const remote = await client.adjustQuota({
      user: bindingToUserCredentials(binding),
      amountUsd,
      reason: `recharge order ${input.orderNo}`,
      reference: `recharge:${input.orderNo}`,
      // 在兑换请求发出之前落库码值：崩溃后据此判定「不可自动重试」
      onRedemptionCreated: async (code) => {
        redemptionDispatched = true;
        await db()
          .update(apipoolLedgerEntry)
          .set({ newapiChangeId: code })
          .where(eq(apipoolLedgerEntry.id, ledgerId));
      },
    });
    remoteAdjusted = true;

    const [applied] = await db()
      .update(apipoolLedgerEntry)
      .set({
        status: 'applied',
        newapiChangeId: remote.changeId,
        newapiUserId: binding.newapiUserId,
      })
      .where(eq(apipoolLedgerEntry.id, ledgerId))
      .returning();

    await recordRechargeAudit({
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
    // 兑换码已生成后的任何失败都带着码值抛出：远端可能已兑换，
    // 自动重试会生成第二张码并双倍到账，只能转人工核对。
    const needsReconciliation = isQuotaAdjustmentReconciliationError(error);
    const isTerminal =
      error instanceof NewApiBridgeError &&
      TERMINAL_RECHARGE_ERROR_CODES.has(error.code);
    const nextStatus =
      remoteAdjusted || needsReconciliation || redemptionDispatched
        ? 'reconciliation_required'
        : isTerminal
          ? 'failed'
          : 'pending';

    await db()
      .update(apipoolLedgerEntry)
      .set({
        status: nextStatus,
        // 落库码值，人工核对据此反查远端是否已兑换（docs/06 第 5 节）。
        // 码值可能为空（兑换码创建后响应就损坏了），此时留空避免撞唯一索引，
        // 人工按 reference 的确定性短哈希在 New API 侧按名反查。
        ...(needsReconciliation && error.changeId
          ? { newapiChangeId: error.changeId }
          : {}),
      })
      .where(eq(apipoolLedgerEntry.id, ledgerId));

    await recordRechargeAudit({
      portalUserId: input.userId,
      action: 'newapi.recharge.apply',
      targetType: 'newapi_user',
      status: 'failed',
      idempotencyKey: `recharge:${input.orderNo}`,
      requestBody: { orderNo: input.orderNo, amountUsd },
      errorMessage: error?.message || 'recharge failed',
    });

    return {
      outcome: nextStatus === 'pending' ? 'pending_retry' : 'failed',
      ledgerId,
      detail: error?.message,
    };
  }
}

/**
 * 支付成功后调用（payment.ts 钩子与 admin 重试共用）。
 * 可重复调用：已 applied 直接短路；pending/failed 先 claim 再执行。
 */
export async function applyRechargeForOrder(
  input: RechargeOrderInput,
  client: NewApiClient = createNewApiClient()
): Promise<RechargeResult> {
  if (!input.orderNo || !input.userId) {
    return { outcome: 'skipped', detail: 'missing order identity' };
  }
  if (input.currency?.toLowerCase() !== 'usd') {
    return {
      outcome: 'skipped',
      detail: `unsupported currency ${input.currency}`,
    };
  }
  if (!Number.isFinite(input.amount) || input.amount <= 0) {
    return { outcome: 'skipped', detail: 'non-positive amount' };
  }

  const existing = await findLedgerByOrderNo(input.orderNo);
  if (existing) {
    if (existing.status === 'applied') {
      return { outcome: 'already_applied', ledgerId: existing.id };
    }
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
