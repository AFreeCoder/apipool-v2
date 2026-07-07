import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  createTopUpCheckoutResponse,
  type CheckoutHandlerDeps,
} from '@/app/api/payment/checkout/checkout-handler';

import type { NewOrder } from '@/shared/models/order';
import type { PricingItem } from '@/shared/types/blocks/pricing';

const routePath = 'src/app/api/payment/checkout/route.ts';

const pricingItemsFixture: PricingItem[] = [
  {
    title: 'Builder',
    description: 'Start using APIPool',
    interval: 'one-time',
    amount: 1000,
    currency: 'USD',
    price: 'USD $10',
    product_id: 'topup_10',
    product_name: 'APIPool Credit USD $10',
    credits: 1000,
    valid_days: 0,
    group: 'one-time',
  },
  {
    title: 'Developer',
    description: 'For regular development',
    interval: 'one-time',
    amount: 5000,
    currency: 'USD',
    price: 'USD $50',
    product_id: 'topup_50',
    product_name: 'APIPool Credit USD $50',
    credits: 5000,
    valid_days: 0,
    group: 'one-time',
    payment_providers: ['stripe'],
    is_featured: true,
  },
];

function createCheckoutDeps() {
  const createdOrders: NewOrder[] = [];
  const updatedOrders: Array<{ orderNo: string; update: any }> = [];
  const createPaymentCalls: Array<{ order: any }> = [];

  const deps: Partial<CheckoutHandlerDeps> = {
    getUserInfo: async () =>
      ({
        id: 'user_checkout',
        name: 'Checkout User',
        email: 'checkout@example.com',
      }) as any,
    getAllConfigs: async () =>
      ({
        app_name: 'APIPool',
        app_url: 'https://app.apipool.dev',
        default_locale: 'en',
        default_payment_provider: 'stripe',
      }) as any,
    getPaymentService: async () =>
      ({
        getProvider: (name: string) =>
          name === 'stripe'
            ? {
                name: 'stripe',
                createPayment: async (input: { order: any }) => {
                  createPaymentCalls.push(input);
                  return {
                    provider: 'stripe',
                    checkoutInfo: {
                      checkoutUrl: 'https://stripe.test/checkout',
                      sessionId: 'cs_test_123',
                    },
                    checkoutParams: { mode: 'payment' },
                    checkoutResult: { id: 'cs_test_123' },
                  };
                },
              }
            : undefined,
      }) as any,
    createOrder: async (order: NewOrder) => {
      createdOrders.push(order);
    },
    updateOrderByOrderNo: async (orderNo: string, update: any) => {
      updatedOrders.push({ orderNo, update });
    },
    getPaymentProductId: async () => undefined,
    getPromotionCode: async () => undefined,
    getSnowId: () => 'order_checkout_test',
    getUuid: () => 'order_row_checkout_test',
    now: () => new Date('2026-07-06T00:00:00.000Z'),
  };

  return { deps, createdOrders, updatedOrders, createPaymentCalls };
}

async function parseResponse(response: Response) {
  return response.json() as Promise<{
    code: number;
    message: string;
    data?: any;
  }>;
}

test('checkout route delegates request handling to the injectable top-up checkout handler', async () => {
  const source = await readFile(routePath, 'utf8');

  assert.match(source, /createTopUpCheckoutResponse/);
  assert.match(source, /body = await req\.json\(\)/);
  assert.doesNotMatch(
    source,
    /if \(!product_id\) \{\s*return respErr\('product_id is required'\);?\s*\}/
  );
});

test('checkout handler creates a custom top-up order from server-side cents and credits', async () => {
  const { deps, createdOrders, updatedOrders, createPaymentCalls } =
    createCheckoutDeps();

  const response = await createTopUpCheckoutResponse({
    body: {
      custom_amount_usd: 120,
      currency: 'USD',
      locale: 'en',
      metadata: { source: 'billing-page' },
    },
    pricingItems: pricingItemsFixture,
    deps,
  });
  const payload = await parseResponse(response);

  assert.equal(payload.code, 0);
  assert.equal(payload.data.checkoutUrl, 'https://stripe.test/checkout');
  assert.equal(createdOrders.length, 1);
  assert.equal(createPaymentCalls.length, 1);
  assert.equal(updatedOrders.length, 1);

  const order = createdOrders[0];
  assert.equal(order.orderNo, 'order_checkout_test');
  assert.equal(order.amount, 12000);
  assert.equal(order.creditsAmount, 12000);
  assert.equal(order.currency, 'usd');
  assert.equal(order.productId, 'topup_custom');
  assert.equal(order.productName, 'APIPool Credit USD $120');
  assert.equal(order.paymentProductId, '');
  assert.equal(order.discountCode, undefined);

  const providerOrder = createPaymentCalls[0].order;
  assert.deepEqual(providerOrder.price, { amount: 12000, currency: 'usd' });
  assert.equal(providerOrder.metadata.order_no, 'order_checkout_test');
  assert.equal(providerOrder.metadata.user_id, 'user_checkout');
  assert.equal(providerOrder.metadata.source, 'billing-page');
  assert.equal(
    providerOrder.successUrl,
    'https://app.apipool.dev/api/payment/callback?order_no=order_checkout_test'
  );
});

test('checkout handler creates preset top-up orders from pricing config, not client amount fields', async () => {
  const { deps, createdOrders, createPaymentCalls } = createCheckoutDeps();

  const response = await createTopUpCheckoutResponse({
    body: {
      product_id: 'topup_50',
      currency: 'USD',
      locale: 'en',
      amount: 1,
      credits: 1,
    } as any,
    pricingItems: pricingItemsFixture,
    deps,
  });
  const payload = await parseResponse(response);

  assert.equal(payload.code, 0);
  assert.equal(createdOrders.length, 1);
  assert.equal(createPaymentCalls.length, 1);
  assert.equal(createdOrders[0].amount, 5000);
  assert.equal(createdOrders[0].creditsAmount, 5000);
  assert.equal(createdOrders[0].productId, 'topup_50');
  assert.deepEqual(createPaymentCalls[0].order.price, {
    amount: 5000,
    currency: 'usd',
  });
});

test('checkout handler rejects invalid custom top-up requests before order or payment creation', async () => {
  for (const body of [
    { custom_amount_usd: 0, currency: 'USD' },
    { custom_amount_usd: -10, currency: 'USD' },
    { custom_amount_usd: 9, currency: 'USD' },
    { custom_amount_usd: 1001, currency: 'USD' },
    { custom_amount_usd: 10.5, currency: 'USD' },
    { custom_amount_usd: 10, currency: 'EUR' },
    {
      product_id: 'topup_50',
      custom_amount_usd: 50,
      currency: 'USD',
    },
  ]) {
    const { deps, createdOrders, updatedOrders, createPaymentCalls } =
      createCheckoutDeps();

    const response = await createTopUpCheckoutResponse({
      body,
      pricingItems: pricingItemsFixture,
      deps,
    });
    const payload = await parseResponse(response);

    assert.equal(payload.code, -1, JSON.stringify(body));
    assert.equal(createdOrders.length, 0, JSON.stringify(body));
    assert.equal(updatedOrders.length, 0, JSON.stringify(body));
    assert.equal(createPaymentCalls.length, 0, JSON.stringify(body));
  }
});
