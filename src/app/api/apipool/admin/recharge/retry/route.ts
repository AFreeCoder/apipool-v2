import { getPublicPortalErrorMessage } from '@/features/api-console/lib/public-errors';
import { applyRechargeForOrder } from '@/features/newapi-bridge/server/recharge';
import { PaymentType } from '@/extensions/payment/types';

import { PERMISSIONS } from '@/core/rbac';
import { withNoStore } from '@/shared/lib/http-cache';
import { respData, respErr } from '@/shared/lib/resp';
import { findOrderByOrderNo, OrderStatus } from '@/shared/models/order';
import { getUserInfo } from '@/shared/models/user';
import { hasPermission } from '@/shared/services/rbac';

export const dynamic = 'force-dynamic';

// 加额失败补偿入口：按订单号重试充值加额（幂等，已 applied 直接短路）
export async function POST(req: Request) {
  try {
    const operator = await getUserInfo();
    if (!operator) return withNoStore(respErr('no auth, please sign in'));

    const allowed = await hasPermission(
      operator.id,
      PERMISSIONS.APIPOOL_QUOTA_ADJUST
    );
    if (!allowed) {
      return withNoStore(respErr('APIPool recharge retry permission required'));
    }

    const body = await req.json().catch(() => ({}));
    const orderNo = String(body.orderNo || '').trim();
    if (!orderNo) return withNoStore(respErr('orderNo is required'));

    const order = await findOrderByOrderNo(orderNo);
    if (!order) return withNoStore(respErr('order not found'));
    if (order.status !== OrderStatus.PAID) {
      return withNoStore(respErr(`order is not paid: ${order.status}`));
    }
    if (order.paymentType !== PaymentType.ONE_TIME) {
      return withNoStore(respErr('only one-time credit orders are supported'));
    }
    if (!order.creditsAmount || order.creditsAmount <= 0) {
      return withNoStore(respErr('order has no credits to apply'));
    }

    const result = await applyRechargeForOrder({
      orderNo: order.orderNo,
      userId: order.userId,
      userEmail: order.userEmail,
      amount: order.amount,
      currency: order.currency,
    });

    return withNoStore(respData({ result }));
  } catch (error: any) {
    return withNoStore(
      respErr(
        getPublicPortalErrorMessage(
          error,
          'Recharge retry could not start. Try again later.'
        )
      )
    );
  }
}
