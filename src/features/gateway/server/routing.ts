import 'server-only';

import { isListingCallable } from '@/features/api-catalog/server/queries';
import type { PriceVector } from '@/features/gateway/lib/billing';
import { and, eq } from 'drizzle-orm';

import { db } from '@/core/db';
import { modelPriceVersion, modelRoute } from '@/config/db/schema';

export interface ResolvedRoute {
  routeId: string;
  routeVersion: number;
  newapiGroup: string;
  newapiModelId: string;
  priceVersionId: string;
  price: PriceVector;
  portalGroupId: string;
  portalModelId: string;
}

export async function resolveActiveRoute(
  portalGroupId: string,
  portalModelId: string
): Promise<ResolvedRoute | null> {
  const [route] = await db()
    .select()
    .from(modelRoute)
    .where(
      and(
        eq(modelRoute.portalGroupId, portalGroupId),
        eq(modelRoute.portalModelId, portalModelId),
        eq(modelRoute.status, 'active')
      )
    )
    .limit(1);
  if (!route) return null;

  const [price] = await db()
    .select()
    .from(modelPriceVersion)
    .where(
      and(
        eq(modelPriceVersion.portalGroupId, portalGroupId),
        eq(modelPriceVersion.portalModelId, portalModelId),
        eq(modelPriceVersion.status, 'active')
      )
    )
    .limit(1);
  if (!price) return null;

  if (price.refNewapiGroup !== route.newapiGroup) {
    console.error('[gateway] route_price_group_mismatch', {
      portalGroupId,
      portalModelId,
      routeGroup: route.newapiGroup,
      priceRefGroup: price.refNewapiGroup,
    });
    return null;
  }
  if (!(await isListingCallable(portalGroupId, portalModelId))) return null;

  return {
    routeId: route.id,
    routeVersion: route.version,
    newapiGroup: route.newapiGroup,
    newapiModelId: route.newapiModelId,
    priceVersionId: price.id,
    price: {
      inputMicroUsdPerM: price.inputMicroUsdPerM,
      cachedInputMicroUsdPerM: price.cachedInputMicroUsdPerM,
      cacheWrite5mMicroUsdPerM: price.cacheWrite5mMicroUsdPerM,
      cacheWrite1hMicroUsdPerM: price.cacheWrite1hMicroUsdPerM,
      outputMicroUsdPerM: price.outputMicroUsdPerM,
    },
    portalGroupId,
    portalModelId,
  };
}

export async function getCallableModelIds(
  portalGroupId: string
): Promise<string[]> {
  const routes = await db()
    .select({ portalModelId: modelRoute.portalModelId })
    .from(modelRoute)
    .where(
      and(
        eq(modelRoute.portalGroupId, portalGroupId),
        eq(modelRoute.status, 'active')
      )
    );
  const modelIds: string[] = [];
  for (const route of routes) {
    if (await resolveActiveRoute(portalGroupId, route.portalModelId)) {
      modelIds.push(route.portalModelId);
    }
  }
  return modelIds.sort();
}
