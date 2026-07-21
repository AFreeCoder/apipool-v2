import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { createClient } from '@libsql/client';
import { eq } from 'drizzle-orm';

let modules: any;
let client: ReturnType<typeof createClient>;

const IDs = {
  vendor: 'snapshot-vendor',
  category: 'snapshot-category',
  capability: 'snapshot-capability',
  status: 'snapshot-status',
  group: 'snapshot-group',
  model: 'snapshot-model-pk',
  modelId: 'snapshot-model',
  listing: 'snapshot-listing',
  price: 'snapshot-price',
};

async function setupDb() {
  const dbPath = join(process.cwd(), '.tmp', 'catalog-route-snapshot.db');
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
  const publishReadiness = await import(
    '@/features/api-catalog/server/publish-readiness'
  );
  const queries = await import('@/features/api-catalog/server/queries');
  const snapshots = await import(
    '@/features/gateway/server/catalog-route-snapshot'
  );
  modules = { db, publishReadiness, queries, schema, snapshots };

  await modules.db().insert(schema.catalogVendor).values({
    id: IDs.vendor,
    slug: IDs.vendor,
    name: '快照测试厂商',
  });
  await modules.db().insert(schema.catalogCategory).values({
    id: IDs.category,
    slug: IDs.category,
    name: '快照测试分类',
  });
  await modules.db().insert(schema.catalogCapability).values({
    id: IDs.capability,
    slug: IDs.capability,
    name: '快照测试能力',
  });
  await modules.db().insert(schema.catalogStatus).values({
    id: IDs.status,
    slug: IDs.status,
    name: '可调用',
    isCallable: true,
  });
  await modules.db().insert(schema.catalogGroup).values({
    id: IDs.group,
    slug: IDs.group,
    name: '快照测试分组',
    newapiGroup: 'official',
  });
  await modules.db().insert(schema.catalogModel).values({
    id: IDs.model,
    modelId: IDs.modelId,
    displayName: '快照测试模型',
    vendorId: IDs.vendor,
    category: IDs.category,
  });
  await modules.db().insert(schema.catalogModelCapability).values({
    id: 'snapshot-model-capability',
    modelId: IDs.model,
    capabilityId: IDs.capability,
  });
  await modules.db().insert(schema.catalogModelListing).values({
    id: IDs.listing,
    modelId: IDs.model,
    groupId: IDs.group,
    statusId: IDs.status,
    inputMicroUsd: 1_000_000,
    outputMicroUsd: 2_000_000,
    discountRateBps: 9_000,
  });
  await modules
    .db()
    .insert(schema.catalogModelPrice)
    .values({
      id: IDs.price,
      modelId: IDs.model,
      billingScheme: 'token',
      sourceSupportedEndpointTypes: JSON.stringify(['responses']),
      baseInputMicroUsd: 1_000_000,
      baseOutputMicroUsd: 2_000_000,
      billingCapabilitiesJson: '{}',
      syncStatus: 'manual',
      reviewedAt: new Date('2026-07-20T00:00:00Z'),
    });
}

async function assertConsumers(expected: boolean) {
  const readiness = await modules.publishReadiness.assessPublishReadiness(
    IDs.group,
    IDs.modelId
  );
  const callable = await modules.queries.isListingCallable(
    IDs.group,
    IDs.modelId
  );
  const snapshot = await modules.snapshots.ensureCatalogRouteSnapshot(
    IDs.group,
    IDs.modelId
  );
  assert.equal(readiness.ready, expected);
  assert.equal(callable, expected);
  assert.equal(snapshot !== null, expected);
  return snapshot;
}

test.before(setupDb);
test.after(() => client.close());

test('发布判定、目录 callable 与网关快照对同一完备集给出一致结论', async () => {
  const readySnapshot = await assertConsumers(true);
  assert.equal(readySnapshot.price.billingScheme, 'token');
  assert.deepEqual(JSON.parse(readySnapshot.price.ratesJson), {
    input: 900000,
    output: 1800000,
  });

  await modules
    .db()
    .update(modules.schema.catalogModelPrice)
    .set({ baseOutputMicroUsd: null })
    .where(eq(modules.schema.catalogModelPrice.id, IDs.price));
  await assertConsumers(false);

  await modules
    .db()
    .update(modules.schema.catalogModelPrice)
    .set({
      baseOutputMicroUsd: 2_000_000,
      billingCapabilitiesJson: '{invalid',
    })
    .where(eq(modules.schema.catalogModelPrice.id, IDs.price));
  await assertConsumers(false);

  await modules
    .db()
    .update(modules.schema.catalogModelPrice)
    .set({
      billingScheme: 'per_call',
      billingCapabilitiesJson: '{}',
    })
    .where(eq(modules.schema.catalogModelPrice.id, IDs.price));
  await assertConsumers(false);
});
