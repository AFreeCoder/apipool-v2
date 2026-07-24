import assert from 'node:assert/strict';
import test from 'node:test';

import { PaymentStatus, PaymentType } from '@/extensions/payment/types';
import { assertPaymentSessionMatchesOrder } from '@/shared/services/payment-guards';

function oneTimeOrder(overrides: Record<string, any> = {}) {
  return {
    orderNo: 'order_50',
    amount: 5000,
    currency: 'usd',
    paymentType: PaymentType.ONE_TIME,
    ...overrides,
  } as any;
}

function session(
  paymentInfo: Record<string, any> | undefined,
  paymentStatus: PaymentStatus = PaymentStatus.SUCCESS
) {
  return { provider: 'stripe', paymentStatus, paymentInfo } as any;
}

test('rejects a session that paid less than the order amount', () => {
  // The P0-7 attack shape: a $10 session settling a $50 order.
  assert.throws(
    () =>
      assertPaymentSessionMatchesOrder({
        order: oneTimeOrder(),
        session: session({ paymentAmount: 1000, paymentCurrency: 'usd' }),
      }),
    /payment amount 1000 does not cover order order_50 amount 5000/
  );
});

test('accepts a discounted session whose paid amount plus discount covers the order', () => {
  assert.doesNotThrow(() =>
    assertPaymentSessionMatchesOrder({
      order: oneTimeOrder(),
      session: session({
        paymentAmount: 4500,
        discountAmount: 500,
        paymentCurrency: 'usd',
      }),
    })
  );
});

test('accepts an overpaid session so tax or rounding never fails closed', () => {
  assert.doesNotThrow(() =>
    assertPaymentSessionMatchesOrder({
      order: oneTimeOrder(),
      session: session({ paymentAmount: 5300, paymentCurrency: 'usd' }),
    })
  );
});

test('compares currency case-insensitively across providers', () => {
  assert.doesNotThrow(() =>
    assertPaymentSessionMatchesOrder({
      order: oneTimeOrder(),
      session: session({ paymentAmount: 5000, paymentCurrency: 'USD' }),
    })
  );
});

test('rejects a session paid in a different currency than the order', () => {
  assert.throws(
    () =>
      assertPaymentSessionMatchesOrder({
        order: oneTimeOrder(),
        session: session({ paymentAmount: 5000, paymentCurrency: 'eur' }),
      }),
    /currency eur does not match order order_50 currency usd/
  );
});

test('skips subscription orders whose first invoice may legitimately be zero', () => {
  assert.doesNotThrow(() =>
    assertPaymentSessionMatchesOrder({
      order: oneTimeOrder({ paymentType: PaymentType.SUBSCRIPTION }),
      session: session({ paymentAmount: 0, paymentCurrency: 'usd' }),
    })
  );
});

test('skips validation when the provider reported no payment info', () => {
  assert.doesNotThrow(() =>
    assertPaymentSessionMatchesOrder({
      order: oneTimeOrder(),
      session: session(undefined),
    })
  );
});

test('skips validation for sessions that did not succeed, so failed and async-pending checkouts still settle their own status', () => {
  // stripe maps checkout.session.completed to CHECKOUT_SUCCESS even when unpaid;
  // those sessions carry a zero amount and must not be rejected here.
  for (const status of [
    PaymentStatus.FAILED,
    PaymentStatus.CANCELED,
    PaymentStatus.PROCESSING,
  ]) {
    assert.doesNotThrow(
      () =>
        assertPaymentSessionMatchesOrder({
          order: oneTimeOrder(),
          session: session({ paymentAmount: 0, paymentCurrency: '' }, status),
        }),
      `status ${status} must not throw`
    );
  }
});

test('skips currency check when the provider reported no currency', () => {
  assert.doesNotThrow(() =>
    assertPaymentSessionMatchesOrder({
      order: oneTimeOrder(),
      session: session({ paymentAmount: 5000, paymentCurrency: '' }),
    })
  );
});
