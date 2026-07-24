import assert from 'node:assert/strict';
import test from 'node:test';

import { filterModelPricingCandidates } from '@/features/api-catalog/server/model-candidate-search';

const openAiVendor = {
  id: 'seed_vendor_openai',
  slug: 'OpenAI',
  name: 'OpenAI',
};

const candidates = [
  {
    modelId: 'gpt-4o-mini',
    displayName: 'GPT-4o mini',
    vendorId: 'openai',
    vendorName: 'OpenAI',
    enabledGroups: ['official'],
  },
  {
    modelId: 'gpt-4o',
    displayName: 'GPT-4o',
    vendorId: '1',
    vendorName: 'OpenAI',
    enabledGroups: ['discount-1'],
  },
  {
    modelId: 'claude-sonnet-4',
    displayName: 'Claude Sonnet 4',
    vendorId: 'anthropic',
    vendorName: 'Anthropic',
    enabledGroups: ['official'],
  },
];

test('model pricing candidate search matches local vendor against remote vendor id or name', () => {
  const models = filterModelPricingCandidates({
    pricing: candidates,
    keyword: 'gpt',
    localVendorId: openAiVendor.id,
    vendor: openAiVendor,
    limit: 20,
  });

  assert.deepEqual(
    models.map((model) => model.modelId),
    ['gpt-4o-mini', 'gpt-4o']
  );
});

test('model pricing candidate search filters by selected New API group', () => {
  const models = filterModelPricingCandidates({
    pricing: candidates,
    keyword: 'gpt',
    localVendorId: openAiVendor.id,
    vendor: openAiVendor,
    newapiGroup: 'discount-1',
    limit: 20,
  });

  assert.deepEqual(
    models.map((model) => model.modelId),
    ['gpt-4o']
  );
});

test('model pricing candidate search filters keyword case-insensitively', () => {
  const models = filterModelPricingCandidates({
    pricing: candidates,
    keyword: 'SONNET',
    localVendorId: '',
    vendor: null,
    limit: 20,
  });

  assert.deepEqual(
    models.map((model) => model.modelId),
    ['claude-sonnet-4']
  );
});
