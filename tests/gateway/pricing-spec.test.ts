import assert from 'node:assert/strict';
import test from 'node:test';

import { compileSkuRule } from '@/features/api-catalog/lib/sku-rule';
import {
  computePricingCharge,
  validatePricingSpec,
} from '@/features/gateway/lib/pricing-spec';

test('Token 计费按 unitSize 分组后统一向上取整', () => {
  const spec = validatePricingSpec({
    version: 1,
    basis: 'token',
    rates: [
      {
        meterKey: 'input',
        skuKey: 'default',
        unitSize: 1_000_000,
        priceMicroUsd: 2_500_000,
      },
      {
        meterKey: 'output',
        skuKey: 'default',
        unitSize: 1_000_000,
        priceMicroUsd: 10_000_000,
      },
      {
        meterKey: 'web_search',
        skuKey: 'default',
        unitSize: 1,
        priceMicroUsd: 20_000,
      },
    ],
  });
  const result = computePricingCharge(spec, {
    meters: { input: 1, output: 1 },
    webSearchCount: 2,
  });
  assert.equal(result.charged, BigInt(40_013));
  assert.deepEqual(result.unpricedMeters, []);
});

test('按次按可信实际数量与 SKU 计费', () => {
  const spec = validatePricingSpec({
    version: 1,
    basis: 'unit',
    quantityMeter: 'output_count',
    rates: [
      {
        meterKey: 'output_count',
        skuKey: 'default',
        unitSize: 1,
        priceMicroUsd: 300_000,
      },
      {
        meterKey: 'output_count',
        skuKey: 'quality=low;size=1024x1024',
        unitSize: 1,
        priceMicroUsd: 15_000,
      },
    ],
    skuRule: compileSkuRule(
      'when quality == "low" && size == "1024x1024" => "quality=${quality};size=${size}"\nelse => "default"',
      { allowedFields: ['quality', 'size'] }
    ),
  });
  assert.equal(
    computePricingCharge(spec, {
      meters: {},
      webSearchCount: 0,
      skuKey: 'quality=low;size=1024x1024',
      quantity: 2,
    }).charged,
    BigInt(30_000)
  );
});

test('按时长以毫秒计量、按秒价格向上取整', () => {
  const spec = validatePricingSpec({
    version: 1,
    basis: 'duration',
    quantityMeter: 'audio_duration_ms',
    rates: [
      {
        meterKey: 'audio_duration_ms',
        skuKey: 'default',
        unitSize: 1_000,
        priceMicroUsd: 2_000,
      },
    ],
    skuRule: compileSkuRule('else => "default"', {
      allowedFields: ['format', 'voice'],
    }),
  });
  assert.equal(
    computePricingCharge(spec, {
      meters: {},
      webSearchCount: 0,
      skuKey: 'default',
      quantity: 1_501,
    }).charged,
    BigInt(3_002)
  );
});

test('非法分类形态、重复费率与缺省 SKU fail closed', () => {
  assert.throws(
    () =>
      validatePricingSpec({
        version: 1,
        basis: 'unit',
        quantityMeter: 'audio_duration_ms',
        rates: [],
      }),
    /费率|duration/
  );
  assert.throws(
    () =>
      validatePricingSpec({
        version: 1,
        basis: 'token',
        rates: [
          {
            meterKey: 'input',
            skuKey: 'default',
            unitSize: 1_000_000,
            priceMicroUsd: 1,
          },
          {
            meterKey: 'input',
            skuKey: 'default',
            unitSize: 1_000_000,
            priceMicroUsd: 2,
          },
        ],
      }),
    /重复费率/
  );
  assert.throws(
    () =>
      validatePricingSpec({
        version: 1,
        basis: 'unit',
        quantityMeter: 'output_count',
        rates: [
          {
            meterKey: 'output_count',
            skuKey: 'default',
            unitSize: 1,
            priceMicroUsd: 1,
          },
        ],
        skuRule: {
          version: 1,
          rules: [
            {
              conditions: [],
              output: { type: 'sku', template: 'default' },
            },
          ],
          fallback: { type: 'reject' },
        },
      }),
    /条件数量/
  );
});
