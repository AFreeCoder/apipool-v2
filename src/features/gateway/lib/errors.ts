import type { GatewayProtocol } from './endpoints';

export type GatewayErrorCode =
  | 'invalid_api_key'
  | 'account_disabled'
  | 'account_frozen'
  | 'insufficient_quota'
  | 'concurrency_limit_exceeded'
  | 'model_not_found'
  | 'task_not_found'
  | 'unknown_endpoint'
  | 'request_too_large'
  | 'request_timeout'
  | 'invalid_request'
  | 'upstream_unavailable'
  | 'upstream_error'
  | 'internal_error';

const DEFAULT_MESSAGES: Record<GatewayErrorCode, string> = {
  invalid_api_key: 'Invalid API key provided.',
  account_disabled: 'This account has been disabled.',
  account_frozen: 'This account is frozen. Contact support.',
  insufficient_quota: 'Insufficient balance. Top up to continue.',
  concurrency_limit_exceeded: 'Too many in-flight requests. Retry shortly.',
  model_not_found:
    'The requested model does not exist or is not available for this key.',
  task_not_found: 'The requested task does not exist.',
  unknown_endpoint: 'Unknown endpoint.',
  request_too_large: 'Request body exceeds the size limit.',
  request_timeout: 'Request body timed out.',
  invalid_request: 'Malformed or ambiguous request body.',
  upstream_unavailable: 'Service temporarily unavailable. Retry shortly.',
  upstream_error: 'Upstream service error.',
  internal_error: 'Internal error.',
};

const OPENAI_TYPE: Partial<Record<GatewayErrorCode, string>> = {
  invalid_api_key: 'invalid_request_error',
  insufficient_quota: 'insufficient_quota',
  concurrency_limit_exceeded: 'rate_limit_error',
  model_not_found: 'invalid_request_error',
  task_not_found: 'invalid_request_error',
  unknown_endpoint: 'invalid_request_error',
  request_too_large: 'invalid_request_error',
  request_timeout: 'invalid_request_error',
  invalid_request: 'invalid_request_error',
};

export function gatewayErrorResponse(
  protocol: GatewayProtocol,
  code: GatewayErrorCode,
  opts: {
    status: number;
    portalRequestId: string;
    message?: string;
    retryAfterSeconds?: number;
  }
): Response {
  const message = opts.message ?? DEFAULT_MESSAGES[code];
  const body =
    protocol === 'anthropic'
      ? {
          type: 'error',
          error: { type: code, message },
          request_id: opts.portalRequestId,
        }
      : {
          error: {
            message,
            type: OPENAI_TYPE[code] ?? 'api_error',
            code,
            request_id: opts.portalRequestId,
          },
        };
  const headers = new Headers({
    'content-type': 'application/json',
    'cache-control': 'no-store',
    'x-apipool-request-id': opts.portalRequestId,
  });
  if (opts.retryAfterSeconds) {
    headers.set('retry-after', String(opts.retryAfterSeconds));
  }
  return new Response(JSON.stringify(body), { status: opts.status, headers });
}
