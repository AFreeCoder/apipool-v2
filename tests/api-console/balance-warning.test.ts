import assert from 'node:assert/strict';
import test from 'node:test';
import { isValidElement } from 'react';
import {
  BalanceWarning,
  isLowBalance,
} from '@/features/api-console/components/balance-warning';

function collectText(node: unknown): string {
  if (node === null || node === undefined || typeof node === 'boolean') {
    return '';
  }
  if (typeof node === 'string' || typeof node === 'number') {
    return String(node);
  }
  if (Array.isArray(node)) {
    return node.map(collectText).join('');
  }
  if (isValidElement(node)) {
    return collectText((node.props as { children?: unknown }).children);
  }
  return '';
}

function hasHref(node: unknown, href: string): boolean {
  if (node === null || node === undefined || typeof node === 'boolean') {
    return false;
  }
  if (Array.isArray(node)) {
    return node.some((child) => hasHref(child, href));
  }
  if (!isValidElement(node)) {
    return false;
  }

  const props = node.props as { children?: unknown; href?: unknown };
  return props.href === href || hasHref(props.children, href);
}

test('isLowBalance only reports balances at or below the threshold', () => {
  assert.equal(isLowBalance(0), true);
  assert.equal(isLowBalance(0, 0), true);
  assert.equal(isLowBalance(5), false);
  assert.equal(isLowBalance(-0.01), true);
});

test('isLowBalance does not report missing balance data', () => {
  assert.equal(isLowBalance(null), false);
  assert.equal(isLowBalance(undefined), false);
});

test('BalanceWarning renders a low balance prompt with an add credit link', () => {
  const warning = BalanceWarning({ balanceUsd: 0 });

  assert.ok(isValidElement(warning));
  assert.match(collectText(warning), /Low balance — please top up/);
  assert.equal(hasHref(warning, '/dashboard/billing'), true);
});

test('BalanceWarning renders nothing when balance is above threshold or missing', () => {
  assert.equal(BalanceWarning({ balanceUsd: 5 }), null);
  assert.equal(BalanceWarning({ balanceUsd: null }), null);
  assert.equal(BalanceWarning({ balanceUsd: undefined }), null);
});
