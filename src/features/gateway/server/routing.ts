import 'server-only';

import type { PriceVector } from '@/features/gateway/lib/billing';
import { ensureCatalogRouteSnapshot } from '@/features/gateway/server/catalog-route-snapshot';
import { and, eq } from 'drizzle-orm';

import { db } from '@/core/db';
import {
  catalogGroup,
  catalogModel,
  catalogModelListing,
} from '@/config/db/schema';

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
  const snapshot = await ensureCatalogRouteSnapshot(
    portalGroupId,
    portalModelId
  );
  if (!snapshot) return null;
  const { route, price } = snapshot;

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
  const listings = await db()
    .select({ portalModelId: catalogModel.modelId })
    .from(catalogModelListing)
    .innerJoin(catalogModel, eq(catalogModelListing.modelId, catalogModel.id))
    .innerJoin(catalogGroup, eq(catalogModelListing.groupId, catalogGroup.id))
    .where(
      and(eq(catalogGroup.id, portalGroupId), eq(catalogGroup.status, 'active'))
    );
  const modelIds: string[] = [];
  for (const listing of listings) {
    if (await resolveActiveRoute(portalGroupId, listing.portalModelId)) {
      modelIds.push(listing.portalModelId);
    }
  }
  return modelIds.sort();
}
