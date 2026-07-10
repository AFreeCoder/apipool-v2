import { and, count, eq, inArray, ne, notInArray } from 'drizzle-orm';

import {
  apipoolLedgerEntry,
  catalogModelListing,
  newApiUserBinding,
} from '@/config/db/schema';
import { db } from '@/core/db';

/**
 * 后台首页运维信号。全部直接查表，不经过 portal.ts——首页只做只读计数，
 * 不应把远端调用/兑换码语义那一大坨依赖拖进来。
 */
export interface AdminOverviewSignals {
  /**
   * 资金对账告警：ledger 卡在 `reconciliation_required`。最高危信号，
   * 非 0 说明有一笔调额/充值的远端结果无法确认，必须人工介入。
   */
  reconciliationRequired: number;
  /**
   * 未结清的人工调额：`source='manual_adjustment'` 且 `status` 仍是
   * pending/processing。存在时新调额会被服务端守卫拒绝。
   */
  pendingManualAdjustments: number;
  /**
   * 绑定同步异常：`newapi_user_binding.status` 既不是 active 也不是 deleted，
   * 说明用户开号/改名/停用链路卡在中间态。
   */
  bindingSyncIssues: number;
  /**
   * 公开价被隐藏：listing 的 `price_drift_status` 不是 matched，
   * 公开页会显示占位而非价格，直到核验通过。
   */
  priceDriftListings: number;
}

/**
 * 一次性拉齐后台首页的四个计数。所有查询并行，返回纯数字。
 */
export async function getAdminOverviewSignals(): Promise<AdminOverviewSignals> {
  const conn = db();

  const [reconciliation, pendingAdjustments, syncIssues, priceDrift] =
    await Promise.all([
      conn
        .select({ value: count() })
        .from(apipoolLedgerEntry)
        .where(eq(apipoolLedgerEntry.status, 'reconciliation_required')),
      conn
        .select({ value: count() })
        .from(apipoolLedgerEntry)
        .where(
          and(
            eq(apipoolLedgerEntry.source, 'manual_adjustment'),
            inArray(apipoolLedgerEntry.status, ['pending', 'processing'])
          )
        ),
      conn
        .select({ value: count() })
        .from(newApiUserBinding)
        .where(notInArray(newApiUserBinding.status, ['active', 'deleted'])),
      conn
        .select({ value: count() })
        .from(catalogModelListing)
        .where(ne(catalogModelListing.priceDriftStatus, 'matched')),
    ]);

  return {
    reconciliationRequired: Number(reconciliation[0]?.value ?? 0),
    pendingManualAdjustments: Number(pendingAdjustments[0]?.value ?? 0),
    bindingSyncIssues: Number(syncIssues[0]?.value ?? 0),
    priceDriftListings: Number(priceDrift[0]?.value ?? 0),
  };
}
