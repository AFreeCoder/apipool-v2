import 'server-only';

import { createHash } from 'node:crypto';

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
  adminUserId?: string;
  quotaPerUnit?: number;
  enabled?: boolean;
  timeoutMs?: number;
  maxRetries?: number;
  retryDelayMs?: number;
  fetcher?: typeof fetch;
};

// New API 的 token 归属用户：所有 Key/用量/兑换操作必须携带该用户自己的
// access token 与用户 ID（双 header），管理员令牌无法代替。
export type NewApiUserCredentials = {
  newapiUserId: string;
  accessToken: string;
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
  usedQuota?: number;
  usedUsd?: number;
  allTimeRequestCount?: number;
  group?: string;
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
  averageLatencyMs?: number;
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
  group?: string;
  channelName?: string;
  latencyMs?: number;
  requestId?: string;
  createdAt: string;
};

export type RemoteProvisionedUser = {
  newapiUserId: string;
  accessToken: string;
};

type AuthContext = { token: string; userId: string } | 'none';

type RequestOptions = {
  method?: string;
  body?: unknown;
  auth?: AuthContext;
  cookie?: string;
};

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RETRIES = 1;
const DEFAULT_RETRY_DELAY_MS = 250;
const DEFAULT_QUOTA_PER_UNIT = 500_000;
const LIST_PAGE_SIZE = 100;
const USAGE_LOG_TYPE_CONSUME = 2;

// New API token 状态：1=启用 2=禁用 3=过期 4=耗尽
const REMOTE_TOKEN_STATUS_ACTIVE = 1;
const REMOTE_TOKEN_STATUS_DISABLED = 2;

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

function maskKey(key: string) {
  if (key.length <= 8) return `${key.slice(0, 2)}****${key.slice(-2)}`;
  return `${key.slice(0, 4)}${'*'.repeat(10)}${key.slice(-4)}`;
}

function asNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function asOptionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function mapRemoteTokenStatus(status: unknown): RemoteKey['status'] {
  return status === REMOTE_TOKEN_STATUS_ACTIVE ? 'active' : 'disabled';
}

function toRemoteKey(item: any): RemoteKey {
  return {
    id: String(item.id),
    maskedKey: typeof item.key === 'string' ? item.key : '',
    status: mapRemoteTokenStatus(item.status),
  };
}

function isRemoteTokenItem(item: any): boolean {
  return (
    item &&
    (typeof item.id === 'number' || typeof item.id === 'string') &&
    typeof item.name === 'string'
  );
}

// New API 列表接口存在 {items,total} 与裸数组两种形态，统一展开
function unwrapListItems(data: any): any[] {
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.items)) return data.items;
  return [];
}

function extractSessionCookie(response: Response): string {
  const headersWithGetSetCookie = response.headers as Headers & {
    getSetCookie?: () => string[];
  };
  const cookies =
    headersWithGetSetCookie.getSetCookie?.() ??
    (response.headers.get('set-cookie')
      ? [response.headers.get('set-cookie') as string]
      : []);
  return cookies
    .map((cookie) => cookie.split(';')[0]?.trim())
    .filter(Boolean)
    .join('; ');
}

export function createNewApiClient(options: NewApiClientOptions = {}) {
  const baseUrl = normalizeBaseUrl(
    options.baseUrl ?? APIPOOL_CONFIG.newApiBaseUrl
  );
  const adminToken = options.adminToken || process.env.NEWAPI_ADMIN_TOKEN || '';
  const adminUserId =
    options.adminUserId || process.env.NEWAPI_ADMIN_USER_ID || '';
  const quotaPerUnit =
    options.quotaPerUnit ??
    Number(process.env.NEWAPI_QUOTA_PER_UNIT || DEFAULT_QUOTA_PER_UNIT);
  const enabled = options.enabled ?? APIPOOL_CONFIG.isNewApiIntegrationEnabled;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const fetcher = options.fetcher || fetch;

  const adminAuth = (): AuthContext => ({
    token: adminToken,
    userId: adminUserId,
  });
  const userAuth = (user: NewApiUserCredentials): AuthContext => ({
    token: user.accessToken,
    userId: user.newapiUserId,
  });

  function usdToQuota(usd: number) {
    return Math.floor(usd * quotaPerUnit);
  }

  function quotaToUsd(quota: number) {
    return quota / quotaPerUnit;
  }

  function canRetryRequest(options: RequestOptions) {
    // New API 不支持幂等键，写操作一律不自动重试，由 portal 侧查重后决定
    return (options.method || 'GET').toUpperCase() === 'GET';
  }

  function isTransientError(error: unknown) {
    return (
      error instanceof NewApiBridgeError &&
      ['rate_limited', 'timeout', 'remote_error'].includes(error.code)
    );
  }

  async function rawRequest(
    path: string,
    options: RequestOptions = {}
  ): Promise<Response> {
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

    const auth = options.auth ?? adminAuth();
    if (auth !== 'none') {
      if (!auth.token && !options.cookie) {
        throw new NewApiBridgeError({
          code: 'not_configured',
          message: 'New API access token is not configured',
        });
      }
      if (!auth.userId) {
        throw new NewApiBridgeError({
          code: 'not_configured',
          message: 'New API user id is not configured',
        });
      }
    }

    let lastError: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const headers = new Headers({ accept: 'application/json' });
        if (auth !== 'none') {
          if (options.cookie) {
            // 供给链路用 cookie 会话（access token 尚不存在）
            headers.set('cookie', options.cookie);
          } else {
            headers.set('authorization', `Bearer ${auth.token}`);
          }
          headers.set('new-api-user', auth.userId);
        }
        if (options.body !== undefined) {
          headers.set('content-type', 'application/json');
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

        return response;
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

  // 解析 {success, message, data} 包络；success=false 一律视为远端错误
  async function request<T = unknown>(
    path: string,
    options: RequestOptions = {}
  ): Promise<T> {
    const response = await rawRequest(path, options);

    let payload: any;
    try {
      payload = await response.json();
    } catch {
      throw new NewApiBridgeError({
        code: 'malformed_response',
        message: `Non-JSON New API response for ${path}`,
      });
    }

    if (!payload || typeof payload.success !== 'boolean') {
      throw new NewApiBridgeError({
        code: 'malformed_response',
        message: `Malformed New API envelope for ${path}`,
      });
    }

    if (!payload.success) {
      throw new NewApiBridgeError({
        code: 'remote_error',
        message: payload.message || `New API rejected request for ${path}`,
      });
    }

    return payload.data as T;
  }

  async function findUserByUsername(username: string) {
    const data = await request<any>(
      `/api/user/search?keyword=${encodeURIComponent(username)}`
    );
    const match = unwrapListItems(data).find(
      (item: any) => item?.username === username
    );
    return match
      ? { id: String(match.id), quota: asNumber(match.quota) }
      : undefined;
  }

  async function findTokenByName(user: NewApiUserCredentials, name: string) {
    const data = await request<any>(
      `/api/token/?p=1&size=${LIST_PAGE_SIZE}`,
      { auth: userAuth(user) }
    );
    return unwrapListItems(data).find((item: any) => item?.name === name);
  }

  async function fetchFullKey(user: NewApiUserCredentials, tokenId: string) {
    const data = await request<any>(
      `/api/token/${encodeURIComponent(tokenId)}/key`,
      { method: 'POST', auth: userAuth(user) }
    );
    const key = typeof data === 'string' ? data : data?.key;
    if (typeof key !== 'string' || key.length === 0) {
      throw new NewApiBridgeError({
        code: 'malformed_response',
        message: 'New API did not return the full token key',
      });
    }
    return key.startsWith('sk-') ? key : `sk-${key}`;
  }

  function rangeToTimestamps(range: '7d' | '30d' | 'month') {
    const now = new Date();
    const end = Math.floor(now.getTime() / 1000);
    if (range === 'month') {
      const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
      return { start: Math.floor(monthStart.getTime() / 1000), end };
    }
    const days = range === '7d' ? 7 : 30;
    return { start: end - days * 24 * 60 * 60, end };
  }

  function toRemoteUsageLog(item: any): RemoteUsageLog {
    return {
      id: String(item.id),
      keyMasked: typeof item.token_name === 'string' ? item.token_name : '',
      modelId: typeof item.model_name === 'string' ? item.model_name : '',
      status: 'success',
      inputTokens: asNumber(item.prompt_tokens),
      outputTokens: asNumber(item.completion_tokens),
      spendUsd: quotaToUsd(asNumber(item.quota)),
      group: asOptionalString(item.group),
      channelName: asOptionalString(item.channel_name),
      latencyMs: asOptionalNumber(item.use_time),
      requestId: asOptionalString(item.request_id),
      createdAt: new Date(asNumber(item.created_at) * 1000).toISOString(),
    };
  }

  async function listUsageLogsInRange(
    user: NewApiUserCredentials,
    limit: number,
    range?: { start: number; end: number }
  ) {
    const rangeQuery = range
      ? `&start_timestamp=${range.start}&end_timestamp=${range.end}`
      : '';
    const data = await request<any>(
      `/api/log/self?p=1&page_size=${limit}&type=${USAGE_LOG_TYPE_CONSUME}${rangeQuery}`,
      { auth: userAuth(user) }
    );
    return unwrapListItems(data).map(toRemoteUsageLog);
  }

  async function getQuotaForUser(
    user: NewApiUserCredentials
  ): Promise<RemoteQuota> {
    const data = await request<any>('/api/user/self', {
      auth: userAuth(user),
    });
    if (typeof data?.quota !== 'number') {
      throw new NewApiBridgeError({
        code: 'malformed_response',
        message: 'New API user self response missing quota',
      });
    }
    return {
      quotaRemaining: data.quota,
      balanceUsd: quotaToUsd(data.quota),
      usedQuota: asOptionalNumber(data.used_quota),
      usedUsd:
        typeof data.used_quota === 'number'
          ? quotaToUsd(data.used_quota)
          : undefined,
      allTimeRequestCount: asOptionalNumber(data.request_count),
      group: asOptionalString(data.group),
    };
  }

  return {
    usdToQuota,
    quotaToUsd,

    async healthCheck(): Promise<RemoteHealth> {
      const data = await request<any>('/api/status', { auth: 'none' });
      return {
        ok: true,
        version: typeof data?.version === 'string' ? data.version : undefined,
      };
    },

    /**
     * 用户供给链路（docs/04 第 3 节，已实测）：
     * 建用户 → search 反查 ID（创建接口不返回 ID）→ 登录拿 cookie
     * → 生成 access token（重新生成语义，调用方必须立即持久化）。
     */
    async provisionUser(input: {
      username: string;
      password: string;
      displayName?: string;
    }): Promise<RemoteProvisionedUser> {
      const existing = await findUserByUsername(input.username);
      if (!existing) {
        await request('/api/user/', {
          method: 'POST',
          body: {
            username: input.username,
            password: input.password,
            display_name: input.displayName || input.username,
          },
        });
      }

      const found = existing ?? (await findUserByUsername(input.username));
      if (!found) {
        throw new NewApiBridgeError({
          code: 'remote_error',
          message: `New API user not found after creation: ${input.username}`,
        });
      }

      const loginResponse = await rawRequest('/api/user/login', {
        method: 'POST',
        body: { username: input.username, password: input.password },
        auth: 'none',
      });
      const loginPayload = await loginResponse.json().catch(() => undefined);
      if (!loginPayload?.success) {
        throw new NewApiBridgeError({
          code: 'unauthorized',
          message: loginPayload?.message || 'New API user login failed',
        });
      }
      const cookie = extractSessionCookie(loginResponse);
      if (!cookie) {
        throw new NewApiBridgeError({
          code: 'malformed_response',
          message: 'New API login did not return a session cookie',
        });
      }

      const accessToken = await request<string>('/api/user/token', {
        auth: { token: '', userId: found.id },
        cookie,
      });
      if (typeof accessToken !== 'string' || accessToken.length === 0) {
        throw new NewApiBridgeError({
          code: 'malformed_response',
          message: 'New API did not return an access token',
        });
      }

      return { newapiUserId: found.id, accessToken };
    },

    /**
     * 建 Key：remoteName 必须全局唯一（portal 用本地 keyId），借此实现
     * 门户侧幂等——先查同名 token，存在即复用，避免远端重复创建。
     */
    async createKey(input: {
      user: NewApiUserCredentials;
      remoteName: string;
      allowedModels?: string[];
      quotaLimitUsd?: number;
      ipAllowlist?: string[];
      group?: string;
      crossGroupRetry?: boolean;
    }): Promise<RemoteCreatedKey> {
      let item = await findTokenByName(input.user, input.remoteName);

      if (!item) {
        await request('/api/token/', {
          method: 'POST',
          auth: userAuth(input.user),
          body: {
            name: input.remoteName,
            expired_time: -1,
            unlimited_quota: input.quotaLimitUsd === undefined,
            remain_quota:
              input.quotaLimitUsd === undefined
                ? 0
                : usdToQuota(input.quotaLimitUsd),
            model_limits_enabled: Boolean(input.allowedModels?.length),
            model_limits: (input.allowedModels || []).join(','),
            allow_ips: (input.ipAllowlist || []).join(','),
            group: input.group || APIPOOL_CONFIG.newApiDefaultTokenGroup,
            cross_group_retry:
              input.crossGroupRetry ?? APIPOOL_CONFIG.newApiTokenCrossGroupRetry,
          },
        });
        item = await findTokenByName(input.user, input.remoteName);
      }

      if (!isRemoteTokenItem(item)) {
        throw new NewApiBridgeError({
          code: 'malformed_response',
          message: `New API token not found after creation: ${input.remoteName}`,
        });
      }

      const fullKey = await fetchFullKey(input.user, String(item.id));
      return {
        id: String(item.id),
        key: fullKey,
        maskedKey: maskKey(fullKey),
        status: mapRemoteTokenStatus(item.status),
      };
    },

    async listKeys(user: NewApiUserCredentials): Promise<RemoteKey[]> {
      const data = await request<any>(
        `/api/token/?p=1&size=${LIST_PAGE_SIZE}`,
        { auth: userAuth(user) }
      );
      const items = unwrapListItems(data);
      if (!items.every(isRemoteTokenItem)) {
        throw new NewApiBridgeError({
          code: 'malformed_response',
          message: 'Malformed New API token list',
        });
      }
      return items.map(toRemoteKey);
    },

    async disableKey(
      user: NewApiUserCredentials,
      newapiKeyId: string
    ): Promise<RemoteKey> {
      const data = await request<any>('/api/token/?status_only=true', {
        method: 'PUT',
        auth: userAuth(user),
        body: { id: Number(newapiKeyId), status: REMOTE_TOKEN_STATUS_DISABLED },
      });
      if (!isRemoteTokenItem(data)) {
        throw new NewApiBridgeError({
          code: 'malformed_response',
          message: 'Malformed New API disable response',
        });
      }
      return toRemoteKey(data);
    },

    async deleteKey(
      user: NewApiUserCredentials,
      newapiKeyId: string
    ): Promise<{ id: string; deleted: true }> {
      await request(`/api/token/${encodeURIComponent(newapiKeyId)}`, {
        method: 'DELETE',
        auth: userAuth(user),
      });
      return { id: newapiKeyId, deleted: true };
    },

    getQuota: getQuotaForUser,

    /**
     * 汇总来自 /api/data/self（请求数、消费、模型分布）；输入/输出 token
     * 拆分来自同时间窗的消费日志首页（上限 LIST_PAGE_SIZE 条，近似值）。
     */
    async getUsageSummary(
      user: NewApiUserCredentials,
      range: '7d' | '30d' | 'month'
    ): Promise<RemoteUsageSummary> {
      const window = rangeToTimestamps(range);
      const data = await request<any>(
        `/api/data/self?start_timestamp=${window.start}&end_timestamp=${window.end}&default_time=day`,
        { auth: userAuth(user) }
      );

      const byModelMap = new Map<
        string,
        { requests: number; tokens: number; spendQuota: number }
      >();
      for (const row of unwrapListItems(data)) {
        const modelId =
          typeof row?.model_name === 'string' ? row.model_name : 'unknown';
        const entry = byModelMap.get(modelId) || {
          requests: 0,
          tokens: 0,
          spendQuota: 0,
        };
        entry.requests += asNumber(row?.count);
        entry.tokens += asNumber(row?.token_used);
        entry.spendQuota += asNumber(row?.quota);
        byModelMap.set(modelId, entry);
      }

      const logs = await listUsageLogsInRange(user, LIST_PAGE_SIZE, window);
      const inputTokens = logs.reduce((sum, log) => sum + log.inputTokens, 0);
      const outputTokens = logs.reduce(
        (sum, log) => sum + log.outputTokens,
        0
      );
      const latencySamples = logs
        .map((log) => log.latencyMs)
        .filter(
          (latencyMs): latencyMs is number => typeof latencyMs === 'number'
        );

      // /api/data/self 由 New API 周期性聚合，刚发生的调用尚未入仓；
      // 聚合为空而日志非空时，用同窗口的消费日志推导汇总，保证近实时
      if (byModelMap.size === 0 && logs.length > 0) {
        for (const log of logs) {
          const entry = byModelMap.get(log.modelId) || {
            requests: 0,
            tokens: 0,
            spendQuota: 0,
          };
          entry.requests += 1;
          entry.tokens += log.inputTokens + log.outputTokens;
          entry.spendQuota += usdToQuota(log.spendUsd ?? 0);
          byModelMap.set(log.modelId, entry);
        }
      }

      let requestCount = 0;
      let spendQuota = 0;
      const byModel = [...byModelMap.entries()].map(([modelId, entry]) => {
        requestCount += entry.requests;
        spendQuota += entry.spendQuota;
        return {
          modelId,
          requests: entry.requests,
          tokens: entry.tokens,
          spendUsd: quotaToUsd(entry.spendQuota),
        };
      });

      return {
        requestCount,
        inputTokens,
        outputTokens,
        spendUsd: quotaToUsd(spendQuota),
        averageLatencyMs:
          latencySamples.length > 0
            ? Math.round(
                latencySamples.reduce((sum, value) => sum + value, 0) /
                  latencySamples.length
              )
            : undefined,
        byModel,
      };
    },

    async listUsageLogs(
      user: NewApiUserCredentials,
      limit = 20
    ): Promise<RemoteUsageLog[]> {
      return listUsageLogsInRange(user, limit);
    },

    /**
     * 调额走兑换码（docs/06 首选方案）：管理员按 reference 生成一次性
     * 兑换码 → 以用户身份兑换。一码一兑，远端天然幂等。
     */
    async adjustQuota(input: {
      user: NewApiUserCredentials;
      amountUsd: number;
      reason: string;
      reference: string;
    }): Promise<{ changeId: string; balanceUsd?: number }> {
      if (input.amountUsd <= 0) {
        throw new NewApiBridgeError({
          code: 'remote_error',
          message: 'Quota adjustment amount must be positive',
        });
      }

      // 兑换码名称限长 20 字符，存 reference 的短哈希；
      // 对账以兑换码值（changeId）与 ledger/审计中的 reference 关联
      const redemptionName = `r${createHash('sha256')
        .update(input.reference)
        .digest('hex')
        .slice(0, 18)}`;
      const codes = await request<any>('/api/redemption/', {
        method: 'POST',
        body: {
          name: redemptionName,
          quota: usdToQuota(input.amountUsd),
          count: 1,
        },
      });
      const code = Array.isArray(codes) ? codes[0] : undefined;
      if (typeof code !== 'string' || code.length === 0) {
        throw new NewApiBridgeError({
          code: 'malformed_response',
          message: 'New API did not return a redemption code',
        });
      }

      await request('/api/user/topup', {
        method: 'POST',
        auth: userAuth(input.user),
        body: { key: code },
      });

      const quota = await getQuotaForUser(input.user);
      return { changeId: code, balanceUsd: quota.balanceUsd };
    },
  };
}

export type NewApiClient = ReturnType<typeof createNewApiClient>;
