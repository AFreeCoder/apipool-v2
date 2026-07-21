import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { createClient } from '@libsql/client';
import { and, eq } from 'drizzle-orm';

let modules: any;
let client: ReturnType<typeof createClient>;

const IDs = {
  vendor: 'routing-vendor',
  category: 'routing-category',
  capability: 'routing-capability',
  status: 'routing-status',
  disabledStatus: 'routing-disabled-status',
  group: 'routing-group',
  model: 'routing-model-pk',
  modelId: 'portal-routing-model',
  listing: 'routing-listing',
};

async function setupDb() {
  const dbPath = join(process.cwd(), '.tmp', 'gateway-routing.db');
  await mkdir(join(process.cwd(), '.tmp'), { recursive: true });
  await rm(dbPath, { force: true });
  process.env.DATABASE_PROVIDER = 'sqlite';
  process.env.DATABASE_URL = `file:${dbPath}`;
  process.env.DB_SCHEMA_FILE = './src/config/db/schema.sqlite.ts';
  process.env.DB_SINGLETON_ENABLED = 'false';

  client = createClient({ url: `file:${dbPath}` });
  const migrationsDir = join(process.cwd(), 'src/config/db/migrations_sqlite');
  for (const file of (await readdir(migrationsDir))
    .filter((name) => name.endsWith('.sql'))
    .sort()) {
    await client.executeMultiple(
      await readFile(join(migrationsDir, file), 'utf8')
    );
  }
  const schema = await import('@/config/db/schema');
  const { db } = await import('@/core/db');
  const routing = await import('@/features/gateway/server/routing');
  const modelsEndpoint = await import(
    '@/features/gateway/server/models-endpoint'
  );
  modules = { db, modelsEndpoint, routing, schema };

  await modules.db().insert(schema.catalogVendor).values({
    id: IDs.vendor,
    slug: IDs.vendor,
    name: 'Routing Vendor',
  });
  await modules.db().insert(schema.catalogCategory).values({
    id: IDs.category,
    slug: IDs.category,
    name: 'Routing Category',
  });
  await modules.db().insert(schema.catalogCapability).values({
    id: IDs.capability,
    slug: IDs.capability,
    name: 'Routing Capability',
  });
  await modules
    .db()
    .insert(schema.catalogStatus)
    .values([
      {
        id: IDs.status,
        slug: IDs.status,
        name: 'Routing Ready',
        isCallable: true,
      },
      {
        id: IDs.disabledStatus,
        slug: IDs.disabledStatus,
        name: 'Routing Disabled',
        isCallable: false,
      },
    ]);
  await modules.db().insert(schema.catalogGroup).values({
    id: IDs.group,
    slug: IDs.group,
    name: 'Routing Group',
    newapiGroup: 'official',
    newapiGroupRatioBps: 8_000,
    pricingSyncStatus: 'synced',
  });
  await modules.db().insert(schema.catalogModel).values({
    id: IDs.model,
    modelId: IDs.modelId,
    displayName: 'Portal Routing Model',
    vendorId: IDs.vendor,
    category: IDs.category,
  });
  await modules.db().insert(schema.catalogModelCapability).values({
    id: 'routing-model-capability',
    modelId: IDs.model,
    capabilityId: IDs.capability,
  });
  await modules.db().insert(schema.catalogModelListing).values({
    id: IDs.listing,
    modelId: IDs.model,
    groupId: IDs.group,
    statusId: IDs.status,
    inputMicroUsd: 1_000_000,
    outputMicroUsd: 5_000_000,
    discountRateBps: 8_000,
    priceDriftStatus: 'matched',
  });
  await modules
    .db()
    .insert(schema.catalogModelPrice)
    .values({
      id: 'routing-base-price',
      modelId: IDs.model,
      baseInputMicroUsd: 1_000_000,
      baseCachedInputMicroUsd: 100_000,
      baseCacheWrite5mMicroUsd: 1_250_000,
      baseCacheWrite1hMicroUsd: 2_000_000,
      baseOutputMicroUsd: 5_000_000,
      sourceSupportedEndpointTypes: JSON.stringify(['messages']),
      billingCapabilitiesJson: JSON.stringify({
        cached_input: true,
        cache_write: true,
        cache_ttl_split: true,
      }),
      syncStatus: 'manual',
      reviewedAt: new Date('2026-07-20T00:00:00Z'),
      driftStatus: 'matched',
    });
}

test.before(setupDb);
test.after(() => client.close());

test('模型目录自动生成路由与不可变价格快照', async () => {
  const route = await modules.routing.resolveActiveRoute(
    IDs.group,
    IDs.modelId
  );
  assert.equal(route.newapiGroup, 'official');
  assert.equal(route.newapiModelId, IDs.modelId);
  assert.equal(route.routeVersion, 1);
  assert.equal(route.billingScheme, 'token');
  assert.deepEqual(route.rates, {
    input: 800_000,
    cached_input: 80_000,
    cache_write_5m: 1_000_000,
    cache_write_1h: 1_600_000,
    output: 4_000_000,
  });
  const [snapshot] = await modules
    .db()
    .select()
    .from(modules.schema.modelRoute)
    .where(eq(modules.schema.modelRoute.id, route.routeId));
  assert.equal(snapshot.publishedBy, 'system:catalog');
});
test('上架折扣或映射变化会自动滚动快照版本', async () => {
  await modules
    .db()
    .update(modules.schema.catalogGroup)
    .set({ newapiGroup: 'vip' })
    .where(eq(modules.schema.catalogGroup.id, IDs.group));
  await modules
    .db()
    .update(modules.schema.catalogModelListing)
    .set({ discountRateBps: 9_000 })
    .where(eq(modules.schema.catalogModelListing.id, IDs.listing));
  const route = await modules.routing.resolveActiveRoute(
    IDs.group,
    IDs.modelId
  );
  assert.equal(route.routeVersion, 2);
  assert.equal(route.newapiGroup, 'vip');
  assert.equal(route.rates.input, 900_000);
  const activeRoutes = await modules
    .db()
    .select()
    .from(modules.schema.modelRoute)
    .where(
      and(
        eq(modules.schema.modelRoute.portalGroupId, IDs.group),
        eq(modules.schema.modelRoute.status, 'active')
      )
    );
  assert.equal(activeRoutes.length, 1);
});

test('售卖项下线会阻断请求并退役运行时快照', async () => {
  await modules
    .db()
    .update(modules.schema.catalogModelListing)
    .set({ statusId: IDs.disabledStatus })
    .where(eq(modules.schema.catalogModelListing.id, IDs.listing));
  assert.equal(
    await modules.routing.resolveActiveRoute(IDs.group, IDs.modelId),
    null
  );
  assert.deepEqual(await modules.routing.getCallableModelIds(IDs.group), []);
  const activeRoutes = await modules
    .db()
    .select()
    .from(modules.schema.modelRoute)
    .where(eq(modules.schema.modelRoute.status, 'active'));
  assert.equal(activeRoutes.length, 0);
});
