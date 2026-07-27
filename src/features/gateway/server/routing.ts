import 'server-only';

import { and, eq } from 'drizzle-orm';

import {
  catalogGroup,
  catalogModel,
  catalogModelListing,
} from '@/config/db/schema';
import { db } from '@/core/db';
import type { RatesMap } from '@/features/gateway/lib/billing';
import type { BillingScheme } from '@/features/gateway/lib/meters';
import {
  parsePricingSpec,
  type PricingBasis,
  type PricingSpec,
} from '@/features/gateway/lib/pricing-spec';
import { ensureCatalogRouteSnapshot } from '@/features/gateway/server/catalog-route-snapshot';

export interface ResolvedRoute {
  routeId: string;
  routeVersion: number;
  newapiGroup: string;
  newapiModelId: string;
  priceVersionId: string;
  billingScheme: BillingScheme;
  pricingBasis: PricingBasis;
  pricingSpec: PricingSpec;
  rates: RatesMap;
  tiers: Record<string, number>;
  longContextThresholdTokens: number | null;
  admissionLongContextThreshold: number | null;
  allowLongContext: boolean;
  portalGroupId: string;
  portalModelId: string;
}

function parseIntegerMap(raw: string, label: string): Record<string, number> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${label} 无法解析`, { cause: error });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${label} 必须是对象`);
  }
  const result: Record<string, number> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (!Number.isSafeInteger(value) || Number(value) < 0) {
      throw new Error(`${label} 的 ${key} 不是有效非负整数`);
    }
    result[key] = Number(value);
  }
  return result;
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
  const { route, price, publish } = snapshot;
  const pricingSpec = parsePricingSpec(price.pricingSpecJson);
  if (
    pricingSpec.basis !== publish.pricingBasis ||
    price.billingScheme !== publish.billingScheme
  ) {
    throw new Error('发布快照的计费方式不一致');
  }
  const billingScheme = price.billingScheme as BillingScheme;

  return {
    routeId: route.id,
    routeVersion: route.version,
    newapiGroup: route.newapiGroup,
    newapiModelId: route.newapiModelId,
    priceVersionId: price.id,
    billingScheme,
    pricingBasis: pricingSpec.basis,
    pricingSpec,
    rates: parseIntegerMap(price.ratesJson, '价格 rates_json') as RatesMap,
    tiers: parseIntegerMap(price.tiersJson, '价格 tiers_json'),
    longContextThresholdTokens: price.longContextThresholdTokens,
    admissionLongContextThreshold: price.admissionLongContextThresholdTokens,
    allowLongContext: price.allowLongContext,
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
