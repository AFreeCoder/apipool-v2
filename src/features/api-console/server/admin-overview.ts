import { count, isNotNull, lt, ne, notInArray } from 'drizzle-orm';

import { db } from '@/core/db';
import {
  catalogModelListing,
  newApiUserBinding,
  walletAccount,
} from '@/config/db/schema';

/**
 * 后台首页运维信号。资金类信号只读取本地钱包，New API 用户绑定仅用于
 * 运行凭证供给，不再承担门户余额或调额状态。
 */
export interface AdminOverviewSignals {
  /** 余额已经透支，需要运营核对并通过 APIPool 调额入口处理。 */
  negativeWallets: number;
  /** 已冻结的钱包，需要运营核对冻结原因。 */
  frozenWallets: number;
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

  const [negativeWallets, frozenWallets, syncIssues, priceDrift] =
    await Promise.all([
      conn
        .select({ value: count() })
        .from(walletAccount)
        .where(lt(walletAccount.balanceMicroUsd, 0)),
      conn
        .select({ value: count() })
        .from(walletAccount)
        .where(isNotNull(walletAccount.frozenAt)),
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
    negativeWallets: Number(negativeWallets[0]?.value ?? 0),
    frozenWallets: Number(frozenWallets[0]?.value ?? 0),
    bindingSyncIssues: Number(syncIssues[0]?.value ?? 0),
    priceDriftListings: Number(priceDrift[0]?.value ?? 0),
  };
}
