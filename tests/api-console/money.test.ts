import assert from 'node:assert/strict';
import test from 'node:test';

import { formatUsdAmount } from '@/features/api-console/lib/money';

test('formatUsdAmount renders fixed six-decimal USD amounts', () => {
  assert.equal(formatUsdAmount(0), '$0.000000');
  assert.equal(formatUsdAmount(5), '$5.000000');
  assert.equal(formatUsdAmount('12.3456789'), '$12.345679');
  assert.equal(formatUsdAmount(-0.25), '$-0.250000');
});

test('formatUsdAmount hides missing or invalid amounts', () => {
  for (const value of [null, undefined, '', 'not-a-number', Number.NaN]) {
    assert.doesNotMatch(formatUsdAmount(value as any), /^\$/);
  }
});
