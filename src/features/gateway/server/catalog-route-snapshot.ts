import 'server-only';

import { scaleMicroUsdByBps } from '@/features/api-catalog/lib/pricing';
import { isListingCallable } from '@/features/api-catalog/server/queries';
import type { PriceVector } from '@/features/gateway/lib/billing';
import { and, desc, eq } from 'drizzle-orm';

import { db } from '@/core/db';
import {
  catalogGroup,
  catalogModel,
  catalogModelListing,
  catalogModelPrice,
  modelPriceVersion,
  modelRoute,
} from '@/config/db/schema';
import { getUuid } from '@/shared/lib/hash';

const SYSTEM_PUBLISHER = 'system:catalog';

type CatalogRouteConfig = {
  newapiGroup: string;
  newapiModelId: string;
  price: PriceVector;
};

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function scaledPrice(base: number, ratioBps: number) {
  return scaleMicroUsdByBps(base, ratioBps)!;
}

function parseEndpointTypes(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : [];
  } catch {
    return [];
  }
}

async function loadCatalogRouteConfig(
  portalGroupId: string,
  portalModelId: string
): Promise<CatalogRouteConfig | null> {
  if (!(await isListingCallable(portalGroupId, portalModelId))) return null;

  const [row] = await db()
    .select({
      newapiGroup: catalogGroup.newapiGroup,
      groupRatioBps: catalogGroup.newapiGroupRatioBps,
      modelId: catalogModel.modelId,
      pricePolicy: catalogModelListing.pricePolicy,
      priceDriftStatus: catalogModelListing.priceDriftStatus,
      baseInput: catalogModelPrice.baseInputMicroUsd,
      baseCachedInput: catalogModelPrice.baseCachedInputMicroUsd,
      baseCacheWrite5m: catalogModelPrice.baseCacheWrite5mMicroUsd,
      baseCacheWrite1h: catalogModelPrice.baseCacheWrite1hMicroUsd,
      baseOutput: catalogModelPrice.baseOutputMicroUsd,
      baseSyncStatus: catalogModelPrice.syncStatus,
      baseReviewedAt: catalogModelPrice.reviewedAt,
      endpointTypes: catalogModelPrice.sourceSupportedEndpointTypes,
    })
    .from(catalogModelListing)
    .innerJoin(catalogGroup, eq(catalogModelListing.groupId, catalogGroup.id))
    .innerJoin(catalogModel, eq(catalogModelListing.modelId, catalogModel.id))
    .innerJoin(
      catalogModelPrice,
      eq(catalogModelPrice.modelId, catalogModel.id)
    )
    .where(
      and(
        eq(catalogGroup.id, portalGroupId),
        eq(catalogModel.modelId, portalModelId)
      )
    )
    .limit(1);

  if (!row || row.pricePolicy !== 'inherit_group') return null;
  if (row.priceDriftStatus !== 'matched') return null;
  if (
    row.baseSyncStatus !== 'synced' &&
    !(row.baseSyncStatus === 'manual' && row.baseReviewedAt)
  ) {
    return null;
  }
  if (!positiveInteger(row.groupRatioBps)) return null;
  if (
    !positiveInteger(row.baseInput) ||
    !positiveInteger(row.baseCachedInput) ||
    !positiveInteger(row.baseOutput)
  ) {
    return null;
  }

  const endpointTypes = parseEndpointTypes(row.endpointTypes).map((value) =>
    value.toLowerCase()
  );
  const requiresSplitCacheWrite = endpointTypes.some(
    (value) => value.includes('messages') || value.includes('anthropic')
  );
  if (
    requiresSplitCacheWrite &&
    (!positiveInteger(row.baseCacheWrite5m) ||
      !positiveInteger(row.baseCacheWrite1h))
  ) {
    return null;
  }

  return {
    newapiGroup: row.newapiGroup,
    newapiModelId: row.modelId,
    price: {
      inputMicroUsdPerM: scaledPrice(row.baseInput, row.groupRatioBps),
      cachedInputMicroUsdPerM: scaledPrice(
        row.baseCachedInput,
        row.groupRatioBps
      ),
      cacheWrite5mMicroUsdPerM: row.baseCacheWrite5m
        ? scaledPrice(row.baseCacheWrite5m, row.groupRatioBps)
        : 0,
      cacheWrite1hMicroUsdPerM: row.baseCacheWrite1h
        ? scaledPrice(row.baseCacheWrite1h, row.groupRatioBps)
        : 0,
      outputMicroUsdPerM: scaledPrice(row.baseOutput, row.groupRatioBps),
    },
  };
}

function routeMatches(
  route: typeof modelRoute.$inferSelect | undefined,
  config: CatalogRouteConfig
) {
  return (
    route?.newapiGroup === config.newapiGroup &&
    route.newapiModelId === config.newapiModelId
  );
}

function priceMatches(
  price: typeof modelPriceVersion.$inferSelect | undefined,
  config: CatalogRouteConfig
) {
  return (
    price?.refNewapiGroup === config.newapiGroup &&
    price.inputMicroUsdPerM === config.price.inputMicroUsdPerM &&
    price.cachedInputMicroUsdPerM === config.price.cachedInputMicroUsdPerM &&
    price.cacheWrite5mMicroUsdPerM === config.price.cacheWrite5mMicroUsdPerM &&
    price.cacheWrite1hMicroUsdPerM === config.price.cacheWrite1hMicroUsdPerM &&
    price.outputMicroUsdPerM === config.price.outputMicroUsdPerM
  );
}

async function activeSnapshots(
  tx: any,
  portalGroupId: string,
  portalModelId: string
) {
  const [[route], [price]] = await Promise.all([
    tx
      .select()
      .from(modelRoute)
      .where(
        and(
          eq(modelRoute.portalGroupId, portalGroupId),
          eq(modelRoute.portalModelId, portalModelId),
          eq(modelRoute.status, 'active')
        )
      )
      .limit(1),
    tx
      .select()
      .from(modelPriceVersion)
      .where(
        and(
          eq(modelPriceVersion.portalGroupId, portalGroupId),
          eq(modelPriceVersion.portalModelId, portalModelId),
          eq(modelPriceVersion.status, 'active')
        )
      )
      .limit(1),
  ]);
  return { route, price };
}

async function nextVersion(
  tx: any,
  table: typeof modelRoute | typeof modelPriceVersion,
  portalGroupId: string,
  portalModelId: string
) {
  const [latest] = await tx
    .select({ version: table.version })
    .from(table)
    .where(
      and(
        eq(table.portalGroupId, portalGroupId),
        eq(table.portalModelId, portalModelId)
      )
    )
    .orderBy(desc(table.version))
    .limit(1);
  return (latest?.version ?? 0) + 1;
}

async function retireSnapshots(portalGroupId: string, portalModelId: string) {
  const current = await activeSnapshots(db(), portalGroupId, portalModelId);
  if (!current.route && !current.price) return;

  const now = new Date();
  await db().transaction(async (tx: any) => {
    await Promise.all([
      tx
        .update(modelRoute)
        .set({ status: 'retired', retiredAt: now })
        .where(
          and(
            eq(modelRoute.portalGroupId, portalGroupId),
            eq(modelRoute.portalModelId, portalModelId),
            eq(modelRoute.status, 'active')
          )
        ),
      tx
        .update(modelPriceVersion)
        .set({ status: 'retired', retiredAt: now })
        .where(
          and(
            eq(modelPriceVersion.portalGroupId, portalGroupId),
            eq(modelPriceVersion.portalModelId, portalModelId),
            eq(modelPriceVersion.status, 'active')
          )
        ),
    ]);
  });
}

function isConcurrentWrite(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /unique|duplicate|constraint|busy|locked/i.test(message);
}

export async function ensureCatalogRouteSnapshot(
  portalGroupId: string,
  portalModelId: string
): Promise<{
  route: typeof modelRoute.$inferSelect;
  price: typeof modelPriceVersion.$inferSelect;
} | null> {
  const config = await loadCatalogRouteConfig(portalGroupId, portalModelId);
  if (!config) {
    await retireSnapshots(portalGroupId, portalModelId);
    return null;
  }

  // 热路径只读：每个请求都先开事务会让 SQLite 的准入写入与其它并发请求
  // 互相争锁。目录没有变化时直接复用已生成的不可变快照。
  const current = await activeSnapshots(db(), portalGroupId, portalModelId);
  if (
    routeMatches(current.route, config) &&
    priceMatches(current.price, config)
  ) {
    return { route: current.route!, price: current.price! };
  }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await db().transaction(async (tx: any) => {
        const active = await activeSnapshots(tx, portalGroupId, portalModelId);
        if (
          routeMatches(active.route, config) &&
          priceMatches(active.price, config)
        ) {
          return { route: active.route!, price: active.price! };
        }

        const now = new Date();
        await Promise.all([
          tx
            .update(modelRoute)
            .set({ status: 'retired', retiredAt: now })
            .where(
              and(
                eq(modelRoute.portalGroupId, portalGroupId),
                eq(modelRoute.portalModelId, portalModelId),
                eq(modelRoute.status, 'active')
              )
            ),
          tx
            .update(modelPriceVersion)
            .set({ status: 'retired', retiredAt: now })
            .where(
              and(
                eq(modelPriceVersion.portalGroupId, portalGroupId),
                eq(modelPriceVersion.portalModelId, portalModelId),
                eq(modelPriceVersion.status, 'active')
              )
            ),
        ]);

        const [routeVersion, priceVersion] = await Promise.all([
          nextVersion(tx, modelRoute, portalGroupId, portalModelId),
          nextVersion(tx, modelPriceVersion, portalGroupId, portalModelId),
        ]);
        const route = {
          id: getUuid(),
          portalGroupId,
          portalModelId,
          newapiGroup: config.newapiGroup,
          newapiModelId: config.newapiModelId,
          version: routeVersion,
          status: 'active',
          publishedBy: SYSTEM_PUBLISHER,
        };
        const price = {
          id: getUuid(),
          portalGroupId,
          portalModelId,
          version: priceVersion,
          status: 'active',
          ...config.price,
          newapiRefInputMicroUsdPerM: config.price.inputMicroUsdPerM,
          newapiRefCachedInputMicroUsdPerM:
            config.price.cachedInputMicroUsdPerM,
          newapiRefCacheWrite5mMicroUsdPerM:
            config.price.cacheWrite5mMicroUsdPerM || null,
          newapiRefCacheWrite1hMicroUsdPerM:
            config.price.cacheWrite1hMicroUsdPerM || null,
          newapiRefOutputMicroUsdPerM: config.price.outputMicroUsdPerM,
          refNewapiGroup: config.newapiGroup,
          sourceNote: '由模型基准价与分组折扣自动生成',
          publishedBy: SYSTEM_PUBLISHER,
        };
        const [insertedRoute] = await tx
          .insert(modelRoute)
          .values(route)
          .returning();
        const [insertedPrice] = await tx
          .insert(modelPriceVersion)
          .values(price)
          .returning();
        return { route: insertedRoute, price: insertedPrice };
      });
    } catch (error) {
      if (!isConcurrentWrite(error) || attempt === 2) throw error;
    }
  }
  return null;
}
