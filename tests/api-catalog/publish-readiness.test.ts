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
  status: 'publish-status',
  group: 'publish-group',
  model: 'publish-model-pk',
  modelId: 'publish-model',
  listing: 'publish-listing',
  profile: 'publish-profile',
  cost: 'publish-cost-reference',
};

const TOKEN_RATES = {
  input: 1_000_001,
  cached_input: 100_000,
  cache_write: 1_250_000,
  output: 5_000_000,
  web_search: 10,
  input_long: 2_000_000,
  cached_input_long: 200_000,
  cache_write_long: 2_500_000,
  output_long: 10_000_000,
};

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
    newapiGroup: 'legacy-wrong-group',
    pricingSyncStatus: 'missing_remote_group',
  });
  await modules.db().insert(schema.catalogModel).values({
    id: IDs.model,
    modelId: IDs.modelId,
    displayName: '发布测试模型',
    vendorId: IDs.vendor,
    category: 'llm',
  });
  await modules
    .db()
    .insert(schema.catalogModelPricingProfile)
    .values({
      id: IDs.profile,
      modelId: IDs.model,
      name: '默认售卖价',
      pricingBasis: 'token',
      longContextThresholdTokens: 272_000,
      reviewedAt: new Date('2026-07-20T00:00:00Z'),
    });
  await modules.db().insert(schema.catalogModelListing).values({
    id: IDs.listing,
    modelId: IDs.model,
    groupId: IDs.group,
    newapiGroup: 'official',
    pricingProfileId: IDs.profile,
    statusId: IDs.status,
    inputMicroUsd: 0,
    outputMicroUsd: 0,
    discountRateBps: 5_000,
    priceDriftStatus: 'drifted',
  });
  await modules.db().insert(schema.catalogModelPrice).values({
    id: IDs.cost,
    modelId: IDs.model,
    syncStatus: 'manual',
  });
}

async function replaceRates(rates: Record<string, number>, meter = 'token') {
  await modules.db().delete(modules.schema.catalogModelPricingRate);
  await modules
    .db()
    .insert(modules.schema.catalogModelPricingRate)
    .values(
      Object.entries(rates).map(([key, priceMicroUsd]) => ({
        id: `publish-rate-${key}`,
        profileId: IDs.profile,
        meterKey: meter === 'token' ? key : meter,
        skuKey: meter === 'token' ? 'default' : key,
        unitSize:
          meter === 'token' ? (key === 'web_search' ? 1 : 1_000_000) : 1,
        priceMicroUsd,
      }))
    );
}

async function resetReadyTokenProfile() {
  await modules
    .db()
    .update(modules.schema.catalogModel)
    .set({ category: 'llm' })
    .where(eq(modules.schema.catalogModel.id, IDs.model));
  await modules
    .db()
    .update(modules.schema.catalogModelListing)
    .set({
      newapiGroup: 'official',
      pricingProfileId: IDs.profile,
      allowLongContext: false,
      discountRateBps: 5_000,
    })
    .where(eq(modules.schema.catalogModelListing.id, IDs.listing));
  await modules
    .db()
    .update(modules.schema.catalogModelPricingProfile)
    .set({
      pricingBasis: 'token',
      quantityMeter: null,
      skuRuleSource: null,
      skuRuleAstJson: null,
      compilerVersion: null,
      ruleHash: null,
      longContextThresholdTokens: 272_000,
      reviewedAt: new Date('2026-07-20T00:00:00Z'),
    })
    .where(eq(modules.schema.catalogModelPricingProfile.id, IDs.profile));
  await replaceRates(TOKEN_RATES);
}

async function readiness() {
  return modules.publishReadiness.assessPublishReadiness(
    IDs.group,
    IDs.modelId
  );
}

test.before(setupDb);
test.beforeEach(resetReadyTokenProfile);
test.after(() => client.close());

test('满配 token 档案可发布，旧漂移与成本同步状态不构成硬门', async () => {
  const result = await readiness();
  assert.equal(result.ready, true);
  assert.equal(result.snapshot.newapiGroup, 'official');
  assert.equal(result.snapshot.pricingBasis, 'token');
  assert.equal(result.snapshot.pricingProfileId, IDs.profile);
  assert.deepEqual(JSON.parse(result.snapshot.ratesJson), {
    cached_input: 50000,
    cached_input_long: 100000,
    cache_write: 625000,
    cache_write_long: 1250000,
    input: 500001,
    input_long: 1000000,
    output: 2500000,
    output_long: 5000000,
    web_search: 5,
  });
  assert.equal(result.snapshot.longContextThresholdTokens, null);
  assert.equal(result.snapshot.admissionLongContextThreshold, 272_000);
});

test('模型售卖项未配置 New API 分组时明确拒绝发布', async () => {
  await modules
    .db()
    .update(modules.schema.catalogModelListing)
    .set({ newapiGroup: '' })
    .where(eq(modules.schema.catalogModelListing.id, IDs.listing));
  const result = await readiness();
  assert.equal(result.ready, false);
  assert.ok(result.reasons.includes('缺少 New API 分组映射'));
});

test('长上下文开关只控制开放状态，档案阈值进入准入快照', async () => {
  await modules
    .db()
    .update(modules.schema.catalogModelListing)
    .set({ allowLongContext: true })
    .where(eq(modules.schema.catalogModelListing.id, IDs.listing));
  const result = await readiness();
  assert.equal(result.ready, true);
  assert.equal(result.snapshot.longContextThresholdTokens, 272_000);
  assert.equal(result.snapshot.admissionLongContextThreshold, 272_000);
  assert.equal(result.snapshot.allowLongContext, true);
});

test('缺少分类必需费率与不支持的计费方式都会拒绝发布', async () => {
  const withoutOutput = Object.fromEntries(
    Object.entries(TOKEN_RATES).filter(([meterKey]) => meterKey !== 'output')
  );
  await replaceRates(withoutOutput);
  const missing = await readiness();
  assert.equal(missing.ready, false);
  assert.ok(missing.reasons.includes('缺少计价项：output'));

  await resetReadyTokenProfile();
  await modules
    .db()
    .update(modules.schema.catalogModelPricingProfile)
    .set({ pricingBasis: 'duration', quantityMeter: 'audio_duration_ms' })
    .where(eq(modules.schema.catalogModelPricingProfile.id, IDs.profile));
  const invalid = await readiness();
  assert.equal(invalid.ready, false);
  assert.ok(
    invalid.reasons.some((reason: string) => /不支持 duration/.test(reason))
  );
});

test('图片 unit 档案必须有 default SKU，折后价格写入不可变规格', async () => {
  await modules
    .db()
    .update(modules.schema.catalogModel)
    .set({ category: 'image' })
    .where(eq(modules.schema.catalogModel.id, IDs.model));
  await modules
    .db()
    .update(modules.schema.catalogModelPricingProfile)
    .set({
      pricingBasis: 'unit',
      quantityMeter: 'output_count',
      skuRuleSource: 'else => "default"',
      skuRuleAstJson: JSON.stringify({
        version: 1,
        rules: [],
        fallback: { type: 'sku', template: 'default' },
      }),
      compilerVersion: 1,
    })
    .where(eq(modules.schema.catalogModelPricingProfile.id, IDs.profile));
  await replaceRates({ premium: 3 }, 'output_count');
  const missing = await readiness();
  assert.equal(missing.ready, false);
  assert.ok(
    missing.reasons.some((reason: string) =>
      /必须包含 default SKU/.test(reason)
    )
  );

  await replaceRates({ default: 3 }, 'output_count');
  const ready = await readiness();
  assert.equal(ready.ready, true);
  assert.equal(ready.snapshot.pricingBasis, 'unit');
  assert.deepEqual(JSON.parse(ready.snapshot.tiersJson), { default: 2 });
  assert.equal(
    JSON.parse(ready.snapshot.pricingSpecJson).quantityMeter,
    'output_count'
  );
});

test('图片 unit 零价虽可落库，但不能通过发布规格校验', async () => {
  await modules
    .db()
    .update(modules.schema.catalogModel)
    .set({ category: 'image' })
    .where(eq(modules.schema.catalogModel.id, IDs.model));
  await modules
    .db()
    .update(modules.schema.catalogModelPricingProfile)
    .set({
      pricingBasis: 'unit',
      quantityMeter: 'output_count',
      skuRuleAstJson: JSON.stringify({
        version: 1,
        rules: [],
        fallback: { type: 'sku', template: 'default' },
      }),
    })
    .where(eq(modules.schema.catalogModelPricingProfile.id, IDs.profile));
  await replaceRates({ default: 0 }, 'output_count');
  const result = await readiness();
  assert.equal(result.ready, false);
  assert.ok(
    result.reasons.some((reason: string) => /价格必须大于 0/.test(reason))
  );
});

test('只有售卖定价档案的人工确认构成发布门禁，成本状态完全独立', async () => {
  await modules
    .db()
    .update(modules.schema.catalogModelPrice)
    .set({ syncStatus: 'reference_missing', reviewedAt: null })
    .where(eq(modules.schema.catalogModelPrice.id, IDs.cost));
  assert.equal((await readiness()).ready, true);

  await modules
    .db()
    .update(modules.schema.catalogModelPricingProfile)
    .set({ reviewedAt: null })
    .where(eq(modules.schema.catalogModelPricingProfile.id, IDs.profile));
  const unreviewed = await readiness();
  assert.equal(unreviewed.ready, false);
  assert.ok(unreviewed.reasons.includes('定价档案尚未人工确认'));
});

test('token 基础必需集由模型分类决定：embedding 与 image 各自校验', async () => {
  await modules
    .db()
    .update(modules.schema.catalogModel)
    .set({ category: 'embedding' })
    .where(eq(modules.schema.catalogModel.id, IDs.model));
  await replaceRates({ input: 1_000_001 });
  const embedding = await readiness();
  assert.equal(embedding.ready, true);
  assert.deepEqual(JSON.parse(embedding.snapshot.ratesJson), { input: 500001 });

  await modules
    .db()
    .update(modules.schema.catalogModel)
    .set({ category: 'image' })
    .where(eq(modules.schema.catalogModel.id, IDs.model));
  await replaceRates({
    input: 1_000_001,
    image_input: 400_000,
    image_output: 800_000,
  });
  const image = await readiness();
  assert.equal(image.ready, true);
  assert.deepEqual(JSON.parse(image.snapshot.ratesJson), {
    image_input: 200000,
    image_output: 400000,
    input: 500001,
  });
});
