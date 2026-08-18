import 'server-only';

import { and, eq, inArray, isNull, sql } from 'drizzle-orm';

import { requestLedger, walletAccount } from '@/config/db/schema';
import { db } from '@/core/db';
import { evaluateSkuRule } from '@/features/api-catalog/lib/sku-rule';
import { gatewayConfig } from '@/features/gateway/lib/config';
import type { GatewayEndpointKey } from '@/features/gateway/lib/endpoints';
import {
  extractRequestAdmissionMetadata,
  type RequestAdmissionMetadata,
} from '@/features/gateway/lib/sse-parser';
import type { ResolvedRoute } from '@/features/gateway/server/routing';

export interface AdmissionInput {
  id: string;
  userId: string;
  portalKeyId: string;
  portalGroupId: string;
  portalModelId: string;
  newapiGroup: string;
  newapiModelId: string;
  credentialId: string;
  routeVersion: number;
  priceVersionId: string;
  endpoint: GatewayEndpointKey;
  isStream: boolean;
  skuKey?: string | null;
}

const ESTIMATED_CHARS_PER_TOKEN = 2.5;
const ESTIMATED_MESSAGE_OVERHEAD_TOKENS = 128;
const SERVER_TOOL_PREFIXES = ['web_search'] as const;

export type ForwardAdmissionDecision =
  | {
      ok: true;
      skuKey: string | null;
      estimatedInputTokens: number;
    }
  | { ok: false; status: 400 | 413; message: string };

type ForwardAdmissionRoute = Pick<
  ResolvedRoute,
  | 'pricingBasis'
  | 'pricingSpec'
  | 'rates'
  | 'admissionLongContextThreshold'
  | 'allowLongContext'
>;

function normalizeFact(value?: string | null) {
  const normalized = value?.trim().toLowerCase();
  return normalized ? normalized : null;
}

export function evaluateForwardAdmission(
  body: Uint8Array,
  route: ForwardAdmissionRoute
): ForwardAdmissionDecision {
  const extraction = extractRequestAdmissionMetadata(body, {
    includeSku: route.pricingBasis !== 'token',
    serverToolPrefixes: SERVER_TOOL_PREFIXES,
  });
  if (!extraction.ok) {
    return { ok: false, status: 400, message: '请求参数格式不合法。' };
  }

  return evaluateForwardAdmissionMetadata(extraction.metadata, route);
}

export function evaluateForwardAdmissionMetadata(
  metadata: RequestAdmissionMetadata,
  route: ForwardAdmissionRoute
): ForwardAdmissionDecision {
  const estimatedInputTokens =
    Math.ceil(metadata.totalRequestChars / ESTIMATED_CHARS_PER_TOKEN) +
    ESTIMATED_MESSAGE_OVERHEAD_TOKENS * metadata.messageCount;
  if (
    !route.allowLongContext &&
    route.admissionLongContextThreshold !== null &&
    estimatedInputTokens >= route.admissionLongContextThreshold
  ) {
    return {
      ok: false,
      status: 413,
      message: '该分组未开放长上下文，请缩短输入或更换分组。',
    };
  }

  if (metadata.hasServerTool && route.rates.web_search === undefined) {
    return {
      ok: false,
      status: 400,
      message: '该模型未开放网页搜索工具。',
    };
  }

  if (route.pricingBasis === 'token') {
    return { ok: true, skuKey: null, estimatedInputTokens };
  }

  const rule = route.pricingSpec.skuRule;
  if (!rule) {
    return {
      ok: false,
      status: 400,
      message: '该定价档案缺少 SKU 规则。',
    };
  }
  const evaluated = evaluateSkuRule(rule, {
    quality: normalizeFact(metadata.quality),
    size: normalizeFact(metadata.size),
    resolution: normalizeFact(metadata.resolution),
    format: normalizeFact(metadata.format),
    voice: normalizeFact(metadata.voice),
  });
  if (!evaluated.ok) {
    return {
      ok: false,
      status: 400,
      message: '该请求参数组合未开放。',
    };
  }
  const skuKey = evaluated.skuKey;
  if (
    !route.pricingSpec.rates.some(
      (rate) =>
        rate.meterKey === route.pricingSpec.quantityMeter &&
        rate.skuKey === skuKey
    )
  ) {
    return {
      ok: false,
      status: 400,
      message: '该 SKU 参数组合未开放。',
    };
  }
  return { ok: true, skuKey, estimatedInputTokens };
}

export async function admitRequest(
  input: AdmissionInput,
  riskLimit: number
): Promise<boolean> {
  const now = Date.now();
  const result = await db().run(sql`
    INSERT INTO request_ledger (
      id, user_id, portal_key_id, portal_group_id, portal_model_id,
      newapi_group, newapi_model_id, credential_id, route_version,
      price_version_id, endpoint, is_stream, sku_key, status, created_at,
      updated_at
    )
    SELECT
      ${input.id}, ${input.userId}, ${input.portalKeyId},
      ${input.portalGroupId}, ${input.portalModelId}, ${input.newapiGroup},
      ${input.newapiModelId}, ${input.credentialId}, ${input.routeVersion},
      ${input.priceVersionId}, ${input.endpoint}, ${input.isStream ? 1 : 0},
      ${input.skuKey ?? null}, 'open', ${now}, ${now}
    WHERE (
      SELECT COUNT(*) FROM request_ledger
      WHERE user_id = ${input.userId}
        AND status IN ('open', 'pending_backfill')
    ) < ${riskLimit}
  `);
  return Number(result?.rowsAffected ?? 0) === 1;
}

export async function resolveRiskLimit(userId: string): Promise<number> {
  const [row] = await db()
    .select({ override: walletAccount.riskLimitOverride })
    .from(walletAccount)
    .where(eq(walletAccount.userId, userId))
    .limit(1);
  return row?.override ?? gatewayConfig().riskSlotLimit;
}

function isUniqueConstraint(error: unknown): boolean {
  const candidate = error as {
    code?: unknown;
    message?: unknown;
    cause?: unknown;
  };
  const code = String(candidate?.code ?? '');
  const message = String(candidate?.cause ?? candidate?.message ?? error);
  return (
    /SQLITE_CONSTRAINT_(UNIQUE|PRIMARYKEY)/i.test(code) ||
    /UNIQUE constraint failed/i.test(message)
  );
}

export async function captureRequestId(
  ledgerId: string,
  newapiRequestId: string
): Promise<boolean> {
  try {
    const [row] = await db()
      .update(requestLedger)
      .set({
        newapiRequestId,
        respondedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(requestLedger.id, ledgerId),
          eq(requestLedger.status, 'open'),
          isNull(requestLedger.newapiRequestId)
        )
      )
      .returning();
    return Boolean(row);
  } catch (error) {
    if (isUniqueConstraint(error)) {
      console.error('[gateway] duplicate newapi_request_id', {
        ledgerId,
        newapiRequestId,
      });
      return false;
    }
    throw error;
  }
}

export async function markFailedUnbilled(
  ledgerId: string,
  patch: {
    httpStatus?: number;
    errorCode?: string;
    streamAborted?: boolean;
    billingScheme?: 'token' | 'per_call';
    billingFlags?: string[];
    rawUsage?: unknown;
    usageSource?: 'response' | 'log_backfill';
  }
): Promise<boolean> {
  const [row] = await db()
    .update(requestLedger)
    .set({
      status: 'failed_unbilled',
      finishedAt: new Date(),
      updatedAt: new Date(),
      httpStatus: patch.httpStatus,
      errorCode: patch.errorCode,
      streamAborted: patch.streamAborted,
      billingScheme: patch.billingScheme,
      billingFlagsJson:
        patch.billingFlags && patch.billingFlags.length > 0
          ? JSON.stringify([...new Set(patch.billingFlags)])
          : undefined,
      rawUsageJson:
        patch.rawUsage === undefined
          ? undefined
          : JSON.stringify(patch.rawUsage),
      usageSource: patch.usageSource,
    })
    .where(
      and(
        eq(requestLedger.id, ledgerId),
        inArray(requestLedger.status, ['open', 'pending_backfill'])
      )
    )
    .returning();
  return Boolean(row);
}
