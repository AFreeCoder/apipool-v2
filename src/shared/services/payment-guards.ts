import {
  PaymentSession,
  PaymentStatus,
  PaymentType,
} from '@/extensions/payment/types';
import type { Order } from '@/shared/models/order';

/**
 * webhook 通过 session.metadata.order_no 回查订单，因此 session 与订单的绑定
 * 必须在入账前独立校验一次，不能只信 metadata。
 *
 * 只在「少付」时拒绝：多付（税费、汇率进位）放行，避免误拒已付款的用户。
 * 订阅首期可能因试用为 0，故跳过；provider 未报告金额时同样跳过。
 *
 * 仅校验支付成功的 session：stripe 的 checkout.session.completed 在异步支付
 * 未付款时也映射为 CHECKOUT_SUCCESS，这类 session 金额为 0，不能在此拒绝，
 * 否则会打断其原本的 FAILED / PROCESSING 落库路径。
 */
export function assertPaymentSessionMatchesOrder({
  order,
  session,
}: {
  order: Order;
  session: PaymentSession;
}) {
  if (session.paymentStatus !== PaymentStatus.SUCCESS) return;
  if (order.paymentType === PaymentType.SUBSCRIPTION) return;

  const paymentInfo = session.paymentInfo;
  if (!paymentInfo) return;

  const orderCurrency = (order.currency || '').toLowerCase();
  const sessionCurrency = (paymentInfo.paymentCurrency || '').toLowerCase();
  if (sessionCurrency && orderCurrency && sessionCurrency !== orderCurrency) {
    throw new Error(
      `payment currency ${sessionCurrency} does not match order ${order.orderNo} currency ${orderCurrency}`
    );
  }

  const paidAmount = paymentInfo.paymentAmount;
  if (typeof paidAmount !== 'number') return;

  const coveredAmount = paidAmount + (paymentInfo.discountAmount || 0);
  if (coveredAmount < (order.amount || 0)) {
    throw new Error(
      `payment amount ${paidAmount} does not cover order ${order.orderNo} amount ${order.amount}`
    );
  }
}
