import assert from 'node:assert/strict';
import test from 'node:test';
import {
  bpsToDiscountFold,
  derivePricingFromNewApiPricing,
  discountFoldToBps,
  dollarsToMicroUsd,
  microUsdToDollars,
  normalizeDecimalString,
  normalizeGroupRatio,
  optionalDollarsToMicroUsd,
  quotaSpendFromEffectivePrice,
  resolveEffectiveCatalogPrice,
  scaleMicroUsdByBps,
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
  // 折扣文案不再由服务层预格式化（formatDiscountRate 已删除）：只保留结构化
  // bps↔fold 转换，「折」的中文文案改由页面按 locale 词条渲染，避免漏进英文站。
  assert.equal(bpsToDiscountFold(null), '');
  assert.throws(() => discountFoldToBps('0'), /between 0.01 and 10/);
  assert.throws(() => discountFoldToBps('11'), /between 0.01 and 10/);
});

test('售价折算只在快照桥使用 round-half-up 舍入', () => {
  assert.equal(scaleMicroUsdByBps(1, 4_999), 0);
  assert.equal(scaleMicroUsdByBps(1, 5_000), 1);
  assert.equal(scaleMicroUsdByBps(3, 5_000), 2);
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
    cachedInputMicroUsd: 5000000,
    cacheWriteMicroUsd: null,
    cacheWrite1hMicroUsd: null,
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
    cache_ratio: 0.1,
    image_ratio: null,
    supported_endpoint_types: ['responses'],
  });

  assert.deepEqual(derived, {
    source: 'ratio',
    inputMicroUsd: 2500000,
    cachedInputMicroUsd: 250000,
    cacheWriteMicroUsd: null,
    cacheWrite1hMicroUsd: null,
    outputMicroUsd: 20000000,
    imageInputMicroUsd: null,
    imageOutputMicroUsd: null,
  });
});

test('New API cache write keeps OpenAI single bucket and Anthropic 5m/1h split', () => {
  const openai = derivePricingFromNewApiPricing({
    model_name: 'gpt-5.6-sol',
    quota_type: 0,
    model_ratio: 2.5,
    completion_ratio: 6,
    cache_ratio: 0.1,
    create_cache_ratio: 1.25,
    supported_endpoint_types: ['openai', 'openai-response'],
  });
  assert.equal(openai.cacheWriteMicroUsd, 6250000);
  assert.equal(openai.cacheWrite1hMicroUsd, null);

  const anthropic = derivePricingFromNewApiPricing({
    model_name: 'claude-sonnet',
    quota_type: 0,
    model_ratio: 1.5,
    completion_ratio: 5,
    cache_ratio: 0.1,
    create_cache_ratio: 1.25,
    supported_endpoint_types: ['anthropic'],
  });
  assert.equal(anthropic.cacheWriteMicroUsd, 3750000);
  assert.equal(anthropic.cacheWrite1hMicroUsd, 6000000);
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
    cachedInputMicroUsd: null,
    cacheWriteMicroUsd: null,
    cacheWrite1hMicroUsd: null,
    outputMicroUsd: null,
    imageInputMicroUsd: null,
    imageOutputMicroUsd: null,
    fixedPriceMicroUsd: 40000,
  });
});

test('effective price applies the matched listing discount for public presentation', () => {
  const effective = resolveEffectiveCatalogPrice({
    baseInputMicroUsd: 150000,
    baseOutputMicroUsd: 600000,
    discountRateBps: 5000,
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
  // 折扣以结构化 bps 回传，由页面按 locale 渲染；服务层不产出任何语言的文案
  assert.equal(effective.pricePresentation.discountBps, 5000);
  assert.equal(
    (effective.pricePresentation as any).discountLabel,
    undefined,
    'pricePresentation must not carry a pre-formatted, single-language label'
  );
  assert.equal(effective.pricePresentation.note, 'Official group ratio');
});

test('unmatched listing discount remains hidden from public confirmed pricing', () => {
  const effective = resolveEffectiveCatalogPrice({
    baseInputMicroUsd: 150000,
    baseOutputMicroUsd: 600000,
    discountRateBps: 5000,
    priceDriftStatus: 'needs_live_check',
    listInputMicroUsd: 150000,
    listOutputMicroUsd: 600000,
    discountNote: 'Legacy campaign',
  });

  assert.equal(effective.publicConfirmed, false);
  assert.equal(effective.pricePresentation.showPrice, false);
  assert.equal(effective.pricePresentation.showStrikethrough, false);
  assert.equal(effective.pricePresentation.discountBps, undefined);
  assert.equal(effective.pricePresentation.note, undefined);
});

test('fixed-price or incomplete token prices stay hidden even when drift is matched', () => {
  const effective = resolveEffectiveCatalogPrice({
    baseInputMicroUsd: null,
    baseOutputMicroUsd: null,
    discountRateBps: 5000,
    priceDriftStatus: 'matched',
    listInputMicroUsd: 150000,
    listOutputMicroUsd: 600000,
  });

  assert.equal(effective.publicConfirmed, false);
  assert.equal(effective.effectiveInputMicroUsd, null);
  assert.equal(effective.effectiveOutputMicroUsd, null);
  assert.equal(effective.pricePresentation.showPrice, false);
});

test('成本守卫状态只告警，不隐藏已配置的门户售价', () => {
  for (const priceDriftStatus of ['ok', 'cost_changed', 'cost_alert']) {
    const effective = resolveEffectiveCatalogPrice({
      baseInputMicroUsd: 2,
      baseOutputMicroUsd: 4,
      discountRateBps: 5000,
      priceDriftStatus,
    });

    assert.equal(effective.publicConfirmed, true);
    assert.equal(effective.effectiveInputMicroUsd, 1);
    assert.equal(effective.effectiveOutputMicroUsd, 2);
  }
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

test('public pricing never emits a Chinese-only discount label', async () => {
  const { readFile } = await import('node:fs/promises');

  // /models 是核心营销页；折扣标签一旦硬编码「折」，英文站会直接显示中文
  const page = await readFile(
    'src/app/[locale]/(landing)/models/page.tsx',
    'utf8'
  );
  assert.doesNotMatch(page, /discountLabel/);
  assert.match(page, /discountBps/);

  for (const locale of ['en', 'zh']) {
    const messages = JSON.parse(
      await readFile(
        `src/config/locale/messages/${locale}/pages/models.json`,
        'utf8'
      )
    );
    assert.ok(
      messages.table?.discount,
      `${locale}/pages/models.json must define table.discount`
    );
  }

  const en = JSON.parse(
    await readFile('src/config/locale/messages/en/pages/models.json', 'utf8')
  );
  assert.doesNotMatch(
    en.table.discount,
    /折/,
    'the English discount label must not contain Chinese characters'
  );
});

test('公开价保留有效小数，低价模型不被 toFixed(2) 抹平', async () => {
  const { formatMicroUsdPerMillion } = await import(
    '@/features/api-catalog/lib/catalog'
  );

  // toFixed(2) 会把 $0.0375 显示成 $0.04（+6.7%）、$0.075 显示成 $0.07（−6.7%），
  // 与账单口径对不上。flash / mini 档常见就是这些定价。
  assert.equal(formatMicroUsdPerMillion(37500), '$0.0375');
  assert.equal(formatMicroUsdPerMillion(75000), '$0.075');
  assert.equal(formatMicroUsdPerMillion(127500), '$0.1275');

  // 常规价格仍保留两位，不因此变成 $0.15 → $0.15
  assert.equal(formatMicroUsdPerMillion(150000), '$0.15');
  assert.equal(formatMicroUsdPerMillion(600000), '$0.60');
  assert.equal(formatMicroUsdPerMillion(3000000), '$3.00');
  assert.equal(formatMicroUsdPerMillion(0), '$0.00');
});
