import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { createClient } from '@libsql/client';
import { eq } from 'drizzle-orm';

let modules: any;
let client: ReturnType<typeof createClient>;

const IDs = {
  vendor: 'routing-vendor',
  category: 'routing-category',
  capability: 'routing-capability',
  status: 'routing-status',
  group: 'routing-group',
  model: 'routing-model-pk',
  modelId: 'portal-routing-model',
  listing: 'routing-listing',
  modelCapability: 'routing-model-capability',
  route: 'routing-route-v1',
  price: 'routing-price-v1',
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
    status: 'active',
  });
  await modules.db().insert(schema.catalogCategory).values({
    id: IDs.category,
    slug: IDs.category,
    name: 'Routing Category',
    status: 'active',
  });
  await modules.db().insert(schema.catalogCapability).values({
    id: IDs.capability,
    slug: IDs.capability,
    name: 'Routing Capability',
    status: 'active',
  });
  await modules.db().insert(schema.catalogStatus).values({
    id: IDs.status,
    slug: IDs.status,
    name: 'Routing Ready',
    isCallable: true,
    status: 'active',
  });
  await modules.db().insert(schema.catalogGroup).values({
    id: IDs.group,
    slug: IDs.group,
    name: 'Routing Group',
    newapiGroup: 'official',
    status: 'active',
  });
  await modules.db().insert(schema.catalogModel).values({
    id: IDs.model,
    modelId: IDs.modelId,
    displayName: 'Portal Routing Model',
    vendorId: IDs.vendor,
    category: IDs.category,
  });
  await modules.db().insert(schema.catalogModelCapability).values({
    id: IDs.modelCapability,
    modelId: IDs.model,
    capabilityId: IDs.capability,
  });
  await modules.db().insert(schema.catalogModelListing).values({
    id: IDs.listing,
    modelId: IDs.model,
    groupId: IDs.group,
    statusId: IDs.status,
    inputMicroUsd: 1,
    outputMicroUsd: 2,
  });
  await modules.db().insert(schema.modelRoute).values({
    id: IDs.route,
    portalGroupId: IDs.group,
    portalModelId: IDs.modelId,
    newapiGroup: 'official',
    newapiModelId: 'newapi-routing-model',
    version: 1,
    status: 'active',
    publishedBy: 'routing-test',
  });
  await modules.db().insert(schema.modelPriceVersion).values({
    id: IDs.price,
    portalGroupId: IDs.group,
    portalModelId: IDs.modelId,
    version: 1,
    status: 'active',
    inputMicroUsdPerM: 1_000_000,
    cachedInputMicroUsdPerM: 100_000,
    cacheWrite5mMicroUsdPerM: 1_250_000,
    cacheWrite1hMicroUsdPerM: 2_000_000,
    outputMicroUsdPerM: 5_000_000,
    refNewapiGroup: 'official',
    publishedBy: 'routing-test',
  });
}

test.before(setupDb);
test.after(() => client.close());

test('resolveActiveRoute 返回 route 版本与完整 PriceVector', async () => {
  const route = await modules.routing.resolveActiveRoute(
    IDs.group,
    IDs.modelId
  );
  assert.deepEqual(route, {
    routeId: IDs.route,
    routeVersion: 1,
    newapiGroup: 'official',
    newapiModelId: 'newapi-routing-model',
    priceVersionId: IDs.price,
    price: {
      inputMicroUsdPerM: 1_000_000,
      cachedInputMicroUsdPerM: 100_000,
      cacheWrite5mMicroUsdPerM: 1_250_000,
      cacheWrite1hMicroUsdPerM: 2_000_000,
      outputMicroUsdPerM: 5_000_000,
    },
    portalGroupId: IDs.group,
    portalModelId: IDs.modelId,
  });
});

test('缺 active price、route retired 或 listing 不可调用均返回 null', async () => {
  await modules
    .db()
    .update(modules.schema.modelPriceVersion)
    .set({ status: 'retired' })
    .where(eq(modules.schema.modelPriceVersion.id, IDs.price));
  assert.equal(
    await modules.routing.resolveActiveRoute(IDs.group, IDs.modelId),
    null
  );
  await modules
    .db()
    .update(modules.schema.modelPriceVersion)
    .set({ status: 'active' })
    .where(eq(modules.schema.modelPriceVersion.id, IDs.price));
  await modules
    .db()
    .update(modules.schema.modelRoute)
    .set({ status: 'retired' })
    .where(eq(modules.schema.modelRoute.id, IDs.route));
  assert.equal(
    await modules.routing.resolveActiveRoute(IDs.group, IDs.modelId),
    null
  );
  await modules
    .db()
    .update(modules.schema.modelRoute)
    .set({ status: 'active' })
    .where(eq(modules.schema.modelRoute.id, IDs.route));
  await modules
    .db()
    .update(modules.schema.catalogStatus)
    .set({ isCallable: false })
    .where(eq(modules.schema.catalogStatus.id, IDs.status));
  assert.equal(
    await modules.routing.resolveActiveRoute(IDs.group, IDs.modelId),
    null
  );
  await modules
    .db()
    .update(modules.schema.catalogStatus)
    .set({ isCallable: true })
    .where(eq(modules.schema.catalogStatus.id, IDs.status));
});

test('vendor/group/category/status/active capability 任一紧急下线都同时阻断 resolve 与 models', async () => {
  const dimensions = [
    [modules.schema.catalogVendor, IDs.vendor],
    [modules.schema.catalogGroup, IDs.group],
    [modules.schema.catalogCategory, IDs.category],
    [modules.schema.catalogStatus, IDs.status],
  ] as const;
  for (const [table, id] of dimensions) {
    await modules
      .db()
      .update(table)
      .set({ status: 'disabled' })
      .where(eq(table.id, id));
    assert.equal(
      await modules.routing.resolveActiveRoute(IDs.group, IDs.modelId),
      null
    );
    assert.deepEqual(await modules.routing.getCallableModelIds(IDs.group), []);
    await modules
      .db()
      .update(table)
      .set({ status: 'active' })
      .where(eq(table.id, id));
  }

  await modules
    .db()
    .delete(modules.schema.catalogModelCapability)
    .where(eq(modules.schema.catalogModelCapability.id, IDs.modelCapability));
  assert.equal(
    await modules.routing.resolveActiveRoute(IDs.group, IDs.modelId),
    null
  );
  assert.deepEqual(await modules.routing.getCallableModelIds(IDs.group), []);
  await modules.db().insert(modules.schema.catalogModelCapability).values({
    id: IDs.modelCapability,
    modelId: IDs.model,
    capabilityId: IDs.capability,
  });
});

test('route-price 分组错绑 fail-closed 并输出 route_price_group_mismatch', async () => {
  await modules
    .db()
    .update(modules.schema.modelPriceVersion)
    .set({ refNewapiGroup: 'wrong-group' })
    .where(eq(modules.schema.modelPriceVersion.id, IDs.price));
  const messages: any[] = [];
  const original = console.error;
  console.error = (...args: any[]) => messages.push(args);
  try {
    assert.equal(
      await modules.routing.resolveActiveRoute(IDs.group, IDs.modelId),
      null
    );
  } finally {
    console.error = original;
  }
  assert.ok(
    messages.some((args) =>
      String(args[0]).includes('route_price_group_mismatch')
    )
  );
  await modules
    .db()
    .update(modules.schema.modelPriceVersion)
    .set({ refNewapiGroup: 'official' })
    .where(eq(modules.schema.modelPriceVersion.id, IDs.price));
});

test('发布 v2 后 resolve 锁定返回 v2 路由与价格版本', async () => {
  await modules.db().transaction(async (tx: any) => {
    await tx
      .update(modules.schema.modelRoute)
      .set({ status: 'retired', retiredAt: new Date() })
      .where(eq(modules.schema.modelRoute.id, IDs.route));
    await tx
      .update(modules.schema.modelPriceVersion)
      .set({ status: 'retired', retiredAt: new Date() })
      .where(eq(modules.schema.modelPriceVersion.id, IDs.price));
    await tx.insert(modules.schema.modelRoute).values({
      id: 'routing-route-v2',
      portalGroupId: IDs.group,
      portalModelId: IDs.modelId,
      newapiGroup: 'official',
      newapiModelId: 'newapi-routing-model-v2',
      version: 2,
      status: 'active',
      publishedBy: 'routing-test',
    });
    await tx.insert(modules.schema.modelPriceVersion).values({
      id: 'routing-price-v2',
      portalGroupId: IDs.group,
      portalModelId: IDs.modelId,
      version: 2,
      status: 'active',
      inputMicroUsdPerM: 2,
      cachedInputMicroUsdPerM: 2,
      cacheWrite5mMicroUsdPerM: 2,
      cacheWrite1hMicroUsdPerM: 2,
      outputMicroUsdPerM: 2,
      refNewapiGroup: 'official',
      publishedBy: 'routing-test',
    });
  });
  const route = await modules.routing.resolveActiveRoute(
    IDs.group,
    IDs.modelId
  );
  assert.equal(route.routeVersion, 2);
  assert.equal(route.priceVersionId, 'routing-price-v2');
});

test('getCallableModelIds 与 buildModelsResponse 只暴露门户模型 ID', async () => {
  assert.deepEqual(await modules.routing.getCallableModelIds(IDs.group), [
    IDs.modelId,
  ]);
  const response = await modules.modelsEndpoint.buildModelsResponse(
    { groupId: IDs.group },
    'preq-models'
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('x-apipool-request-id'), 'preq-models');
  const body = await response.json();
  assert.deepEqual(body, {
    object: 'list',
    data: [
      { id: IDs.modelId, object: 'model', created: 0, owned_by: 'apipool' },
    ],
  });
  assert.equal(JSON.stringify(body).includes('newapi'), false);
  assert.equal(JSON.stringify(body).includes('routing-price'), false);
});
