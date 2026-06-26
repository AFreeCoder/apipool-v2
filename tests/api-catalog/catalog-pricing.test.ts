import assert from 'node:assert/strict';
import test from 'node:test';
import {
  dollarsToMicroUsd,
  microUsdToDollars,
} from '@/features/api-catalog/lib/pricing';

test('catalog pricing helpers convert dollars per million tokens to micro-USD integers', () => {
  assert.equal(dollarsToMicroUsd(0.15), 150000);
  assert.equal(dollarsToMicroUsd('2.5'), 2500000);
  assert.equal(dollarsToMicroUsd(0), 0);
});

test('catalog pricing helpers reject negative and non-finite dollar values', () => {
  assert.throws(() => dollarsToMicroUsd(-0.01), /non-negative/);
  assert.throws(() => dollarsToMicroUsd('not-a-number'), /finite/);
});

test('catalog pricing helpers convert stored micro-USD values back to dollar form input values', () => {
  assert.equal(microUsdToDollars(150000), '0.15');
  assert.equal(microUsdToDollars(2500000), '2.5');
  assert.equal(microUsdToDollars(null), '');
});
