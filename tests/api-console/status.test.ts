import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canCleanupKeyStatus,
  canDeleteKeyStatus,
  canDisableKeyStatus,
  canRetryKeyStatus,
  getNextKeyStatus,
  getUsageLogRowKey,
  getUsageSyncDescription,
  getUsageSyncState,
} from '@/features/api-console/lib/status';

test('key status moves to active only after local binding succeeds', () => {
  assert.equal(
    getNextKeyStatus('creating_remote', 'remote_created_local_saved'),
    'active'
  );
  assert.equal(
    getNextKeyStatus('creating_remote', 'remote_created_local_failed'),
    'remote_created_binding_failed'
  );
});

test('disable and delete failures remain pending or retriable instead of completed', () => {
  assert.equal(
    getNextKeyStatus('disable_pending', 'remote_failed_retriable'),
    'failed_retriable'
  );
  assert.equal(
    getNextKeyStatus('disable_pending', 'remote_confirmed'),
    'disabled'
  );
  assert.equal(
    getNextKeyStatus('delete_pending', 'remote_confirmed'),
    'deleted'
  );
});

test('retriable statuses are explicit', () => {
  assert.equal(canRetryKeyStatus('failed_retriable'), true);
  assert.equal(canRetryKeyStatus('remote_created_binding_failed'), true);
  assert.equal(canRetryKeyStatus('failed_terminal'), false);
});

test('key mutation actions are available only for remotely actionable statuses', () => {
  assert.equal(canDisableKeyStatus('active'), true);
  assert.equal(canDisableKeyStatus('disabled'), false);
  assert.equal(canDisableKeyStatus('disable_pending'), false);
  assert.equal(canDisableKeyStatus('failed_retriable'), false);

  assert.equal(canDeleteKeyStatus('active'), true);
  assert.equal(canDeleteKeyStatus('disabled'), true);
  assert.equal(canDeleteKeyStatus('deleted'), false);
  assert.equal(canDeleteKeyStatus('delete_pending'), false);
  assert.equal(canDeleteKeyStatus('remote_created_binding_failed'), false);
});

test('failed/stuck statuses are cleanable so users can clear dead keys', () => {
  // 失败 / 卡死态可清理删除（让用户能清空被失败 Key 淹没的列表）
  assert.equal(canCleanupKeyStatus('creating_remote'), true);
  assert.equal(canCleanupKeyStatus('failed_retriable'), true);
  assert.equal(canCleanupKeyStatus('failed_terminal'), true);
  assert.equal(canCleanupKeyStatus('remote_created_binding_failed'), true);
  // 正常态不走清理（走标准 delete，需远端确认）；已删除 / 进行中不可再清理
  assert.equal(canCleanupKeyStatus('active'), false);
  assert.equal(canCleanupKeyStatus('disabled'), false);
  assert.equal(canCleanupKeyStatus('deleted'), false);
  assert.equal(canCleanupKeyStatus('delete_pending'), false);
});

test('usage sync state marks stale and failed windows', () => {
  const now = new Date('2026-05-24T12:00:00.000Z');

  assert.equal(getUsageSyncState(null, now), 'empty');
  assert.equal(
    getUsageSyncState(new Date('2026-05-24T11:56:00.000Z'), now),
    'ready'
  );
  assert.equal(
    getUsageSyncState(new Date('2026-05-24T11:20:00.000Z'), now),
    'stale'
  );
  assert.equal(
    getUsageSyncState(new Date('2026-05-24T09:30:00.000Z'), now),
    'failed'
  );
});

test('usage sync descriptions are readable for non-ready states', () => {
  assert.equal(
    getUsageSyncDescription({ status: 'empty' }),
    'No usage in the last 7 days yet.'
  );
  assert.match(
    getUsageSyncDescription({ status: 'syncing' }),
    /Syncing usage/i
  );
  assert.equal(
    getUsageSyncDescription({
      status: 'stale',
      errorMessage:
        'Usage sync is temporarily unavailable. Showing the latest available portal data.',
    }),
    'Usage sync is temporarily unavailable. Showing the latest available portal data.'
  );
  assert.match(
    getUsageSyncDescription({ status: 'failed' }),
    /temporarily unavailable/i
  );
});

test('usage log row keys remain unique when New API repeats request ids', () => {
  const first = getUsageLogRowKey(
    {
      id: 'remote_request_duplicate',
      modelId: 'gpt-4o-mini',
      createdAt: new Date('2026-05-24T10:00:00.000Z'),
    },
    0
  );
  const second = getUsageLogRowKey(
    {
      id: 'remote_request_duplicate',
      modelId: 'gpt-4o-mini',
      createdAt: new Date('2026-05-24T10:00:00.000Z'),
    },
    1
  );

  assert.notEqual(first, second);
  assert.match(first, /remote_request_duplicate/);
});
