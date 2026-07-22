import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  buildBalanceAdjustments,
  buildBillingUsageCharges,
} from '@/features/api-console/lib/billing';

test('billing usage charges only include synced logs with real spend', () => {
  const rows = buildBillingUsageCharges({
    logs: [
      {
        id: 'request_1',
        keyMasked: 'sk-...paid',
        modelId: 'gpt-4o-mini',
        status: 'success',
        inputTokens: 12,
        outputTokens: 8,
        spendUsd: 0.01,
        createdAt: new Date('2026-05-24T12:00:00.000Z'),
      },
      {
        id: 'request_without_spend',
        keyMasked: 'sk-...unknown',
        modelId: 'gpt-4o-mini',
        status: 'success',
        inputTokens: 10,
        outputTokens: 5,
        createdAt: new Date('2026-05-24T12:01:00.000Z'),
      },
    ],
  });

  assert.deepEqual(rows, [
    {
      id: 'request_1',
      keyMasked: 'sk-...paid',
      modelId: 'gpt-4o-mini',
      status: 'success',
      tokenCount: 20,
      spendUsd: 0.01,
      createdAt: new Date('2026-05-24T12:00:00.000Z'),
    },
  ]);
  assert.equal(Object.hasOwn(rows[0], 'newapiRequestId'), false);
});

test('余额调整历史仅展示面向用户的必要字段', () => {
  const rows = buildBalanceAdjustments([
    {
      id: 'recharge_1',
      entryType: 'recharge',
      signedAmountUsd: 10,
      balanceAfterUsd: 10,
      createdAt: '2026-07-21T00:00:00.000Z',
    },
    {
      id: 'adjustment_1',
      entryType: 'manual_adjustment',
      signedAmountUsd: -2.5,
      balanceAfterUsd: 7.5,
      createdAt: '2026-07-21T01:00:00.000Z',
      reason: '内部客服备注，不应展示',
      operatorUserId: 'admin_1',
    } as any,
  ]);

  assert.deepEqual(rows, [
    {
      id: 'adjustment_1',
      amountUsd: -2.5,
      balanceAfterUsd: 7.5,
      createdAt: '2026-07-21T01:00:00.000Z',
    },
  ]);
  assert.equal(JSON.stringify(rows).includes('内部客服备注'), false);
  assert.equal(JSON.stringify(rows).includes('admin_1'), false);
});

test('billing API route only reads the wallet billing view', async () => {
  const source = await readFile('src/app/api/apipool/billing/route.ts', 'utf8');

  assert.match(source, /getWalletBillingView/);
  assert.doesNotMatch(source, /getPortalUsage|listBillingLedgerEntries/);
});

test('Checkout 关闭时，控制台充值入口与余额提醒统一隐藏', async () => {
  const [dashboard, billing, warning] = await Promise.all([
    readFile('src/app/[locale]/(landing)/dashboard/page.tsx', 'utf8'),
    readFile('src/app/[locale]/(landing)/dashboard/billing/page.tsx', 'utf8'),
    readFile('src/features/api-console/components/balance-warning.tsx', 'utf8'),
  ]);

  for (const source of [dashboard, billing, warning]) {
    assert.match(source, /checkoutEnabled/);
  }
  assert.match(dashboard, /canCheckout\s*\?/);
  assert.match(billing, /canCheckout\s*\?/);
  assert.match(warning, /if \(!checkoutEnabled\(\)\) return null/);
});

test('账单页展示管理员余额调整但不暴露内部原因', async () => {
  const billing = await readFile(
    'src/app/[locale]/(landing)/dashboard/billing/page.tsx',
    'utf8'
  );

  assert.match(billing, /buildBalanceAdjustments\(wallet\.ledger\)/);
  assert.match(billing, /balanceAdjustments\.sources\.manualAdjustment/);
  assert.doesNotMatch(billing, /entry\.reason/);
});
