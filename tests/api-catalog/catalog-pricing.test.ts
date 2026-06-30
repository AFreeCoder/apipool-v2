import assert from 'node:assert/strict';
import test from 'node:test';
import {
  bpsToDiscountFold,
  derivePricingFromNewApiPricing,
  discountFoldToBps,
  dollarsToMicroUsd,
  formatDiscountRate,
  microUsdToDollars,
  optionalDollarsToMicroUsd,
} from '@/features/api-catalog/lib/pricing';

test('catalog pricing helpers convert dollars per million tokens to micro-USD integers', () => {
  assert.equal(dollarsToMicroUsd(0.15), 150000);
  assert.equal(dollarsToMicroUsd('2.5'), 2500000);
  assert.equal(dollarsToMicroUsd(0), 0);
});

test('catalog pricing helpers reject negative and non-finite dollar values', () => {
  assert.throws(() => dollarsToMicroUsd(-0.01), /non-negative/);
  assert.throws(() => dollarsToMicroUsd('not-a-number'), /finite/);
});

test('catalog pricing helpers convert stored micro-USD values back to dollar form input values', () => {
  assert.equal(microUsdToDollars(150000), '0.15');
  assert.equal(microUsdToDollars(2500000), '2.5');
  assert.equal(microUsdToDollars(null), '');
});

test('catalog pricing helpers convert optional dollar values', () => {
  assert.equal(optionalDollarsToMicroUsd(null), null);
  assert.equal(optionalDollarsToMicroUsd(''), null);
  assert.equal(optionalDollarsToMicroUsd('0.04'), 40000);
});

test('catalog discount helpers support sub-1-fold discounts without floats in storage', () => {
  assert.equal(discountFoldToBps('10'), 10000);
  assert.equal(discountFoldToBps('1'), 1000);
  assert.equal(discountFoldToBps('0.5'), 500);
  assert.equal(discountFoldToBps('0.05'), 50);
  assert.equal(bpsToDiscountFold(500), '0.5');
  assert.equal(formatDiscountRate(500), '0.5 折 (5%)');
  assert.equal(formatDiscountRate(null), '');
  assert.throws(() => discountFoldToBps('0'), /between 0.01 and 10/);
  assert.throws(() => discountFoldToBps('11'), /between 0.01 and 10/);
});

test('New API pricing ratios derive ordinary and image token prices per 1M tokens', () => {
  const derived = derivePricingFromNewApiPricing({
    model_name: 'gpt-image-1',
    quota_type: 0,
    model_ratio: 2.5,
    completion_ratio: 8,
    image_ratio: 2,
  });

  assert.deepEqual(derived, {
    source: 'ratio',
    inputMicroUsd: 5000000,
    outputMicroUsd: 40000000,
    imageInputMicroUsd: 10000000,
    imageOutputMicroUsd: 40000000,
  });
});

test('New API fixed-price models do not pretend to have token split prices', () => {
  const derived = derivePricingFromNewApiPricing({
    model_name: 'dall-e-3',
    quota_type: 1,
    model_price: 0.04,
    model_ratio: 0,
    completion_ratio: 0,
  });

  assert.deepEqual(derived, {
    source: 'fixed-price',
    inputMicroUsd: null,
    outputMicroUsd: null,
    imageInputMicroUsd: null,
    imageOutputMicroUsd: null,
  });
});
