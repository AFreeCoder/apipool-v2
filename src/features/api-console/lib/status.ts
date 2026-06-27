export type KeyLifecycleStatus =
  | 'creating_remote'
  | 'active'
  | 'remote_created_binding_failed'
  | 'disable_pending'
  | 'delete_pending'
  | 'failed_retriable'
  | 'failed_terminal'
  | 'disabled'
  | 'deleted';

export type KeyLifecycleEvent =
  | 'remote_created_local_saved'
  | 'remote_created_local_failed'
  | 'remote_failed_retriable'
  | 'remote_failed_terminal'
  | 'remote_confirmed';

export type UsageSyncState = 'ready' | 'empty' | 'syncing' | 'stale' | 'failed';

export type UsageSyncSummary = {
  status: UsageSyncState;
  errorMessage?: string | null;
};

export type UsageLogIdentity = {
  id?: string | null;
  modelId?: string | null;
  createdAt?: Date | string | number | null;
};

const FIVE_MINUTES_MS = 5 * 60 * 1000;
const TWO_HOURS_MS = 2 * 60 * 60 * 1000;

export function getNextKeyStatus(
  current: KeyLifecycleStatus,
  event: KeyLifecycleEvent
): KeyLifecycleStatus {
  if (event === 'remote_failed_terminal') return 'failed_terminal';
  if (event === 'remote_failed_retriable') return 'failed_retriable';

  if (current === 'creating_remote' && event === 'remote_created_local_saved') {
    return 'active';
  }

  if (
    current === 'creating_remote' &&
    event === 'remote_created_local_failed'
  ) {
    return 'remote_created_binding_failed';
  }

  if (
    (current === 'disable_pending' || current === 'delete_pending') &&
    event === 'remote_confirmed'
  ) {
    return current === 'delete_pending' ? 'deleted' : 'disabled';
  }

  return current;
}

export function canRetryKeyStatus(status: KeyLifecycleStatus) {
  return (
    status === 'failed_retriable' || status === 'remote_created_binding_failed'
  );
}

export function canDisableKeyStatus(status: KeyLifecycleStatus) {
  return status === 'active';
}

export function canDeleteKeyStatus(status: KeyLifecycleStatus) {
  return status === 'active' || status === 'disabled';
}

/**
 * 失败/卡死态（远端未建成或本地未落库成功）允许「清理删除」：
 * 直接删本地死记录（远端若有残留则尽力删、失败不阻塞），
 * 让用户能清空被失败 Key 淹没的列表，而非永久卡住无法操作。
 */
export function canCleanupKeyStatus(status: KeyLifecycleStatus) {
  return (
    status === 'creating_remote' ||
    status === 'failed_retriable' ||
    status === 'failed_terminal' ||
    status === 'remote_created_binding_failed'
  );
}

export function getUsageSyncState(
  syncedAt: Date | null,
  now = new Date(),
  isSyncing = false
): UsageSyncState {
  if (isSyncing) return 'syncing';
  if (!syncedAt) return 'empty';

  const age = now.getTime() - syncedAt.getTime();
  if (age <= FIVE_MINUTES_MS) return 'ready';
  if (age <= TWO_HOURS_MS) return 'stale';
  return 'failed';
}

export function getUsageSyncDescription(summary: UsageSyncSummary) {
  if (summary.status === 'empty') {
    return 'No usage in the last 7 days yet.';
  }
  if (summary.status === 'syncing') {
    return 'Syncing usage. Showing the latest available data.';
  }
  if (summary.status === 'stale') {
    return (
      summary.errorMessage ||
      'Usage sync is delayed. Showing the latest available data.'
    );
  }
  if (summary.status === 'failed') {
    return (
      summary.errorMessage ||
      'Usage sync is temporarily unavailable. Try again later.'
    );
  }
  return 'Usage data is up to date.';
}

export function getUsageLogRowKey(log: UsageLogIdentity, index: number) {
  const createdAt =
    log.createdAt instanceof Date
      ? log.createdAt.toISOString()
      : String(log.createdAt ?? 'unknown-time');
  return `${log.id || 'usage-log'}:${createdAt}:${log.modelId || 'unknown-model'}:${index}`;
}
