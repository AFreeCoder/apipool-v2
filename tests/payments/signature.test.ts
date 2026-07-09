import assert from 'node:assert/strict';
import test from 'node:test';

import { timingSafeEqualHex } from '@/extensions/payment/signature';

test('timingSafeEqualHex accepts identical signatures', () => {
  assert.equal(timingSafeEqualHex('deadbeef', 'deadbeef'), true);
});

test('timingSafeEqualHex rejects different or differently sized signatures', () => {
  assert.equal(timingSafeEqualHex('deadbeef', 'deadbeee'), false);
  assert.equal(timingSafeEqualHex('deadbeef', 'deadbee'), false);
  assert.equal(timingSafeEqualHex('', 'a'), false);
  assert.equal(timingSafeEqualHex('a', ''), false);
});

test('timingSafeEqualHex rejects non-string input instead of throwing', () => {
  assert.equal(timingSafeEqualHex(undefined as any, 'a'), false);
  assert.equal(timingSafeEqualHex('a', null as any), false);
});
