import assert from 'node:assert/strict';
import test from 'node:test';

import { buildBillingUsageCharges } from '@/features/api-console/lib/billing';

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
