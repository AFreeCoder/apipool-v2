import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CatalogPricingFormError,
  parseModelPricingFormData,
} from '@/features/api-catalog/server/model-pricing-form';

const messages = {
  invalidPrice: '价格无效',
  invalidCapabilities: '能力声明无效',
  invalidThreshold: '阈值无效',
  invalidTiers: '档位无效',
  missingRequiredPrice: '缺少价格',
};

function form(values: Record<string, string>) {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
}

test('token 表单按能力声明解析完整 meter 与长档价格', () => {
  const parsed = parseModelPricingFormData(
    form({
      billingScheme: 'token',
      sourceSupportedEndpointTypes: JSON.stringify(['responses']),
      billingCapabilitiesJson: JSON.stringify({
        cached_input: true,
        cache_write: true,
        cache_ttl_split: true,
        web_search: true,
        long_context: true,
      }),
      inputMicroUsd: '1.25',
      cachedInputMicroUsd: '0.125',
      cacheWrite5mMicroUsd: '1.5625',
      cacheWrite1hMicroUsd: '2.5',
      outputMicroUsd: '10',
      webSearchMicroUsd: '0.01',
      longContextThresholdTokens: '272000',
      inputLongMicroUsd: '2.5',
      cachedInputLongMicroUsd: '0.25',
      cacheWriteLongMicroUsd: '3.125',
      outputLongMicroUsd: '15',
      tiersJson: '[]',
    }),
    messages
  );

  assert.equal(parsed.billingScheme, 'token');
  assert.equal(parsed.inputMicroUsd, 1_250_000);
  assert.equal(parsed.cacheWrite1hMicroUsd, 2_500_000);
  assert.equal(parsed.webSearchMicroUsd, 10_000);
  assert.equal(parsed.longContextThresholdTokens, 272_000);
  assert.equal(parsed.outputLongMicroUsd, 15_000_000);
});

test('能力声明要求的 meter 缺价时返回可直接透出的门禁原因', () => {
  assert.throws(
    () =>
      parseModelPricingFormData(
        form({
          billingScheme: 'token',
          sourceSupportedEndpointTypes: JSON.stringify(['responses']),
          billingCapabilitiesJson: JSON.stringify({ web_search: true }),
          inputMicroUsd: '1',
          outputMicroUsd: '2',
          tiersJson: '[]',
        }),
        messages
      ),
    (error) =>
      error instanceof CatalogPricingFormError &&
      error.message === '缺少价格: web_search'
  );
});

test('per_call 表单保留 SKU 行并强制 default 档', () => {
  const parsed = parseModelPricingFormData(
    form({
      billingScheme: 'per_call',
      billingCapabilitiesJson: '{}',
      sourceSupportedEndpointTypes: JSON.stringify(['images']),
      tiersJson: JSON.stringify([
        { skuKey: 'default', price: '0.3', note: '最贵兜底' },
        { skuKey: 'quality=low;size=1024x1024', price: '0.015' },
      ]),
    }),
    messages
  );
  assert.deepEqual(parsed.tiers, [
    { skuKey: 'default', priceMicroUsd: 300_000, note: '最贵兜底' },
    {
      skuKey: 'quality=low;size=1024x1024',
      priceMicroUsd: 15_000,
      note: null,
    },
  ]);

  assert.throws(
    () =>
      parseModelPricingFormData(
        form({
          billingScheme: 'per_call',
          billingCapabilitiesJson: '{}',
          tiersJson: JSON.stringify([{ skuKey: 'low', price: '0.01' }]),
        }),
        messages
      ),
    CatalogPricingFormError
  );

  assert.throws(
    () =>
      parseModelPricingFormData(
        form({
          billingScheme: 'per_call',
          billingCapabilitiesJson: '{}',
          tiersJson: JSON.stringify([{ skuKey: 'default', price: '0' }]),
        }),
        messages
      ),
    CatalogPricingFormError
  );
});
