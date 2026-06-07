import assert from 'node:assert/strict';
import test from 'node:test';

import { createAdjustmentLedgerDraft } from '@/features/apipool-ledger/lib/ledger';

test('ledger draft keeps New API as executor and records portal audit fields', () => {
  const draft = createAdjustmentLedgerDraft({
    portalUserId: 'user_1',
    operatorUserId: 'ops_1',
    amountUsd: 25,
    reason: 'manual launch credit',
    newapiUserId: 'newapi_1',
    newapiChangeId: 'chg_1',
  });

  assert.equal(draft.source, 'manual_adjustment');
  assert.equal(draft.status, 'applied');
  assert.equal(draft.executor, 'newapi');
  assert.equal(draft.amountUsd, 25);
  assert.equal(draft.reason, 'manual launch credit');
  assert.equal(draft.rollbackStatus, 'not_required');
});
