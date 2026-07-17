import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildModelFilterHref,
  filterModels,
  formatModelPrice,
  getCallableModelQuickstartCurl,
  getDefaultCallableModelId,
  getFeaturedModels,
  getModelBySlug,
  parseModelFilters,
  publicModels,
} from '@/features/api-catalog/lib/catalog';

test('catalog exposes one available model and hides no provider data', () => {
  const available = publicModels.filter(
    (model) => model.status === 'available'
  );

  assert.equal(available.length, 1);
  assert.equal(available[0].provider, 'OpenAI');
});

test('filterModels applies provider, capability, and status filters', () => {
  const results = filterModels(publicModels, {
    provider: 'Anthropic',
    capability: 'coding',
    status: 'coming_soon',
  });

  assert.ok(results.length > 0);
  assert.ok(results.every((model) => model.provider === 'Anthropic'));
  assert.ok(results.every((model) => model.capabilities.includes('coding')));
  assert.ok(results.every((model) => model.status === 'coming_soon'));
});

test('parseModelFilters keeps slug-based public filters without whitelist validation', () => {
  assert.deepEqual(
    parseModelFilters({
      vendor: 'anthropic',
      group: 'official',
      capability: 'coding',
      status: 'coming_soon',
    }),
    {
      vendor: 'anthropic',
      group: 'official',
      capability: 'coding',
      status: 'coming_soon',
    }
  );

  assert.deepEqual(
    parseModelFilters({
      vendor: 'unknown-vendor',
      group: 'unknown-group',
      capability: 'billing',
      status: 'internal',
    }),
    {
      vendor: 'unknown-vendor',
      group: 'unknown-group',
      capability: 'billing',
      status: 'internal',
    }
  );
});

test('buildModelFilterHref preserves slug filters and removes cleared dimensions', () => {
  assert.equal(
    buildModelFilterHref(
      { vendor: 'openai', group: 'official', status: 'available' },
      { capability: 'coding' }
    ),
    '/models?vendor=openai&group=official&capability=coding&status=available'
  );

  assert.equal(
    buildModelFilterHref(
      { vendor: 'openai', capability: 'coding', status: 'available' },
      { capability: '', status: undefined }
    ),
    '/models?vendor=openai'
  );
});

test('getModelBySlug returns undefined for unknown slugs', () => {
  assert.equal(getModelBySlug('gpt-4o-mini')?.modelId, 'gpt-4o-mini');
  assert.equal(getModelBySlug('missing-model'), undefined);
});

test('getFeaturedModels returns stable sort order and excludes coming soon by default', () => {
  const featured = getFeaturedModels(publicModels, 3);

  assert.equal(featured.length, 1);
  assert.deepEqual(
    featured.map((model) => model.slug),
    ['gpt-4o-mini']
  );
});

test('featured and default launch models只依赖可用状态', () => {
  const availableModel = {
    ...publicModels.find((model) => model.slug === 'gpt-4o')!,
    slug: 'unsafe-available',
    modelId: 'unsafe-available',
    status: 'available' as const,
    featured: true,
    sortOrder: 1,
  };

  const featured = getFeaturedModels([availableModel, ...publicModels], 6);

  assert.deepEqual(
    featured.map((model) => model.modelId),
    ['unsafe-available', 'gpt-4o-mini']
  );
  assert.equal(getDefaultCallableModelId('gpt-4o'), 'gpt-4o-mini');
  assert.equal(getDefaultCallableModelId('gpt-4o-mini'), 'gpt-4o-mini');
});

test('formatModelPrice includes reference billing copy', () => {
  const price = formatModelPrice(publicModels[0]);

  assert.match(price.summary, /\$0\.15/);
  assert.match(price.disclaimer, /页面价格仅供参考/);
});

test('quickstart curl is only generated for available models', () => {
  const available = publicModels.find((model) => model.status === 'available');
  const comingSoon = publicModels.find(
    (model) => model.status === 'coming_soon'
  );

  assert.ok(available);
  assert.ok(comingSoon);
  const availableCurl = getCallableModelQuickstartCurl(available);
  assert.ok(availableCurl);
  assert.match(availableCurl, /gpt-4o-mini/);
  assert.match(
    availableCurl,
    /https:\/\/api2\.apipool\.dev\/v1\/chat\/completions/
  );
  assert.equal(getCallableModelQuickstartCurl(comingSoon), null);
});

test('public model copy does not expose internal gateway names', () => {
  const forbidden = [/New API/i, /newapi/i, /internal service/i];
  const publicCopy = publicModels.flatMap((model) => [
    model.displayName,
    model.shortDescription,
    model.longDescription,
    model.pricing.note || '',
  ]);

  const violations = publicCopy.filter((text) =>
    forbidden.some((pattern) => pattern.test(text))
  );

  assert.deepEqual(violations, []);
});
