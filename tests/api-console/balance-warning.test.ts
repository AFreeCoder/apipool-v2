import assert from 'node:assert/strict';
import test from 'node:test';
import { isValidElement, type ReactNode } from 'react';

import {
  BalanceWarningView,
  isLowBalance,
} from '@/features/api-console/components/balance-warning-view';

function TestLink({
  children,
}: {
  href: string;
  className?: string;
  children: ReactNode;
}) {
  return children;
}

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

function hasIntrinsicAnchorHref(node: unknown, href: string): boolean {
  if (node === null || node === undefined || typeof node === 'boolean') {
    return false;
  }
  if (Array.isArray(node)) {
    return node.some((child) => hasIntrinsicAnchorHref(child, href));
  }
  if (!isValidElement(node)) {
    return false;
  }

  const props = node.props as { children?: unknown; href?: unknown };
  return (
    (node.type === 'a' && props.href === href) ||
    hasIntrinsicAnchorHref(props.children, href)
  );
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
  const warning = BalanceWarningView({
    balanceUsd: 0,
    LinkComponent: TestLink,
    message: '余额较低，请及时充值',
    actionLabel: '充值',
  });

  assert.ok(isValidElement(warning));
  assert.match(collectText(warning), /余额较低，请及时充值/);
  assert.match(collectText(warning), /充值/);
  assert.equal(hasHref(warning, '/dashboard/billing'), true);
});

test('BalanceWarning uses client-side navigation for the billing link', () => {
  const warning = BalanceWarningView({
    balanceUsd: 0,
    LinkComponent: TestLink,
    message: 'Low balance',
    actionLabel: 'Add credit',
  });

  assert.equal(hasIntrinsicAnchorHref(warning, '/dashboard/billing'), false);
});

test('BalanceWarning renders nothing when balance is above threshold or missing', () => {
  assert.equal(
    BalanceWarningView({
      balanceUsd: 5,
      LinkComponent: TestLink,
      message: 'Low balance',
      actionLabel: 'Add credit',
    }),
    null
  );
  assert.equal(
    BalanceWarningView({
      balanceUsd: null,
      LinkComponent: TestLink,
      message: 'Low balance',
      actionLabel: 'Add credit',
    }),
    null
  );
  assert.equal(
    BalanceWarningView({
      balanceUsd: undefined,
      LinkComponent: TestLink,
      message: 'Low balance',
      actionLabel: 'Add credit',
    }),
    null
  );
});

test('bridge failures fall back to localized copy instead of an English sentence', async () => {
  const { getPublicUsageSyncErrorMessage } = await import(
    '@/features/api-console/lib/public-errors'
  );
  const { getUsageSyncDescription } = await import(
    '@/features/api-console/lib/status'
  );

  // 内部错误没有可安全展示给用户的文案 → 返回 undefined，让页面用 i18n 词条。
  // 原先返回英文兜底句，会盖掉 dashboard/common.json 里成套的中文 usageSync 文案，
  // 恰恰在用户最需要读懂提示的时刻。
  const bridgeError = { code: 'timeout', message: 'New API request timed out' };
  assert.equal(getPublicUsageSyncErrorMessage(bridgeError), undefined);

  assert.equal(
    getUsageSyncDescription(
      { status: 'failed', errorMessage: undefined } as any,
      { failed: '用量同步暂不可用，请稍后再试。' }
    ),
    '用量同步暂不可用，请稍后再试。'
  );
});

test('a safe non-internal message still reaches the user', async () => {
  const { getPublicUsageSyncErrorMessage } = await import(
    '@/features/api-console/lib/public-errors'
  );

  assert.equal(
    getPublicUsageSyncErrorMessage(new Error('Rate limit exceeded')),
    'Rate limit exceeded'
  );
});
