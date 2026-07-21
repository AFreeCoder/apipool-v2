import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { createClient } from '@libsql/client';
import { eq } from 'drizzle-orm';

let modules: any;
let client: ReturnType<typeof createClient>;

const IDs = {
  vendor: 'publish-vendor',
  category: 'publish-category',
  status: 'publish-status',
  group: 'publish-group',
  model: 'publish-model-pk',
  modelId: 'publish-model',
  listing: 'publish-listing',
  price: 'publish-price',
};

const fullCapabilities = JSON.stringify({
  cached_input: true,
  cache_write: true,
  cache_ttl_split: false,
  long_context: true,
  web_search: true,
});

async function setupDb() {
  const dbPath = join(process.cwd(), '.tmp', 'publish-readiness.db');
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
  modules = { db, publishReadiness, schema };

  await modules.db().insert(schema.catalogVendor).values({
    id: IDs.vendor,
    slug: IDs.vendor,
    name: '发布测试厂商',
  });
  await modules.db().insert(schema.catalogCategory).values({
    id: IDs.category,
    slug: IDs.category,
    name: '发布测试分类',
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
    name: '发布测试分组',
    newapiGroup: 'official',
    pricingSyncStatus: 'missing_remote_group',
  });
  await modules.db().insert(schema.catalogModel).values({
    id: IDs.model,
    modelId: IDs.modelId,
    displayName: '发布测试模型',
    vendorId: IDs.vendor,
    category: IDs.category,
  });
  await modules.db().insert(schema.catalogModelListing).values({
    id: IDs.listing,
    modelId: IDs.model,
    groupId: IDs.group,
    statusId: IDs.status,
    inputMicroUsd: 1_000_001,
    outputMicroUsd: 5_000_000,
    discountRateBps: 5_000,
    priceDriftStatus: 'drifted',
  });
  await modules.db().insert(schema.catalogModelPrice).values({
    id: IDs.price,
    modelId: IDs.model,
  });
}

async function resetReadyTokenPrice() {
  const { catalogModelListing, catalogModelPrice, catalogModelPriceTier } =
    modules.schema;
  await modules.db().delete(catalogModelPriceTier);
  await modules
    .db()
    .update(catalogModelListing)
    .set({ allowLongContext: false, discountRateBps: 5_000 })
    .where(eq(catalogModelListing.id, IDs.listing));
  await modules
    .db()
    .update(catalogModelPrice)
    .set({
      billingScheme: 'token',
      sourceSupportedEndpointTypes: JSON.stringify(['responses']),
      baseInputMicroUsd: 1_000_001,
      baseCachedInputMicroUsd: 100_000,
      baseCacheWriteMicroUsd: 1_250_000,
      baseCacheWrite5mMicroUsd: null,
      baseCacheWrite1hMicroUsd: null,
      baseOutputMicroUsd: 5_000_000,
      baseImageInputMicroUsd: null,
      baseCachedImageInputMicroUsd: null,
      baseImageOutputMicroUsd: null,
      baseWebSearchMicroUsd: 10,
      longContextThresholdTokens: 272_000,
      baseInputLongMicroUsd: 2_000_000,
      baseCachedInputLongMicroUsd: 200_000,
      baseCacheWriteLongMicroUsd: 2_500_000,
      baseOutputLongMicroUsd: 10_000_000,
      billingCapabilitiesJson: fullCapabilities,
      syncStatus: 'manual',
      reviewedAt: new Date('2026-07-20T00:00:00Z'),
    })
    .where(eq(catalogModelPrice.id, IDs.price));
}

test.before(setupDb);
test.beforeEach(resetReadyTokenPrice);
test.after(() => client.close());

test('满配 token 模型可发布，旧漂移与分组同步状态不再构成硬门', async () => {
  const result = await modules.publishReadiness.assessPublishReadiness(
    IDs.group,
    IDs.modelId
  );

  assert.equal(result.ready, true);
  assert.deepEqual(JSON.parse(result.snapshot.ratesJson), {
    input: 500001,
    cached_input: 50000,
    cache_write: 625000,
    output: 2500000,
    web_search: 5,
  });
  assert.equal(result.snapshot.longContextThresholdTokens, null);
  assert.equal(result.snapshot.admissionLongContextThreshold, 272_000);
  assert.equal(result.snapshot.allowLongContext, false);
});

test('长上下文开关只控制计费快照，检测字段始终保留目录阈值', async () => {
  await modules
    .db()
    .update(modules.schema.catalogModelListing)
    .set({ allowLongContext: true })
    .where(eq(modules.schema.catalogModelListing.id, IDs.listing));

  const result = await modules.publishReadiness.assessPublishReadiness(
    IDs.group,
    IDs.modelId
  );

  assert.equal(result.ready, true);
  assert.deepEqual(JSON.parse(result.snapshot.ratesJson), {
    input: 500001,
    cached_input: 50000,
    cache_write: 625000,
    output: 2500000,
    web_search: 5,
    input_long: 1000000,
    cached_input_long: 100000,
    cache_write_long: 1250000,
    output_long: 5000000,
  });
  assert.equal(result.snapshot.longContextThresholdTokens, 272_000);
  assert.equal(result.snapshot.admissionLongContextThreshold, 272_000);
  assert.equal(result.snapshot.allowLongContext, true);
});

test('声明计价项缺价与非法能力声明都会拒绝发布并列出原因', async () => {
  await modules
    .db()
    .update(modules.schema.catalogModelPrice)
    .set({ baseCacheWriteMicroUsd: null })
    .where(eq(modules.schema.catalogModelPrice.id, IDs.price));
  const missing = await modules.publishReadiness.assessPublishReadiness(
    IDs.group,
    IDs.modelId
  );
  assert.equal(missing.ready, false);
  assert.ok(missing.reasons.includes('缺少计价项：cache_write'));

  await modules
    .db()
    .update(modules.schema.catalogModelPrice)
    .set({ billingCapabilitiesJson: '{broken' })
    .where(eq(modules.schema.catalogModelPrice.id, IDs.price));
  const invalid = await modules.publishReadiness.assessPublishReadiness(
    IDs.group,
    IDs.modelId
  );
  assert.equal(invalid.ready, false);
  assert.ok(invalid.reasons.includes('计费能力声明不是合法 JSON 对象'));
});

test('per_call 必须有 default 档，档位价格按上架折扣半入折算', async () => {
  await modules
    .db()
    .update(modules.schema.catalogModelPrice)
    .set({
      billingScheme: 'per_call',
      billingCapabilitiesJson: '{}',
      sourceSupportedEndpointTypes: JSON.stringify(['images']),
    })
    .where(eq(modules.schema.catalogModelPrice.id, IDs.price));

  const missing = await modules.publishReadiness.assessPublishReadiness(
    IDs.group,
    IDs.modelId
  );
  assert.equal(missing.ready, false);
  assert.ok(missing.reasons.includes('缺少按次默认档：default'));

  await modules.db().insert(modules.schema.catalogModelPriceTier).values({
    id: 'publish-default-tier',
    modelId: IDs.model,
    skuKey: 'default',
    priceMicroUsd: 3,
  });
  const ready = await modules.publishReadiness.assessPublishReadiness(
    IDs.group,
    IDs.modelId
  );
  assert.equal(ready.ready, true);
  assert.equal(ready.snapshot.billingScheme, 'per_call');
  assert.deepEqual(JSON.parse(ready.snapshot.ratesJson), {});
  assert.deepEqual(JSON.parse(ready.snapshot.tiersJson), { default: 2 });
});

test('同步状态只表示成本参照新鲜度，只有人工复核时间构成发布门禁', async () => {
  await modules
    .db()
    .update(modules.schema.catalogModelPrice)
    .set({ syncStatus: 'synced', reviewedAt: new Date() })
    .where(eq(modules.schema.catalogModelPrice.id, IDs.price));
  const result = await modules.publishReadiness.assessPublishReadiness(
    IDs.group,
    IDs.modelId
  );
  assert.equal(result.ready, true);

  await modules
    .db()
    .update(modules.schema.catalogModelPrice)
    .set({ syncStatus: 'reference_missing', reviewedAt: null })
    .where(eq(modules.schema.catalogModelPrice.id, IDs.price));
  const unreviewed = await modules.publishReadiness.assessPublishReadiness(
    IDs.group,
    IDs.modelId
  );
  assert.equal(unreviewed.ready, false);
  assert.ok(unreviewed.reasons.includes('基础价尚未人工锁定并复核'));
});

test('token 基础必需集按端点区分文本、嵌入与图片', async () => {
  const { catalogModelPrice } = modules.schema;
  await modules
    .db()
    .update(catalogModelPrice)
    .set({
      sourceSupportedEndpointTypes: JSON.stringify(['embeddings']),
      billingCapabilitiesJson: '{}',
      baseOutputMicroUsd: null,
      longContextThresholdTokens: null,
      baseInputLongMicroUsd: null,
      baseCachedInputLongMicroUsd: null,
      baseCacheWriteLongMicroUsd: null,
      baseOutputLongMicroUsd: null,
    })
    .where(eq(catalogModelPrice.id, IDs.price));
  const embedding = await modules.publishReadiness.assessPublishReadiness(
    IDs.group,
    IDs.modelId
  );
  assert.equal(embedding.ready, true);
  assert.deepEqual(JSON.parse(embedding.snapshot.ratesJson), {
    input: 500001,
  });

  await modules
    .db()
    .update(catalogModelPrice)
    .set({
      sourceSupportedEndpointTypes: JSON.stringify(['images']),
      baseImageInputMicroUsd: 400_000,
      baseImageOutputMicroUsd: 800_000,
    })
    .where(eq(catalogModelPrice.id, IDs.price));
  const image = await modules.publishReadiness.assessPublishReadiness(
    IDs.group,
    IDs.modelId
  );
  assert.equal(image.ready, true);
  assert.deepEqual(JSON.parse(image.snapshot.ratesJson), {
    input: 500001,
    image_input: 200000,
    image_output: 400000,
  });
});
