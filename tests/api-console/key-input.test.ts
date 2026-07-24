import assert from 'node:assert/strict';
import test from 'node:test';

import {
  API_KEY_CREATION_PAUSED_MESSAGE,
  assertPortalApiKeyCreationEnabled,
  sanitizePortalApiKeyCreateInput,
} from '@/features/api-console/lib/key-input';

test('customer key creation input requires a non-empty group slug', () => {
  assert.throws(
    () => sanitizePortalApiKeyCreateInput({ name: 'Missing group' }),
    /group is required/
  );
  assert.throws(
    () =>
      sanitizePortalApiKeyCreateInput({
        name: 'Blank group',
        groupSlug: '   ',
      }),
    /group is required/
  );
});

test('customer key creation input keeps only the public name and group slug', () => {
  const input = sanitizePortalApiKeyCreateInput({
    name: '  Smoke key  ',
    groupSlug: ' official ',
    allowedModels: ['unverified-model'],
    quotaLimit: 999,
    ipAllowlist: ['0.0.0.0/0'],
  });

  assert.deepEqual(input, {
    name: 'Smoke key',
    groupSlug: 'official',
  });
  assert.equal(Object.hasOwn(input, 'allowedModels'), false);
  assert.equal(Object.hasOwn(input, 'quotaLimit'), false);
  assert.equal(Object.hasOwn(input, 'ipAllowlist'), false);
});

test('customer key creation input uses a stable default name', () => {
  const input = sanitizePortalApiKeyCreateInput({
    name: '   ',
    groupSlug: 'official',
  });

  assert.equal(input.name, 'Your API key');
  assert.equal(input.groupSlug, 'official');
});

test('portal key creation guard can pause rollback entrypoint', () => {
  assert.doesNotThrow(() => assertPortalApiKeyCreationEnabled(true));
  assert.throws(
    () => assertPortalApiKeyCreationEnabled(false),
    new RegExp(API_KEY_CREATION_PAUSED_MESSAGE)
  );
});
