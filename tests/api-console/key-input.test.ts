import assert from 'node:assert/strict';
import test from 'node:test';

import {
  API_KEY_CREATION_PAUSED_MESSAGE,
  assertPortalApiKeyCreationEnabled,
  sanitizePortalApiKeyCreateInput,
} from '@/features/api-console/lib/key-input';

test('customer key creation input ignores model, quota, and network controls', () => {
  const input = sanitizePortalApiKeyCreateInput({
    name: '  Smoke key  ',
    allowedModels: ['unverified-model'],
    quotaLimit: 999,
    ipAllowlist: ['0.0.0.0/0'],
  });

  assert.deepEqual(input, {
    name: 'Smoke key',
  });
  assert.equal(Object.hasOwn(input, 'allowedModels'), false);
  assert.equal(Object.hasOwn(input, 'quotaLimit'), false);
  assert.equal(Object.hasOwn(input, 'ipAllowlist'), false);
});

test('customer key creation input uses a stable default name', () => {
  const input = sanitizePortalApiKeyCreateInput({ name: '   ' });

  assert.equal(input.name, 'Default APIPool key');
  assert.equal(Object.hasOwn(input, 'allowedModels'), false);
});

test('portal key creation guard can pause rollback entrypoint', () => {
  assert.doesNotThrow(() => assertPortalApiKeyCreationEnabled(true));
  assert.throws(
    () => assertPortalApiKeyCreationEnabled(false),
    new RegExp(API_KEY_CREATION_PAUSED_MESSAGE)
  );
});
