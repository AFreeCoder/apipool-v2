import assert from 'node:assert/strict';
import test from 'node:test';
import type Stripe from 'stripe';

import { StripeProvider } from '@/extensions/payment/stripe';
import { PaymentType } from '@/extensions/payment/types';

test('USD one-time Checkout uses Dashboard payment methods without paid invoice creation', async () => {
  let sessionParams: Stripe.Checkout.SessionCreateParams | undefined;
  const provider = new StripeProvider({
    secretKey: 'sk_test_checkout_settings',
    publishableKey: 'pk_test_checkout_settings',
    allowedPaymentMethods: ['card'],
  });

  (provider as any).client = {
    customers: {
      list: async () => ({ data: [] }),
      create: async () => ({ id: 'cus_checkout_settings' }),
    },
    checkout: {
      sessions: {
        create: async (params: Stripe.Checkout.SessionCreateParams) => {
          sessionParams = params;
          return {
            id: 'cs_test_checkout_settings',
            url: 'https://checkout.stripe.test/session',
          };
        },
      },
    },
  };

  await provider.createPayment({
    order: {
      type: PaymentType.ONE_TIME,
      price: { amount: 1000, currency: 'usd' },
      description: 'APIPool Credit USD $10',
      customer: { email: 'checkout@example.com' },
      successUrl: 'https://app.apipool.dev/api/payment/callback',
    },
  });

  assert.ok(sessionParams);
  assert.equal(sessionParams.mode, 'payment');
  assert.equal(sessionParams.invoice_creation, undefined);
  assert.equal(sessionParams.payment_method_types, undefined);
});
