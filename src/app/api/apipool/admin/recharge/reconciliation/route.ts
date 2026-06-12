import { getPublicPortalErrorMessage } from '@/features/api-console/lib/public-errors';
import { desc, eq, inArray } from 'drizzle-orm';

import { db } from '@/core/db';
import { PERMISSIONS } from '@/core/rbac';
import { apipoolLedgerEntry, order as orderTable } from '@/config/db/schema';
import { withNoStore } from '@/shared/lib/http-cache';
import { respData, respErr } from '@/shared/lib/resp';
import { OrderStatus } from '@/shared/models/order';
import { getUserInfo } from '@/shared/models/user';
import { hasPermission } from '@/shared/services/rbac';

export const dynamic = 'force-dynamic';

const RECONCILIATION_LIMIT = 100;

// 对账（docs/06 第 6 节）：orders(paid) ⟷ ledger(recharge) ⟷ New API。
// ledger.newapiChangeId 即已花费的兑换码值——存在即代表远端已兑换成功，
// 故两表比对足以覆盖三方一致性；差异行列出待处理订单。
export async function GET() {
  try {
    const operator = await getUserInfo();
    if (!operator) return withNoStore(respErr('no auth, please sign in'));

    const allowed = await hasPermission(
      operator.id,
      PERMISSIONS.APIPOOL_QUOTA_ADJUST
    );
    if (!allowed) {
      return withNoStore(respErr('APIPool reconciliation permission required'));
    }

    const paidOrders = await db()
      .select({
        orderNo: orderTable.orderNo,
        userId: orderTable.userId,
        amount: orderTable.amount,
        currency: orderTable.currency,
        creditsAmount: orderTable.creditsAmount,
        paymentType: orderTable.paymentType,
        paidAt: orderTable.paidAt,
      })
      .from(orderTable)
      .where(eq(orderTable.status, OrderStatus.PAID))
      .orderBy(desc(orderTable.createdAt))
      .limit(RECONCILIATION_LIMIT);

    const creditOrders = paidOrders.filter(
      (row: any) =>
        row.paymentType === 'one-time' &&
        (row.creditsAmount ?? 0) > 0 &&
        row.currency?.toLowerCase() === 'usd'
    );

    const orderNos = creditOrders.map((row: any) => String(row.orderNo));
    let ledgerRows: any[] = [];
    if (orderNos.length > 0) {
      ledgerRows = await db()
        .select()
        .from(apipoolLedgerEntry)
        .where(inArray(apipoolLedgerEntry.orderNo, orderNos));
    }
    const ledgerByOrderNo = new Map(
      ledgerRows.map((row: any) => [row.orderNo, row])
    );

    const rows = creditOrders.map((row: any) => {
      const ledger = ledgerByOrderNo.get(row.orderNo);
      const ledgerStatus = ledger?.status ?? 'missing';
      const remoteConfirmed = Boolean(ledger?.newapiChangeId);
      return {
        orderNo: row.orderNo,
        userId: row.userId,
        amountUsd: row.amount / 100,
        paidAt: row.paidAt,
        ledgerStatus,
        remoteConfirmed,
        consistent: ledgerStatus === 'applied' && remoteConfirmed,
      };
    });

    const discrepancies = rows.filter((row: any) => !row.consistent);

    return withNoStore(
      respData({
        checkedOrders: rows.length,
        consistent: rows.length - discrepancies.length,
        discrepancies,
      })
    );
  } catch (error: any) {
    return withNoStore(
      respErr(
        getPublicPortalErrorMessage(
          error,
          'Reconciliation could not run. Try again later.'
        )
      )
    );
  }
}
