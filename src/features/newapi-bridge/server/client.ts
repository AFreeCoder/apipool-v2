import 'server-only';

import { APIPOOL_CONFIG } from '@/config/apipool';

export type NewApiBridgeErrorCode =
  | 'not_configured'
  | 'unauthorized'
  | 'forbidden'
  | 'rate_limited'
  | 'timeout'
  | 'remote_error'
  | 'malformed_response';

export class NewApiBridgeError extends Error {
  code: NewApiBridgeErrorCode;
  status?: number;

  constructor({
    code,
    message,
    status,
  }: {
    code: NewApiBridgeErrorCode;
    message: string;
    status?: number;
  }) {
    super(message);
    this.name = 'NewApiBridgeError';
    this.code = code;
    this.status = status;
  }
}

export type NewApiClientOptions = {
  baseUrl?: string;
  adminToken?: string;
  enabled?: boolean;
  timeoutMs?: number;
  maxRetries?: number;
  retryDelayMs?: number;
  fetcher?: typeof fetch;
};

export type RemoteKey = {
  id: string;
  key?: string;
  maskedKey: string;
  status: 'active' | 'disabled' | 'revoked';
};

export type RemoteCreatedKey = RemoteKey & {
  key: string;
};

export type RemoteQuota = {
  balanceUsd?: number;
  quotaRemaining?: number;
};

export type RemoteHealth = {
  ok: true;
  status?: string;
  version?: string;
};

export type RemoteUsageSummary = {
  requestCount: number;
  inputTokens: number;
  outputTokens: number;
  spendUsd?: number;
  byModel: Array<{
    modelId: string;
    requests: number;
    tokens: number;
    spendUsd?: number;
  }>;
};

export type RemoteUsageLog = {
  id: string;
  keyMasked: string;
  modelId: string;
  status: 'success' | 'failed' | 'cancelled';
  inputTokens: number;
  outputTokens: number;
  spendUsd?: number;
  createdAt: string;
};

type RequestOptions = {
  method?: string;
  body?: unknown;
  idempotencyKey?: string;
};

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RETRIES = 1;
const DEFAULT_RETRY_DELAY_MS = 250;
const INITIAL_PORTAL_USER_QUOTA_USD = 0;

function mapStatus(status: number): NewApiBridgeErrorCode {
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 429) return 'rate_limited';
  return 'remote_error';
}

function normalizeBaseUrl(baseUrl: string) {
  return baseUrl.replace(/\/+$/, '');
}

function delay(ms: number) {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRemoteKey(payload: any): payload is RemoteKey {
  return (
    payload &&
    typeof payload.id === 'string' &&
    typeof payload.maskedKey === 'string' &&
    ['active', 'disabled', 'revoked'].includes(payload.status)
  );
}

function isRemoteCreatedKey(payload: any): payload is RemoteCreatedKey {
  return isRemoteKey(payload) && typeof payload.key === 'string';
}

function isRemoteQuota(payload: any): payload is RemoteQuota {
  return (
    payload &&
    (typeof payload.balanceUsd === 'number' ||
      typeof payload.quotaRemaining === 'number')
  );
}

function isRemoteHealth(payload: any): payload is RemoteHealth {
  return (
    payload &&
    payload.ok === true &&
    (payload.status === undefined || typeof payload.status === 'string') &&
    (payload.version === undefined || typeof payload.version === 'string')
  );
}

function isRemoteUsageSummary(payload: any): payload is RemoteUsageSummary {
  return (
    payload &&
    typeof payload.requestCount === 'number' &&
    typeof payload.inputTokens === 'number' &&
    typeof payload.outputTokens === 'number' &&
    (payload.spendUsd === undefined || typeof payload.spendUsd === 'number') &&
    Array.isArray(payload.byModel) &&
    payload.byModel.every(
      (model: any) =>
        model &&
        typeof model.modelId === 'string' &&
        typeof model.requests === 'number' &&
        typeof model.tokens === 'number' &&
        (model.spendUsd === undefined || typeof model.spendUsd === 'number')
    )
  );
}

function isRemoteUsageLog(payload: any): payload is RemoteUsageLog {
  return (
    payload &&
    typeof payload.id === 'string' &&
    typeof payload.keyMasked === 'string' &&
    typeof payload.modelId === 'string' &&
    ['success', 'failed', 'cancelled'].includes(payload.status) &&
    typeof payload.inputTokens === 'number' &&
    typeof payload.outputTokens === 'number' &&
    (payload.spendUsd === undefined || typeof payload.spendUsd === 'number') &&
    typeof payload.createdAt === 'string'
  );
}

export function createNewApiClient(options: NewApiClientOptions = {}) {
  const baseUrl = normalizeBaseUrl(
    options.baseUrl ?? APIPOOL_CONFIG.newApiBaseUrl
  );
  const adminToken = options.adminToken || process.env.NEWAPI_ADMIN_TOKEN || '';
  const enabled = options.enabled ?? APIPOOL_CONFIG.isNewApiIntegrationEnabled;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const fetcher = options.fetcher || fetch;

  function canRetryRequest(options: RequestOptions) {
    const method = (options.method || 'GET').toUpperCase();
    return method === 'GET' || Boolean(options.idempotencyKey);
  }

  function isTransientError(error: unknown) {
    return (
      error instanceof NewApiBridgeError &&
      ['rate_limited', 'timeout', 'remote_error'].includes(error.code)
    );
  }

  async function request<T>(
    path: string,
    validator: (payload: unknown) => payload is T,
    options: RequestOptions = {}
  ): Promise<T> {
    if (!enabled) {
      throw new NewApiBridgeError({
        code: 'not_configured',
        message: 'New API bridge is disabled',
      });
    }

    if (!baseUrl) {
      throw new NewApiBridgeError({
        code: 'not_configured',
        message: 'NEWAPI_BASE_URL is not configured',
      });
    }

    if (!adminToken) {
      throw new NewApiBridgeError({
        code: 'not_configured',
        message: 'NEWAPI_ADMIN_TOKEN is not configured',
      });
    }

    let lastError: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const headers = new Headers({
          authorization: `Bearer ${adminToken}`,
          accept: 'application/json',
        });
        if (options.body !== undefined) {
          headers.set('content-type', 'application/json');
        }
        if (options.idempotencyKey) {
          headers.set('idempotency-key', options.idempotencyKey);
        }

        const response = await fetcher(`${baseUrl}${path}`, {
          method: options.method || 'GET',
          headers,
          body:
            options.body === undefined
              ? undefined
              : JSON.stringify(options.body),
          signal: controller.signal,
        });

        if (!response.ok) {
          throw new NewApiBridgeError({
            code: mapStatus(response.status),
            status: response.status,
            message: `New API request failed with status ${response.status}`,
          });
        }

        const payload = await response.json();
        if (!validator(payload)) {
          throw new NewApiBridgeError({
            code: 'malformed_response',
            message: `Malformed New API response for ${path}`,
          });
        }

        return payload;
      } catch (error: any) {
        lastError =
          error instanceof NewApiBridgeError
            ? error
            : error?.name === 'AbortError'
              ? new NewApiBridgeError({
                  code: 'timeout',
                  message: `New API request timed out after ${timeoutMs}ms`,
                })
              : new NewApiBridgeError({
                  code: 'remote_error',
                  message: error?.message || 'New API request failed',
                });

        if (
          attempt < maxRetries &&
          canRetryRequest(options) &&
          isTransientError(lastError)
        ) {
          await delay(retryDelayMs);
          continue;
        }

        throw lastError;
      } finally {
        clearTimeout(timer);
      }
    }

    throw lastError;
  }

  return {
    healthCheck() {
      return request<RemoteHealth>('/api/admin/health', isRemoteHealth);
    },

    createUser(input: { portalUserId: string; email?: string }) {
      return request<{ id: string }>(
        '/api/admin/users',
        (payload: any): payload is { id: string } =>
          payload && typeof payload.id === 'string',
        {
          method: 'POST',
          body: {
            ...input,
            initialQuotaUsd: INITIAL_PORTAL_USER_QUOTA_USD,
          },
          idempotencyKey: `portal-user:${input.portalUserId}`,
        }
      );
    },

    createKey(input: {
      newapiUserId: string;
      name: string;
      allowedModels: string[];
      quotaLimit?: number;
      ipAllowlist?: string[];
      idempotencyKey: string;
    }) {
      return request<RemoteCreatedKey>('/api/admin/keys', isRemoteCreatedKey, {
        method: 'POST',
        body: {
          userId: input.newapiUserId,
          name: input.name,
          allowedModels: input.allowedModels,
          quotaLimit: input.quotaLimit,
          ipAllowlist: input.ipAllowlist || [],
        },
        idempotencyKey: input.idempotencyKey,
      });
    },

    listKeys(newapiUserId: string) {
      return request<RemoteKey[]>(
        `/api/admin/keys?user_id=${encodeURIComponent(newapiUserId)}`,
        (payload: any): payload is RemoteKey[] =>
          Array.isArray(payload) && payload.every(isRemoteKey)
      );
    },

    disableKey(newapiKeyId: string, idempotencyKey: string) {
      return request<RemoteKey>(
        `/api/admin/keys/${encodeURIComponent(newapiKeyId)}/disable`,
        isRemoteKey,
        { method: 'POST', idempotencyKey }
      );
    },

    deleteKey(newapiKeyId: string, idempotencyKey: string) {
      return request<{ id: string; deleted: true }>(
        `/api/admin/keys/${encodeURIComponent(newapiKeyId)}`,
        (payload: any): payload is { id: string; deleted: true } =>
          payload && typeof payload.id === 'string' && payload.deleted === true,
        { method: 'DELETE', idempotencyKey }
      );
    },

    getQuota(newapiUserId: string) {
      return request<RemoteQuota>(
        `/api/admin/users/${encodeURIComponent(newapiUserId)}/quota`,
        isRemoteQuota
      );
    },

    getUsageSummary(newapiUserId: string, range: '7d' | '30d' | 'month') {
      return request<RemoteUsageSummary>(
        `/api/admin/users/${encodeURIComponent(newapiUserId)}/usage?range=${range}`,
        isRemoteUsageSummary
      );
    },

    listUsageLogs(newapiUserId: string, limit = 20) {
      return request<RemoteUsageLog[]>(
        `/api/admin/users/${encodeURIComponent(newapiUserId)}/logs?limit=${limit}`,
        (payload: any): payload is RemoteUsageLog[] =>
          Array.isArray(payload) && payload.every(isRemoteUsageLog)
      );
    },

    adjustQuota(input: {
      newapiUserId: string;
      amountUsd: number;
      reason: string;
      idempotencyKey: string;
    }) {
      return request<{ changeId: string; balanceUsd?: number }>(
        `/api/admin/users/${encodeURIComponent(input.newapiUserId)}/quota/adjust`,
        (payload: any): payload is { changeId: string; balanceUsd?: number } =>
          payload && typeof payload.changeId === 'string',
        {
          method: 'POST',
          body: {
            amountUsd: input.amountUsd,
            reason: input.reason,
          },
          idempotencyKey: input.idempotencyKey,
        }
      );
    },
  };
}

export type NewApiClient = ReturnType<typeof createNewApiClient>;
