const USAGE_SYNC_ERROR =
  'Usage sync is temporarily unavailable. Showing the latest available portal data.';

const INTERNAL_ERROR_PATTERNS = [
  /\bnew\s*api\b/i,
  /\bnewapi\b/i,
  /\bNEWAPI_[A-Z0-9_]+\b/,
  /\/api\/admin\//i,
  /\badmin token\b/i,
  /\binternal service\b/i,
  /\bauthorization:\s*bearer\b/i,
  /\bfailed query\b/i,
  /\bsqlite(?:_|error| constraint)?\b/i,
  /\bconstraint\b/i,
  /\bduplicate key\b/i,
  /\bforeign key\b/i,
  /\bnewapi_key_binding\b/i,
  /\bapipool_ledger_entry\b/i,
  /\busage_snapshot\b/i,
  /\busage_log_snapshot\b/i,
];

function getErrorMessage(error: unknown) {
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message;
  if (
    error &&
    typeof error === 'object' &&
    'message' in error &&
    typeof (error as { message?: unknown }).message === 'string'
  ) {
    return (error as { message: string }).message;
  }

  return '';
}

function hasBridgeErrorShape(error: unknown) {
  if (!error || typeof error !== 'object') return false;

  return (
    'code' in error && typeof (error as { code?: unknown }).code === 'string'
  );
}

export function isInternalPortalError(error: unknown) {
  const message = getErrorMessage(error);
  if (hasBridgeErrorShape(error)) return true;
  return INTERNAL_ERROR_PATTERNS.some((pattern) => pattern.test(message));
}

export function getPublicPortalErrorMessage(
  error: unknown,
  fallbackMessage: string
) {
  const message = getErrorMessage(error);
  if (!message || isInternalPortalError(error)) return fallbackMessage;
  return message;
}

export function getPublicUsageSyncErrorMessage(error: unknown) {
  return getPublicPortalErrorMessage(error, USAGE_SYNC_ERROR);
}
