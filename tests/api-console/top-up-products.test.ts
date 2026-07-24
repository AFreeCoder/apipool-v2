import assert from 'node:assert/strict';
import test from 'node:test';

import { PaymentInterval, PaymentType } from '@/extensions/payment/types';
import {
  resolveTopUpCheckout,
  TOP_UP_CUSTOM_MAX_USD,
  TOP_UP_CUSTOM_MIN_USD,
} from '@/features/api-console/lib/top-up-products';
import type { PricingItem } from '@/shared/types/blocks/pricing';

const pricingItemsFixture: PricingItem[] = [
  {
    title: 'Starter',
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
    title: 'Builder',
    description: 'For development use',
    interval: 'one-time',
    amount: 5000,
    currency: 'USD',
    price: 'USD $50',
    product_id: 'topup_50',
    product_name: 'APIPool Credit USD $50',
    credits: 5000,
    valid_days: 0,
    group: 'one-time',
    is_featured: true,
  },
  {
    title: 'Scale',
    description: 'For high volume use',
    interval: 'one-time',
    amount: 100000,
    currency: 'USD',
    price: 'USD $1000',
    product_id: 'topup_1000',
    product_name: 'APIPool Credit USD $1000',
    credits: 100000,
    valid_days: 0,
    group: 'one-time',
  },
];

test('resolves preset top-up products from server pricing config', () => {
  const resolved = resolveTopUpCheckout({
    productId: 'topup_50',
    currency: 'USD',
    pricingItems: pricingItemsFixture,
  });

  assert.equal(resolved.productId, 'topup_50');
  assert.equal(resolved.productName, 'APIPool Credit USD $50');
  assert.equal(resolved.description, 'For development use');
  assert.equal(resolved.amount, 5000);
  assert.equal(resolved.creditsAmount, 5000);
  assert.equal(resolved.currency, 'usd');
  assert.equal(resolved.priceLabel, 'USD $50');
  assert.equal(resolved.interval, PaymentInterval.ONE_TIME);
  assert.equal(resolved.type, PaymentType.ONE_TIME);
  assert.equal(resolved.creditsValidDays, 0);
  assert.equal(resolved.isCustomAmount, false);
});

test('resolves the $1000 preset without cents or credit drift', () => {
  const resolved = resolveTopUpCheckout({
    productId: 'topup_1000',
    currency: 'usd',
    pricingItems: pricingItemsFixture,
  });

  assert.equal(resolved.amount, 100000);
  assert.equal(resolved.creditsAmount, 100000);
  assert.equal(resolved.currency, 'usd');
});

test('resolves custom integer USD amounts into cents and credits', () => {
  const resolved = resolveTopUpCheckout({
    customAmountUsd: 120,
    currency: 'USD',
    pricingItems: pricingItemsFixture,
  });

  assert.equal(resolved.productId, 'topup_custom');
  assert.equal(resolved.productName, 'APIPool Credit USD $120');
  assert.equal(resolved.description, 'Custom APIPool credit top-up');
  assert.equal(resolved.amount, 12000);
  assert.equal(resolved.creditsAmount, 12000);
  assert.equal(resolved.currency, 'usd');
  assert.equal(resolved.priceLabel, 'USD $120');
  assert.equal(resolved.interval, PaymentInterval.ONE_TIME);
  assert.equal(resolved.type, PaymentType.ONE_TIME);
  assert.equal(resolved.creditsValidDays, 0);
  assert.equal(resolved.isCustomAmount, true);
});

test('accepts custom top-up boundary amounts', () => {
  assert.equal(
    resolveTopUpCheckout({
      customAmountUsd: TOP_UP_CUSTOM_MIN_USD,
      currency: 'USD',
      pricingItems: pricingItemsFixture,
    }).amount,
    1000
  );
  assert.equal(
    resolveTopUpCheckout({
      customAmountUsd: TOP_UP_CUSTOM_MAX_USD,
      currency: 'USD',
      pricingItems: pricingItemsFixture,
    }).amount,
    100000
  );
});

test('rejects ambiguous checkout amount sources', () => {
  assert.throws(
    () =>
      resolveTopUpCheckout({
        productId: 'topup_50',
        customAmountUsd: 50,
        currency: 'USD',
        pricingItems: pricingItemsFixture,
      }),
    /choose either product_id or custom_amount_usd/
  );
});

test('rejects invalid custom top-up amounts before checkout', () => {
  for (const customAmountUsd of [
    -10,
    0,
    9,
    1001,
    10.5,
    'abc',
    '',
    null,
    undefined,
  ]) {
    assert.throws(
      () =>
        resolveTopUpCheckout({
          customAmountUsd,
          currency: 'USD',
          pricingItems: pricingItemsFixture,
        }),
      /custom_amount_usd/
    );
  }
});

test('rejects non-USD custom top-ups', () => {
  assert.throws(
    () =>
      resolveTopUpCheckout({
        customAmountUsd: 100,
        currency: 'EUR',
        pricingItems: pricingItemsFixture,
      }),
    /top-up only supports USD/
  );
});

test('rejects non-USD preset top-ups', () => {
  assert.throws(
    () =>
      resolveTopUpCheckout({
        productId: 'topup_50',
        currency: 'EUR',
        pricingItems: pricingItemsFixture,
      }),
    /top-up only supports USD/
  );
});

test('rejects missing and unknown preset products', () => {
  assert.throws(
    () =>
      resolveTopUpCheckout({
        currency: 'USD',
        pricingItems: pricingItemsFixture,
      }),
    /product_id or custom_amount_usd is required/
  );
  assert.throws(
    () =>
      resolveTopUpCheckout({
        productId: 'topup_missing',
        currency: 'USD',
        pricingItems: pricingItemsFixture,
      }),
    /pricing item not found/
  );
});

test('preset products ignore client-side amount-like fields', () => {
  const resolved = resolveTopUpCheckout({
    productId: 'topup_10',
    customAmountUsd: undefined,
    currency: 'USD',
    pricingItems: pricingItemsFixture.map((item) => ({ ...item })),
  });

  assert.equal(resolved.amount, 1000);
  assert.equal(resolved.creditsAmount, 1000);
});
