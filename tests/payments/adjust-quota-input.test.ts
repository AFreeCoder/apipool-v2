import assert from 'node:assert/strict';
import test from 'node:test';

import { parseWalletAdjustmentAmount } from '@/features/wallet/lib/adjustment-input';

test('quota adjustments accept whole dollars in both directions', () => {
  assert.equal(parseWalletAdjustmentAmount(5).amountUsd, 5);
  assert.equal(parseWalletAdjustmentAmount(-10).amountUsd, -10);
  assert.equal(parseWalletAdjustmentAmount('25').amountUsd, 25);
});

test('quota adjustments reject non-integer dollars', () => {
  // ledger.amountUsd 是美元整数（5 = $5）。SQLite 动态类型不会拦 10.5，
  // 写进去就破坏了整张表的口径。
  assert.throws(() => parseWalletAdjustmentAmount(10.5), /integer/i);
  assert.throws(() => parseWalletAdjustmentAmount(-0.01), /integer/i);
});

test('quota adjustments reject zero, non-numbers and infinities', () => {
  assert.throws(() => parseWalletAdjustmentAmount(0), /non-zero/i);
  assert.throws(() => parseWalletAdjustmentAmount('abc'), /non-zero/i);
  assert.throws(() => parseWalletAdjustmentAmount(Infinity), /non-zero/i);
});

test('quota adjustments are bounded so a typo cannot mint a fortune', () => {
  assert.equal(parseWalletAdjustmentAmount(100000).amountUsd, 100000);
  assert.throws(() => parseWalletAdjustmentAmount(100001), /exceeds/i);
  assert.throws(() => parseWalletAdjustmentAmount(-100001), /exceeds/i);
});
