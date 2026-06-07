import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getPublicPortalErrorMessage,
  getPublicUsageSyncErrorMessage,
} from '@/features/api-console/lib/public-errors';
import { NewApiBridgeError } from '@/features/newapi-bridge/server/client';

test('public portal errors do not expose New API bridge internals', () => {
  const fallback = 'Create API key is temporarily unavailable.';
  const samples = [
    'NEWAPI_BASE_URL is not configured',
    'NEWAPI_ADMIN_TOKEN is not configured',
    'New API request failed with status 403',
    'Malformed New API response for /api/admin/users/newapi_1/quota',
    new NewApiBridgeError({
      code: 'timeout',
      message: 'New API request timed out after 15000ms',
    }),
  ];

  for (const sample of samples) {
    const message = getPublicPortalErrorMessage(sample, fallback);
    assert.equal(message, fallback);
    assert.doesNotMatch(message, /new\s*api|newapi|NEWAPI|admin\/users/i);
  }
});

test('public portal errors keep safe validation copy', () => {
  assert.equal(
    getPublicPortalErrorMessage('API key not found', 'fallback'),
    'API key not found'
  );
  assert.equal(
    getPublicPortalErrorMessage(
      new Error('This key cannot be disabled in its current state.'),
      'fallback'
    ),
    'This key cannot be disabled in its current state.'
  );
});

test('usage sync errors use customer-safe copy', () => {
  const message = getPublicUsageSyncErrorMessage(
    new Error('NEWAPI_ADMIN_TOKEN is not configured')
  );

  assert.equal(
    message,
    'Usage sync is temporarily unavailable. Showing the latest available portal data.'
  );
  assert.doesNotMatch(message, /new\s*api|newapi|NEWAPI/i);
});
