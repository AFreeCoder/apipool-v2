import { PERMISSIONS } from '@/core/rbac/permission-codes';
import type { PriceVector } from '@/features/gateway/lib/billing';
import {
  publishModelRoute,
  publishPriceVersion,
} from '@/features/routing-admin/server/route-service';
import { getRoutingMatrix } from '@/features/routing-admin/server/admin-service';
import {
  authorizeAdminRoute,
  setAdminRouteAuthDepsForTest,
} from '@/features/routing-admin/server/admin-route-auth';
import { withNoStore } from '@/shared/lib/http-cache';
import { respData, respErr } from '@/shared/lib/resp';

export const dynamic = 'force-dynamic';
export const __setDepsForTest = setAdminRouteAuthDepsForTest;

const PRICE_KEYS: Array<keyof PriceVector> = [
  'inputMicroUsdPerM',
  'cachedInputMicroUsdPerM',
  'cacheWrite5mMicroUsdPerM',
  'cacheWrite1hMicroUsdPerM',
  'outputMicroUsdPerM',
];

function parsePrice(value: unknown): PriceVector | null {
  if (!value || typeof value !== 'object') return null;
  const source = value as Record<string, unknown>;
  const result: Record<string, number> = {};
  for (const key of PRICE_KEYS) {
    const number = Number(source[key]);
    if (!Number.isSafeInteger(number) || number <= 0) return null;
    result[key] = number;
  }
  return result as unknown as PriceVector;
}

function serializeResult(result: any) {
  return typeof result?.worstCaseMicroUsd === 'bigint'
    ? { ...result, worstCaseMicroUsd: result.worstCaseMicroUsd.toString() }
    : result;
}

export async function GET() {
  try {
    const auth = await authorizeAdminRoute(PERMISSIONS.APIPOOL_ROUTING_READ);
    if ('response' in auth) return auth.response;
    return withNoStore(respData(await getRoutingMatrix()));
  } catch {
    return withNoStore(respErr('gateway routing matrix is unavailable'));
  }
}

export async function POST(req: Request) {
  try {
    const auth = await authorizeAdminRoute(PERMISSIONS.APIPOOL_ROUTING_WRITE);
    if ('response' in auth) return auth.response;
    const body = await req.json().catch(() => ({}));
    const portalGroupId = String(body.portalGroupId ?? '').trim();
    const portalModelId = String(body.portalModelId ?? '').trim();
    if (!portalGroupId || !portalModelId) {
      return withNoStore(respErr('portalGroupId and portalModelId are required'));
    }
    if (body.kind === 'price' || body.action === 'publish_price') {
      const price = parsePrice(body.price);
      if (!price) return withNoStore(respErr('valid five-dimensional price is required'));
      const result = await publishPriceVersion({
        portalGroupId,
        portalModelId,
        price,
        sourceNote: String(body.sourceNote ?? '').trim() || undefined,
        operatorUserId: auth.operatorId,
      });
      return withNoStore(respData(serializeResult(result)));
    }
    const newapiGroup = String(body.newapiGroup ?? '').trim();
    if (!newapiGroup) return withNoStore(respErr('newapiGroup is required'));
    const remapPrice = body.remapPrice
      ? parsePrice(body.remapPrice)
      : undefined;
    if (body.remapPrice && !remapPrice) {
      return withNoStore(respErr('valid remapPrice is required'));
    }
    const result = await publishModelRoute({
      portalGroupId,
      portalModelId,
      newapiGroup,
      newapiModelId: String(body.newapiModelId ?? '').trim() || undefined,
      operatorUserId: auth.operatorId,
      remapPrice: remapPrice
        ? {
            ...remapPrice,
            sourceNote:
              String(body.remapPrice?.sourceNote ?? '').trim() || undefined,
          }
        : undefined,
    });
    return withNoStore(respData(serializeResult(result)));
  } catch (error) {
    const message =
      error instanceof Error && error.name === 'ConcurrentPublishError'
        ? error.message
        : 'gateway route publish failed';
    return withNoStore(respErr(message));
  }
}
