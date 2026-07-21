import 'server-only';

import {
  assessPublishReadiness,
  type PublishReadiness,
} from '@/features/api-catalog/server/publish-readiness';
import { and, desc, eq } from 'drizzle-orm';

import { db } from '@/core/db';
import { modelPriceVersion, modelRoute } from '@/config/db/schema';
import { getUuid } from '@/shared/lib/hash';

const SYSTEM_PUBLISHER = 'system:catalog';

type CatalogRouteConfig = Extract<
  PublishReadiness,
  { ready: true }
>['snapshot'];

async function loadCatalogRouteConfig(
  portalGroupId: string,
  portalModelId: string
): Promise<CatalogRouteConfig | null> {
  const readiness = await assessPublishReadiness(portalGroupId, portalModelId);
  return readiness.ready ? readiness.snapshot : null;
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
    price?.billingScheme === config.billingScheme &&
    price.ratesJson === config.ratesJson &&
    price.tiersJson === config.tiersJson &&
    price.longContextThresholdTokens === config.longContextThresholdTokens
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
  publish: CatalogRouteConfig;
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
    return { route: current.route!, price: current.price!, publish: config };
  }

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await db().transaction(async (tx: any) => {
        const active = await activeSnapshots(tx, portalGroupId, portalModelId);
        if (
          routeMatches(active.route, config) &&
          priceMatches(active.price, config)
        ) {
          return {
            route: active.route!,
            price: active.price!,
            publish: config,
          };
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
          billingScheme: config.billingScheme,
          ratesJson: config.ratesJson,
          tiersJson: config.tiersJson,
          longContextThresholdTokens: config.longContextThresholdTokens,
          refNewapiGroup: config.newapiGroup,
          sourceNote: '由目录基础价与上架折扣自动生成',
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
        return { route: insertedRoute, price: insertedPrice, publish: config };
      });
    } catch (error) {
      if (!isConcurrentWrite(error) || attempt === 2) throw error;
    }
  }
  return null;
}
