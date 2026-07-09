import 'server-only';

import { createHash } from 'node:crypto';
import {
  derivePricingFromNewApiPricing,
  normalizeGroupRatio,
} from '@/features/api-catalog/lib/pricing';

import { APIPOOL_CONFIG } from '@/config/apipool';

export type NewApiBridgeErrorCode =
  | 'not_configured'
  | 'unauthorized'
  | 'forbidden'
  | 'rate_limited'
  | 'timeout'
  | 'remote_error'
  | 'malformed_response'
  | 'conflict_requires_review'
  | 'portal_user_email_missing'
  | 'newapi_username_too_long';

export class NewApiBridgeError extends Error {
  code: NewApiBridgeErrorCode;
  status?: number;
  conflictNewapiUserId?: string;

  constructor({
    code,
    message,
    status,
    conflictNewapiUserId,
  }: {
    code: NewApiBridgeErrorCode;
    message: string;
    status?: number;
    conflictNewapiUserId?: string;
  }) {
    super(message);
    this.name = 'NewApiBridgeError';
    this.code = code;
    this.status = status;
    this.conflictNewapiUserId = conflictNewapiUserId;
  }
}

export class NewApiQuotaAdjustmentReconciliationError extends NewApiBridgeError {
  changeId: string;
  reconciliationRequired = true;

  constructor({ changeId, message }: { changeId: string; message: string }) {
    super({ code: 'remote_error', message });
    this.name = 'NewApiQuotaAdjustmentReconciliationError';
    this.changeId = changeId;
  }
}

export function isQuotaAdjustmentReconciliationError(
  error: unknown
): error is NewApiQuotaAdjustmentReconciliationError {
  return (
    error instanceof NewApiQuotaAdjustmentReconciliationError ||
    Boolean(
      error &&
        typeof error === 'object' &&
        (error as any).reconciliationRequired === true &&
        typeof (error as any).changeId === 'string'
    )
  );
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

const quotaAdjustmentLocks = new Map<string, Promise<void>>();

async function withQuotaAdjustmentLock<T>(
  newapiUserId: string,
  task: () => Promise<T>
) {
  const previous = quotaAdjustmentLocks.get(newapiUserId) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((resolve) => {
    release = resolve;
  });
  const tail = previous.catch(() => undefined).then(() => next);
  quotaAdjustmentLocks.set(newapiUserId, tail);

  await previous.catch(() => undefined);
  try {
    return await task();
  } finally {
    release();
    if (quotaAdjustmentLocks.get(newapiUserId) === tail) {
      quotaAdjustmentLocks.delete(newapiUserId);
    }
  }
}

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
  cacheTokens?: number;
  cacheRatio?: number;
  cacheCreationTokens?: number;
  cacheCreationRatio?: number;
  cacheCreationTokens5m?: number;
  cacheCreationRatio5m?: number;
  cacheCreationTokens1h?: number;
  cacheCreationRatio1h?: number;
  usageSemantic?: string;
  spendUsd?: number;
  createdAt: string;
};

export type RemoteProvisionedUser = {
  newapiUserId: string;
  accessToken: string;
};

export type RemoteUserProfile = {
  newapiUserId: string;
  username: string;
  displayName: string;
  group: string;
  role: number;
  remark: string;
};

export type NewApiUserProfileUpdateInput = {
  newapiUserId: string;
  currentUsername?: string;
  username: string;
  displayName?: string;
  group?: string;
  remark?: string;
};

type RemoteUserLookup = Omit<RemoteUserProfile, 'role'> & {
  role?: number;
};

export type RemotePricingModel = {
  modelId: string;
  displayName: string;
  vendorId: string;
  vendorName: string;
  quotaType: number;
  modelRatio: number;
  modelPrice: number | null;
  completionRatio: number;
  imageRatio: number | null;
  source: 'ratio' | 'fixed-price';
  inputMicroUsd: number | null;
  outputMicroUsd: number | null;
  imageInputMicroUsd: number | null;
  imageOutputMicroUsd: number | null;
  enabledGroups: string[];
  supportedEndpointTypes: string[];
};

export type RemotePricingGroupRatio = {
  raw: unknown;
  decimal: string;
  bps: number;
  sourceKey: 'group_ratio' | 'groupRatio' | 'group_ratios';
};

export type RemotePricingSnapshot = {
  models: RemotePricingModel[];
  vendors: Record<string, string>;
  groupRatios: Record<string, RemotePricingGroupRatio>;
  usableGroups: string[];
  sourceFingerprint: string;
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
export const DEFAULT_QUOTA_PER_UNIT = 500_000;
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

function maskRemoteTokenListKey(key: unknown) {
  if (typeof key !== 'string' || key.length === 0) return '';
  if (key.includes('*')) return key;
  if (key.startsWith('sk-') || key.length > 8) return maskKey(key);
  return key;
}

function asNumber(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function asNullableNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((item) => String(item || '').trim())
      .filter((item) => item.length > 0);
  }

  if (typeof value === 'string') {
    return value
      .split(',')
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
  }

  return [];
}

function lookupVendorName(vendors: unknown, vendorId: string) {
  if (!vendorId) return '';

  if (Array.isArray(vendors)) {
    const match = vendors.find(
      (vendor: any) =>
        String(vendor?.id || vendor?.vendor_id || vendor?.value || '') ===
        vendorId
    );
    if (match) {
      return String(match.name || match.label || match.title || vendorId);
    }
  }

  if (vendors && typeof vendors === 'object') {
    const value = (vendors as Record<string, unknown>)[vendorId];
    if (typeof value === 'string') return value;
    if (value && typeof value === 'object') {
      const objectValue = value as Record<string, unknown>;
      return String(
        objectValue.name ||
          objectValue.label ||
          objectValue.title ||
          objectValue.vendor_name ||
          vendorId
      );
    }
  }

  return vendorId;
}

function normalizeVendors(vendors: unknown): Record<string, string> {
  if (Array.isArray(vendors)) {
    return Object.fromEntries(
      vendors
        .map((vendor: any) => {
          const id = String(vendor?.id || vendor?.vendor_id || vendor?.value || '');
          if (!id) return null;
          return [id, String(vendor?.name || vendor?.label || vendor?.title || id)];
        })
        .filter(Boolean) as [string, string][]
    );
  }

  if (vendors && typeof vendors === 'object') {
    return Object.fromEntries(
      Object.entries(vendors as Record<string, unknown>).map(([id, value]) => {
        if (typeof value === 'string') return [id, value];
        if (value && typeof value === 'object') {
          const objectValue = value as Record<string, unknown>;
          return [
            id,
            String(
              objectValue.name ||
                objectValue.label ||
                objectValue.title ||
                objectValue.vendor_name ||
                id
            ),
          ];
        }
        return [id, id];
      })
    );
  }

  return {};
}

function getEnvelopeValue(payload: any, key: string) {
  return payload?.[key] ?? payload?.data?.[key];
}

function extractPricingItems(payload: any): any[] {
  const data = payload?.data;
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.items)) return data.items;
  if (data && Array.isArray(data.data)) return data.data;
  return [];
}

function extractUsableGroups(payload: any): string[] {
  return asStringArray(
    getEnvelopeValue(payload, 'usable_group') ??
      getEnvelopeValue(payload, 'usable_groups') ??
      getEnvelopeValue(payload, 'groups')
  );
}

function groupRatioEntries(value: unknown): [string, unknown][] {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value
      .map((item: any) => {
        const group = String(
          item?.group || item?.name || item?.slug || item?.key || ''
        );
        const ratio = item?.ratio ?? item?.value ?? item?.group_ratio;
        return group ? ([group, ratio] as [string, unknown]) : null;
      })
      .filter(Boolean) as [string, unknown][];
  }
  if (typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>);
  }
  return [];
}

function extractGroupRatios(payload: any): Record<string, RemotePricingGroupRatio> {
  const result: Record<string, RemotePricingGroupRatio> = {};
  for (const sourceKey of ['group_ratio', 'groupRatio', 'group_ratios'] as const) {
    for (const [group, raw] of groupRatioEntries(getEnvelopeValue(payload, sourceKey))) {
      try {
        const normalized = normalizeGroupRatio(raw as number | string, sourceKey);
        result[group] = {
          raw,
          decimal: normalized.decimal,
          bps: normalized.bps,
          sourceKey,
        };
      } catch {
        // Invalid remote ratios are intentionally ignored here; sync code records
        // missing/invalid group state without overwriting existing local values.
      }
    }
  }
  return result;
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, child]) => `${JSON.stringify(key)}:${stableStringify(child)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function fingerprintPricingSnapshot(input: {
  models: RemotePricingModel[];
  vendors: Record<string, string>;
  groupRatios: Record<string, RemotePricingGroupRatio>;
  usableGroups: string[];
}) {
  return createHash('sha256')
    .update(
      stableStringify({
        models: input.models
          .map((model) => ({
            modelId: model.modelId,
            vendorId: model.vendorId,
            quotaType: model.quotaType,
            modelRatio: model.modelRatio,
            modelPrice: model.modelPrice,
            completionRatio: model.completionRatio,
            imageRatio: model.imageRatio,
            enabledGroups: [...model.enabledGroups].sort(),
            supportedEndpointTypes: [...model.supportedEndpointTypes].sort(),
          }))
          .sort((a, b) => a.modelId.localeCompare(b.modelId)),
        vendors: input.vendors,
        groupRatios: input.groupRatios,
        usableGroups: [...input.usableGroups].sort(),
      })
    )
    .digest('hex');
}

function toRemotePricingModel(item: any, vendors: unknown): RemotePricingModel {
  const modelId = String(item?.model_name || item?.model || item?.id || '');
  const vendorId = String(item?.vendor_id || item?.vendor || '');
  const quotaType = asNumber(item?.quota_type);
  const modelRatio = asNumber(item?.model_ratio);
  const modelPrice = asNullableNumber(item?.model_price);
  const completionRatio = asNumber(item?.completion_ratio);
  const imageRatio = asNullableNumber(item?.image_ratio);
  const supportedEndpointTypes = asStringArray(item?.supported_endpoint_types);
  const derived = derivePricingFromNewApiPricing({
    model_name: modelId,
    quota_type: quotaType,
    model_ratio: modelRatio,
    model_price: modelPrice,
    completion_ratio: completionRatio,
    image_ratio: imageRatio,
    supported_endpoint_types: supportedEndpointTypes,
  });

  return {
    modelId,
    displayName: String(item?.display_name || item?.name || modelId),
    vendorId,
    vendorName: lookupVendorName(vendors, vendorId),
    quotaType,
    modelRatio,
    modelPrice,
    completionRatio,
    imageRatio,
    source: derived.source,
    inputMicroUsd: derived.inputMicroUsd,
    outputMicroUsd: derived.outputMicroUsd,
    imageInputMicroUsd: derived.imageInputMicroUsd,
    imageOutputMicroUsd: derived.imageOutputMicroUsd,
    enabledGroups: asStringArray(item?.enable_groups),
    supportedEndpointTypes,
  };
}

function mapRemoteTokenStatus(status: unknown): RemoteKey['status'] {
  return status === REMOTE_TOKEN_STATUS_ACTIVE ? 'active' : 'disabled';
}

function toRemoteKey(item: any): RemoteKey {
  return {
    id: String(item.id),
    maskedKey: maskRemoteTokenListKey(item.key),
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

function toRemoteUserLookup(
  item: any,
  fallbackUsername: string
): RemoteUserLookup | undefined {
  if (!item?.id) return undefined;
  const username = String(item.username || fallbackUsername);
  return {
    newapiUserId: String(item.id),
    username,
    displayName:
      typeof item.display_name === 'string' ? item.display_name : username,
    group: typeof item.group === 'string' ? item.group : '',
    role: typeof item.role === 'number' ? item.role : undefined,
    remark: typeof item.remark === 'string' ? item.remark : '',
  };
}

function requireRemoteUserProfile(
  user: RemoteUserLookup | undefined,
  username: string
): RemoteUserProfile | undefined {
  if (!user) return undefined;
  if (typeof user.role !== 'number') {
    throw new NewApiBridgeError({
      code: 'malformed_response',
      message: `New API user profile missing numeric role: ${username}`,
    });
  }
  return {
    ...user,
    role: user.role,
  };
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

  function toRemoteUserId(value: string) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : value;
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
    const payload = await requestEnvelope(path, options);
    return payload.data as T;
  }

  async function requestEnvelope(
    path: string,
    options: RequestOptions = {}
  ): Promise<any> {
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

    return payload;
  }

  async function findUserByUsername(username: string) {
    const data = await request<any>(
      `/api/user/search?keyword=${encodeURIComponent(username)}`
    );
    const match = unwrapListItems(data).find(
      (item: any) => item?.username === username
    );
    return toRemoteUserLookup(match, username);
  }

  async function ensureRemoteUserGroup(
    user: RemoteUserProfile,
    group?: string
  ) {
    const targetGroup = group?.trim();
    if (!user || !targetGroup || user.group === targetGroup) return;

    await request('/api/user/', {
      method: 'PUT',
      body: {
        id: toRemoteUserId(user.newapiUserId),
        username: user.username,
        display_name: user.displayName || user.username,
        group: targetGroup,
        role: user.role,
        remark: user.remark || '',
      },
    });
  }

  async function findTokenByName(user: NewApiUserCredentials, name: string) {
    const data = await request<any>(`/api/token/?p=1&size=${LIST_PAGE_SIZE}`, {
      auth: userAuth(user),
    });
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

  function parseUsageLogCacheMetadata(item: any) {
    let other = item?.other;
    if (typeof other === 'string' && other.trim().length > 0) {
      try {
        other = JSON.parse(other);
      } catch {
        other = undefined;
      }
    }

    const cacheTokens = asNullableNumber(
      other?.cache_tokens ?? other?.cacheTokens
    );
    const cacheRatio = asNullableNumber(other?.cache_ratio ?? other?.cacheRatio);
    const cacheCreationTokens = asNullableNumber(
      other?.cache_creation_tokens ?? other?.cacheCreationTokens
    );
    const cacheCreationRatio = asNullableNumber(
      other?.cache_creation_ratio ?? other?.cacheCreationRatio
    );
    const cacheCreationTokens5m = asNullableNumber(
      other?.cache_creation_tokens_5m ?? other?.cacheCreationTokens5m
    );
    const cacheCreationRatio5m = asNullableNumber(
      other?.cache_creation_ratio_5m ?? other?.cacheCreationRatio5m
    );
    const cacheCreationTokens1h = asNullableNumber(
      other?.cache_creation_tokens_1h ?? other?.cacheCreationTokens1h
    );
    const cacheCreationRatio1h = asNullableNumber(
      other?.cache_creation_ratio_1h ?? other?.cacheCreationRatio1h
    );
    const usageSemantic =
      typeof (other?.usage_semantic ?? other?.usageSemantic) === 'string'
        ? String(other?.usage_semantic ?? other?.usageSemantic).trim()
        : '';

    return {
      cacheTokens:
        cacheTokens !== null && cacheTokens >= 0 ? cacheTokens : undefined,
      cacheRatio: cacheRatio !== null && cacheRatio >= 0 ? cacheRatio : undefined,
      cacheCreationTokens:
        cacheCreationTokens !== null && cacheCreationTokens >= 0
          ? cacheCreationTokens
          : undefined,
      cacheCreationRatio:
        cacheCreationRatio !== null && cacheCreationRatio >= 0
          ? cacheCreationRatio
          : undefined,
      cacheCreationTokens5m:
        cacheCreationTokens5m !== null && cacheCreationTokens5m >= 0
          ? cacheCreationTokens5m
          : undefined,
      cacheCreationRatio5m:
        cacheCreationRatio5m !== null && cacheCreationRatio5m >= 0
          ? cacheCreationRatio5m
          : undefined,
      cacheCreationTokens1h:
        cacheCreationTokens1h !== null && cacheCreationTokens1h >= 0
          ? cacheCreationTokens1h
          : undefined,
      cacheCreationRatio1h:
        cacheCreationRatio1h !== null && cacheCreationRatio1h >= 0
          ? cacheCreationRatio1h
          : undefined,
      usageSemantic: usageSemantic.length > 0 ? usageSemantic : undefined,
    };
  }

  function toRemoteUsageLog(item: any): RemoteUsageLog {
    const quota = asNullableNumber(item.quota);
    const cache = parseUsageLogCacheMetadata(item);
    return {
      id: String(item.id),
      keyMasked: typeof item.token_name === 'string' ? item.token_name : '',
      modelId: typeof item.model_name === 'string' ? item.model_name : '',
      status: 'success',
      inputTokens: asNumber(item.prompt_tokens),
      outputTokens: asNumber(item.completion_tokens),
      cacheTokens: cache.cacheTokens,
      cacheRatio: cache.cacheRatio,
      cacheCreationTokens: cache.cacheCreationTokens,
      cacheCreationRatio: cache.cacheCreationRatio,
      cacheCreationTokens5m: cache.cacheCreationTokens5m,
      cacheCreationRatio5m: cache.cacheCreationRatio5m,
      cacheCreationTokens1h: cache.cacheCreationTokens1h,
      cacheCreationRatio1h: cache.cacheCreationRatio1h,
      usageSemantic: cache.usageSemantic,
      spendUsd: quota === null ? undefined : quotaToUsd(quota),
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
    };
  }

  async function getPricingSnapshot(): Promise<RemotePricingSnapshot> {
    const payload = await requestEnvelope('/api/pricing');
    const vendors = normalizeVendors(payload.vendors ?? payload.data?.vendors);
    const models = extractPricingItems(payload)
      .map((item) => toRemotePricingModel(item, vendors))
      .filter((item) => item.modelId.length > 0);
    const groupRatios = extractGroupRatios(payload);
    const usableGroups = extractUsableGroups(payload);
    const sourceFingerprint = fingerprintPricingSnapshot({
      models,
      vendors,
      groupRatios,
      usableGroups,
    });

    return {
      models,
      vendors,
      groupRatios,
      usableGroups,
      sourceFingerprint,
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

    getPricingSnapshot,

    async listPricingModels(): Promise<RemotePricingModel[]> {
      return (await getPricingSnapshot()).models;
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
      group?: string;
    }): Promise<RemoteProvisionedUser> {
      const existing = await findUserByUsername(input.username);
      const isExistingRemoteUser = Boolean(existing);
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
      if (input.group?.trim() && !isExistingRemoteUser) {
        const groupUser = requireRemoteUserProfile(found, input.username);
        if (!groupUser) {
          throw new NewApiBridgeError({
            code: 'remote_error',
            message: `New API user not found for group update: ${input.username}`,
          });
        }
        await ensureRemoteUserGroup(groupUser, input.group);
      }

      const loginResponse = await rawRequest('/api/user/login', {
        method: 'POST',
        body: { username: input.username, password: input.password },
        auth: 'none',
      });
      const loginPayload = await loginResponse.json().catch(() => undefined);
      if (!loginPayload?.success) {
        if (isExistingRemoteUser) {
          throw new NewApiBridgeError({
            code: 'conflict_requires_review',
            message: `New API username already exists and requires review: ${input.username}`,
            conflictNewapiUserId: found.newapiUserId,
          });
        }
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

      if (input.group?.trim() && isExistingRemoteUser) {
        const groupUser = requireRemoteUserProfile(found, input.username);
        if (!groupUser) {
          throw new NewApiBridgeError({
            code: 'remote_error',
            message: `New API user not found for group update: ${input.username}`,
          });
        }
        await ensureRemoteUserGroup(groupUser, input.group);
      }

      const accessToken = await request<string>('/api/user/token', {
        auth: { token: '', userId: found.newapiUserId },
        cookie,
      });
      if (typeof accessToken !== 'string' || accessToken.length === 0) {
        throw new NewApiBridgeError({
          code: 'malformed_response',
          message: 'New API did not return an access token',
        });
      }

      return { newapiUserId: found.newapiUserId, accessToken };
    },

    async ensureUserGroup(input: {
      newapiUserId: string;
      username: string;
      group: string;
    }): Promise<void> {
      const found = requireRemoteUserProfile(
        await findUserByUsername(input.username),
        input.username
      );
      if (!found) {
        throw new NewApiBridgeError({
          code: 'remote_error',
          message: `New API user not found for group update: ${input.username}`,
        });
      }
      if (found.newapiUserId !== input.newapiUserId) {
        throw new NewApiBridgeError({
          code: 'remote_error',
          message: `New API user id mismatch for group update: ${input.username}`,
        });
      }
      await ensureRemoteUserGroup(found, input.group);
    },

    async getUserProfile(input: {
      newapiUserId: string;
      username: string;
    }): Promise<RemoteUserProfile> {
      const found = requireRemoteUserProfile(
        await findUserByUsername(input.username),
        input.username
      );
      if (!found || found.newapiUserId !== input.newapiUserId) {
        throw new NewApiBridgeError({
          code: 'remote_error',
          message: `New API user profile was not confirmed: ${input.username}`,
        });
      }
      return found;
    },

    async updateUserProfile(
      input: NewApiUserProfileUpdateInput
    ): Promise<RemoteUserProfile> {
      const current = input.currentUsername
        ? requireRemoteUserProfile(
            await findUserByUsername(input.currentUsername),
            input.currentUsername
          )
        : undefined;
      const target = requireRemoteUserProfile(
        await findUserByUsername(input.username),
        input.username
      );

      if (target && target.newapiUserId !== input.newapiUserId) {
        throw new NewApiBridgeError({
          code: 'conflict_requires_review',
          message: `New API username belongs to another user: ${input.username}`,
          conflictNewapiUserId: target.newapiUserId,
        });
      }

      const remote = current ?? target;
      if (!remote || remote.newapiUserId !== input.newapiUserId) {
        throw new NewApiBridgeError({
          code: 'remote_error',
          message: `New API user not found for profile update: ${input.newapiUserId}`,
        });
      }

      const displayName = input.displayName || input.username;
      try {
        await request('/api/user/', {
          method: 'PUT',
          body: {
            id: toRemoteUserId(input.newapiUserId),
            username: input.username,
            display_name: displayName,
            group: input.group ?? remote.group,
            role: remote.role,
            remark: input.remark ?? remote.remark,
          },
        });
      } catch (error: any) {
        const message = String(error?.message || '');
        if (/\bmax\b/i.test(message) && /username|display/i.test(message)) {
          throw new NewApiBridgeError({
            code: 'newapi_username_too_long',
            message,
            status: error?.status,
          });
        }
        throw error;
      }

      const confirmed = requireRemoteUserProfile(
        await findUserByUsername(input.username),
        input.username
      );
      if (!confirmed || confirmed.newapiUserId !== input.newapiUserId) {
        throw new NewApiBridgeError({
          code: 'remote_error',
          message: `New API profile update was not confirmed: ${input.username}`,
        });
      }
      return confirmed;
    },

    /**
     * 建 Key：remoteName 必须全局唯一（portal 用本地 keyId），借此实现
     * 门户侧幂等——先查同名 token，存在即复用，避免远端重复创建。
     */
    async createKey(input: {
      user: NewApiUserCredentials;
      remoteName: string;
      group?: string;
      allowedModels?: string[];
      quotaLimitUsd?: number;
      ipAllowlist?: string[];
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
            group: input.group ?? '',
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
      const outputTokens = logs.reduce((sum, log) => sum + log.outputTokens, 0);

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
      /**
       * 正向调额时在「兑换码已生成、尚未发出兑换请求」的窗口回调一次。
       * 调用方应在此持久化码值：之后的任何崩溃都不得再自动重试。
       */
      onRedemptionCreated?: (code: string) => Promise<void> | void;
    }): Promise<{ changeId: string; balanceUsd?: number }> {
      return withQuotaAdjustmentLock(input.user.newapiUserId, async () => {
        if (input.amountUsd === 0) {
          throw new NewApiBridgeError({
            code: 'remote_error',
            message: 'Quota adjustment amount must be non-zero',
          });
        }
        if (input.amountUsd < 0) {
          const current = await getQuotaForUser(input.user);
          if (current.quotaRemaining === undefined) {
            throw new NewApiBridgeError({
              code: 'malformed_response',
              message: 'New API quota response missing remaining quota',
            });
          }
          const nextQuota =
            current.quotaRemaining + usdToQuota(input.amountUsd);
          if (nextQuota < 0) {
            throw new NewApiBridgeError({
              code: 'remote_error',
              message: 'Quota adjustment would make the balance negative',
            });
          }

          await request('/api/user/', {
            method: 'PUT',
            body: {
              id: toRemoteUserId(input.user.newapiUserId),
              quota: nextQuota,
            },
          });
          try {
            const quota = await getQuotaForUser(input.user);
            return { changeId: input.reference, balanceUsd: quota.balanceUsd };
          } catch (error: any) {
            throw new NewApiQuotaAdjustmentReconciliationError({
              changeId: input.reference,
              message: error?.message || 'Quota adjustment confirmation failed',
            });
          }
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

        // 先把码值交给调用方落库，再发出兑换请求。否则进程在兑换飞行途中被杀
        // 时无人知道远端是否已入账，重试会生成第二张码并双倍到账。
        await input.onRedemptionCreated?.(code);

        // 兑换码已生成 = 远端可能已被兑换。此后任何失败（兑换请求超时、
        // 确认查询失败）都必须带着码值升级为人工核对：重试会生成第二张码，
        // 「一码一兑」的幂等跨码不设防，会双倍到账（docs/06 第 5 节）。
        try {
          await request('/api/user/topup', {
            method: 'POST',
            auth: userAuth(input.user),
            body: { key: code },
          });
          const quota = await getQuotaForUser(input.user);
          return { changeId: code, balanceUsd: quota.balanceUsd };
        } catch (error: any) {
          throw new NewApiQuotaAdjustmentReconciliationError({
            changeId: code,
            message: error?.message || 'Quota adjustment confirmation failed',
          });
        }
      });
    },
  };
}

export type NewApiClient = ReturnType<typeof createNewApiClient>;
