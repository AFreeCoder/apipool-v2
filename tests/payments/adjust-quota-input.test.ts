import assert from 'node:assert/strict';
import test from 'node:test';

import { parseQuotaAdjustmentAmount } from '@/features/newapi-bridge/lib/quota-input';

test('quota adjustments accept whole dollars in both directions', () => {
  assert.equal(parseQuotaAdjustmentAmount(5).amountUsd, 5);
  assert.equal(parseQuotaAdjustmentAmount(-10).amountUsd, -10);
  assert.equal(parseQuotaAdjustmentAmount('25').amountUsd, 25);
});

test('quota adjustments reject non-integer dollars', () => {
  // ledger.amountUsd 是美元整数（5 = $5）。SQLite 动态类型不会拦 10.5，
  // 写进去就破坏了整张表的口径。
  assert.throws(() => parseQuotaAdjustmentAmount(10.5), /integer/i);
  assert.throws(() => parseQuotaAdjustmentAmount(-0.01), /integer/i);
});

test('quota adjustments reject zero, non-numbers and infinities', () => {
  assert.throws(() => parseQuotaAdjustmentAmount(0), /non-zero/i);
  assert.throws(() => parseQuotaAdjustmentAmount('abc'), /non-zero/i);
  assert.throws(() => parseQuotaAdjustmentAmount(Infinity), /non-zero/i);
});

test('quota adjustments are bounded so a typo cannot mint a fortune', () => {
  assert.equal(parseQuotaAdjustmentAmount(100000).amountUsd, 100000);
  assert.throws(() => parseQuotaAdjustmentAmount(100001), /exceeds/i);
  assert.throws(() => parseQuotaAdjustmentAmount(-100001), /exceeds/i);
});
