import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildCreateKeyRequest,
  buildGroupSelectOptions,
} from '@/features/api-console/lib/key-request';

test('buildCreateKeyRequest sends a public group slug without model or internal fields', () => {
  const body = buildCreateKeyRequest('  Smoke key  ', ' official ');

  assert.deepEqual(body, {
    name: 'Smoke key',
    groupSlug: 'official',
  });
  assert.equal(Object.hasOwn(body, 'allowedModels'), false);
  assert.equal(Object.hasOwn(body, 'id'), false);
  assert.equal(Object.hasOwn(body, 'groupId'), false);
  assert.equal(Object.hasOwn(body, 'newapiGroup'), false);
});

test('buildCreateKeyRequest applies the stable default key name', () => {
  assert.deepEqual(buildCreateKeyRequest('   ', 'official'), {
    name: 'Default APIPool key',
    groupSlug: 'official',
  });
});

test('buildGroupSelectOptions uses slug as option value and omits internal group fields', () => {
  const options = buildGroupSelectOptions([
    {
      slug: 'official',
      name: 'Official',
      userDescription: 'Stable public route',
      id: 'catalog_group_internal_official',
      newapiGroup: 'ng-official',
    } as any,
  ]);

  assert.deepEqual(options, [
    {
      value: 'official',
      label: 'Official',
      description: 'Stable public route',
    },
  ]);
  assert.equal(
    JSON.stringify(options).includes('catalog_group_internal'),
    false
  );
  assert.equal(JSON.stringify(options).includes('ng-official'), false);
});
