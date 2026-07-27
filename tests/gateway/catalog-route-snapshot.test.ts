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
  profile: 'snapshot-profile',
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
    newapiGroup: 'legacy-wrong-group',
  });
  await modules.db().insert(schema.catalogModel).values({
    id: IDs.model,
    modelId: IDs.modelId,
    displayName: '快照测试模型',
    vendorId: IDs.vendor,
    category: 'llm',
  });
  await modules.db().insert(schema.catalogModelCapability).values({
    id: 'snapshot-model-capability',
    modelId: IDs.model,
    capabilityId: IDs.capability,
  });
  await modules
    .db()
    .insert(schema.catalogModelPricingProfile)
    .values({
      id: IDs.profile,
      modelId: IDs.model,
      name: '快照售卖价',
      pricingBasis: 'token',
      reviewedAt: new Date('2026-07-20T00:00:00Z'),
    });
  await modules
    .db()
    .insert(schema.catalogModelPricingRate)
    .values([
      {
        id: 'snapshot-rate-input',
        profileId: IDs.profile,
        meterKey: 'input',
        skuKey: 'default',
        unitSize: 1_000_000,
        priceMicroUsd: 1_000_000,
      },
      {
        id: 'snapshot-rate-output',
        profileId: IDs.profile,
        meterKey: 'output',
        skuKey: 'default',
        unitSize: 1_000_000,
        priceMicroUsd: 2_000_000,
      },
    ]);
  await modules.db().insert(schema.catalogModelListing).values({
    id: IDs.listing,
    modelId: IDs.model,
    groupId: IDs.group,
    newapiGroup: 'official',
    pricingProfileId: IDs.profile,
    statusId: IDs.status,
    inputMicroUsd: 1_000_000,
    outputMicroUsd: 2_000_000,
    discountRateBps: 9_000,
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
    .delete(modules.schema.catalogModelPricingRate)
    .where(
      eq(modules.schema.catalogModelPricingRate.id, 'snapshot-rate-output')
    );
  await assertConsumers(false);

  await modules.db().insert(modules.schema.catalogModelPricingRate).values({
    id: 'snapshot-rate-output-restored',
    profileId: IDs.profile,
    meterKey: 'output',
    skuKey: 'default',
    unitSize: 1_000_000,
    priceMicroUsd: 2_000_000,
  });
  await modules
    .db()
    .update(modules.schema.catalogModelPricingProfile)
    .set({ pricingBasis: 'duration', quantityMeter: 'audio_duration_ms' })
    .where(eq(modules.schema.catalogModelPricingProfile.id, IDs.profile));
  await assertConsumers(false);
});
