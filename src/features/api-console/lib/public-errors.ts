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

/**
 * 用量同步失败时可安全展示给用户的文案。
 *
 * 内部错误（桥接错误、SQL 约束等）没有这样的文案，返回 undefined —— 页面会退回
 * 到 dashboard/common.json 里已本地化的 usageSync 词条。原先在这里返回一句英文
 * 兜底，会盖掉成套的中文文案，恰恰在用户最需要读懂提示的时刻。
 */
export function getPublicUsageSyncErrorMessage(
  error: unknown
): string | undefined {
  const message = getErrorMessage(error);
  if (!message || isInternalPortalError(error)) return undefined;
  return message;
}
