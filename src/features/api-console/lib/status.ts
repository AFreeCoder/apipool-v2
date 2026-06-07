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

const FIVE_MINUTES_MS = 5 * 60 * 1000;
const TWO_HOURS_MS = 2 * 60 * 60 * 1000;

export function getNextKeyStatus(
  current: KeyLifecycleStatus,
  event: KeyLifecycleEvent
): KeyLifecycleStatus {
  if (event === 'remote_failed_terminal') return 'failed_terminal';
  if (event === 'remote_failed_retriable') return 'failed_retriable';

  if (
    current === 'creating_remote' &&
    event === 'remote_created_local_saved'
  ) {
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
    status === 'failed_retriable' ||
    status === 'remote_created_binding_failed'
  );
}

export function canDisableKeyStatus(status: KeyLifecycleStatus) {
  return status === 'active';
}

export function canDeleteKeyStatus(status: KeyLifecycleStatus) {
  return status === 'active' || status === 'disabled';
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
