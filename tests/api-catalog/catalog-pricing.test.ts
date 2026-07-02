import assert from 'node:assert/strict';
import test from 'node:test';
import {
  bpsToDiscountFold,
  derivePricingFromNewApiPricing,
  discountFoldToBps,
  dollarsToMicroUsd,
  formatDiscountRate,
  microUsdToDollars,
  normalizeDecimalString,
  normalizeGroupRatio,
  optionalDollarsToMicroUsd,
  quotaSpendFromEffectivePrice,
  resolveEffectiveCatalogPrice,
} from '@/features/api-catalog/lib/pricing';

test('catalog pricing helpers convert dollars per million tokens to micro-USD integers', () => {
  assert.equal(dollarsToMicroUsd(0.15), 150000);
  assert.equal(dollarsToMicroUsd('2.5'), 2500000);
  assert.equal(dollarsToMicroUsd(0), 0);
});

test('catalog pricing helpers reject negative and non-finite dollar values', () => {
  assert.throws(() => dollarsToMicroUsd(-0.01), /non-negative/);
  assert.throws(() => dollarsToMicroUsd('not-a-number'), /finite/);
  assert.throws(() => dollarsToMicroUsd(Number.NaN), /finite/);
  assert.throws(() => dollarsToMicroUsd(Number.POSITIVE_INFINITY), /finite/);
});

test('decimal parser normalizes finite non-negative decimal strings', () => {
  assert.equal(normalizeDecimalString(' 001.5000 '), '1.5');
  assert.equal(normalizeDecimalString('+0.500'), '0.5');
  assert.equal(normalizeDecimalString(1), '1');
  assert.throws(() => normalizeDecimalString('-0.1'), /non-negative/);
  assert.throws(() => normalizeDecimalString('NaN'), /finite/);
  assert.throws(() => normalizeDecimalString('Infinity'), /finite/);
});

test('New API group ratio parser stores decimal and round-half-up bps', () => {
  assert.deepEqual(normalizeGroupRatio('1', 'group_ratio'), {
    raw: '1',
    decimal: '1',
    bps: 10000,
    sourceKey: 'group_ratio',
  });
  assert.equal(normalizeGroupRatio('0.5').bps, 5000);
  assert.equal(normalizeGroupRatio('0.33335').bps, 3334);
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
    supported_endpoint_types: ['chat', 'image'],
  });

  assert.deepEqual(derived, {
    source: 'ratio',
    inputMicroUsd: 5000000,
    outputMicroUsd: 40000000,
    imageInputMicroUsd: 10000000,
    imageOutputMicroUsd: 40000000,
  });
});

test('New API text models do not derive image prices without image support', () => {
  const derived = derivePricingFromNewApiPricing({
    model_name: 'gpt-5.5',
    quota_type: 0,
    model_ratio: 1.25,
    completion_ratio: 8,
    image_ratio: null,
    supported_endpoint_types: ['responses'],
  });

  assert.deepEqual(derived, {
    source: 'ratio',
    inputMicroUsd: 2500000,
    outputMicroUsd: 20000000,
    imageInputMicroUsd: null,
    imageOutputMicroUsd: null,
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
    fixedPriceMicroUsd: 40000,
  });
});

test('effective price inherits matched New API group ratio for public presentation', () => {
  const effective = resolveEffectiveCatalogPrice({
    baseInputMicroUsd: 150000,
    baseOutputMicroUsd: 600000,
    groupRatioBps: 5000,
    pricePolicy: 'inherit_group',
    priceDriftStatus: 'matched',
    listInputMicroUsd: 150000,
    listOutputMicroUsd: 600000,
    discountNote: 'Official group ratio',
  });

  assert.equal(effective.publicConfirmed, true);
  assert.equal(effective.effectiveInputMicroUsd, 75000);
  assert.equal(effective.effectiveOutputMicroUsd, 300000);
  assert.equal(effective.pricePresentation.showPrice, true);
  assert.equal(effective.pricePresentation.showStrikethrough, true);
  assert.equal(effective.pricePresentation.discountLabel, '5 折 (50%)');
  assert.equal(effective.pricePresentation.note, 'Official group ratio');
});

test('unmatched listing multiplier remains hidden from public confirmed pricing', () => {
  const effective = resolveEffectiveCatalogPrice({
    baseInputMicroUsd: 150000,
    baseOutputMicroUsd: 600000,
    pricePolicy: 'listing_multiplier',
    discountRateBps: 5000,
    priceDriftStatus: 'needs_live_check',
    listInputMicroUsd: 150000,
    listOutputMicroUsd: 600000,
    discountNote: 'Legacy campaign',
  });

  assert.equal(effective.publicConfirmed, false);
  assert.equal(effective.pricePresentation.showPrice, false);
  assert.equal(effective.pricePresentation.showStrikethrough, false);
  assert.equal(effective.pricePresentation.discountLabel, undefined);
  assert.equal(effective.pricePresentation.note, undefined);
});

test('fixed-price or incomplete token prices stay hidden even when drift is matched', () => {
  const effective = resolveEffectiveCatalogPrice({
    baseInputMicroUsd: null,
    baseOutputMicroUsd: null,
    groupRatioBps: 5000,
    pricePolicy: 'inherit_group',
    priceDriftStatus: 'matched',
    listInputMicroUsd: 150000,
    listOutputMicroUsd: 600000,
  });

  assert.equal(effective.publicConfirmed, false);
  assert.equal(effective.effectiveInputMicroUsd, null);
  assert.equal(effective.effectiveOutputMicroUsd, null);
  assert.equal(effective.pricePresentation.showPrice, false);
});

test('verified price override still requires matched drift status', () => {
  const unmatched = resolveEffectiveCatalogPrice({
    pricePolicy: 'price_override',
    overrideInputMicroUsd: 1,
    overrideOutputMicroUsd: 2,
    overrideStatus: 'verified',
    priceDriftStatus: 'needs_live_check',
  });
  const matched = resolveEffectiveCatalogPrice({
    pricePolicy: 'price_override',
    overrideInputMicroUsd: 1,
    overrideOutputMicroUsd: 2,
    overrideStatus: 'verified',
    priceDriftStatus: 'matched',
  });

  assert.equal(unmatched.publicConfirmed, false);
  assert.equal(matched.publicConfirmed, true);
  assert.equal(matched.effectiveInputMicroUsd, 1);
  assert.equal(matched.effectiveOutputMicroUsd, 2);
});

test('quota spend uses the same effective micro-USD integers as public pricing', () => {
  assert.equal(
    quotaSpendFromEffectivePrice({
      inputTokens: 1_000_000,
      outputTokens: 500_000,
      effectiveInputMicroUsd: 75000,
      effectiveOutputMicroUsd: 300000,
      quotaPerUnit: 500_000,
    }),
    112500
  );
});
