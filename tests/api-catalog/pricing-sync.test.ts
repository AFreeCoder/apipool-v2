import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { createClient } from '@libsql/client';
import { eq } from 'drizzle-orm';

function testId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

let modules: any;

async function setupDb() {
  const dbPath = join(process.cwd(), '.tmp', 'pricing-sync.db');
  await mkdir(join(process.cwd(), '.tmp'), { recursive: true });
  await rm(dbPath, { force: true });

  process.env.DATABASE_PROVIDER = 'sqlite';
  process.env.DATABASE_URL = `file:${dbPath}`;
  process.env.DB_SCHEMA_FILE = './src/config/db/schema.sqlite.ts';
  process.env.DB_SINGLETON_ENABLED = 'false';

  const client = createClient({ url: `file:${dbPath}` });
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
  const { initCatalog } = await import('../../scripts/init-catalog');
  const queries = await import('@/features/api-catalog/server/queries');
  const pricingSync = await import(
    '@/features/api-catalog/server/pricing-sync'
  );

  modules = {
    db,
    initCatalog,
    pricingSync,
    queries,
    schema,
  };

  await modules.initCatalog();
  // 本文件只验证 gpt-4o-mini 的成本同步；gpt-image-2 的生产种子
  // 由 init-catalog 专项测试覆盖，避免未放入模拟快照的模型制造无关 partial。
  await modules
    .db()
    .delete(modules.schema.catalogModel)
    .where(eq(modules.schema.catalogModel.modelId, 'gpt-image-2'));
  await modules
    .db()
    .update(modules.schema.catalogModelListing)
    .set({ newapiGroup: 'official' });
  await modules
    .db()
    .update(modules.schema.catalogGroup)
    .set({ newapiGroup: 'legacy-wrong-group' });
}

test.before(setupDb);

test('成本同步只更新 New API 参照，不改门户卖价，并建立 ok 基线', async () => {
  const {
    catalogModel,
    catalogModelListing,
    catalogModelPrice,
    catalogPriceSyncRun,
  } = modules.schema;
  const [model] = await modules
    .db()
    .select()
    .from(catalogModel)
    .where(eq(catalogModel.modelId, 'gpt-4o-mini'))
    .limit(1);
  await modules
    .db()
    .delete(catalogModelPrice)
    .where(eq(catalogModelPrice.modelId, model.id));

  const report = await modules.pricingSync.syncCatalogPricingFromSnapshot({
    operatorUserId: 'operator-1',
    snapshot: {
      models: [
        {
          modelId: 'gpt-4o-mini',
          displayName: 'GPT-4o mini',
          vendorId: 'openai',
          vendorName: 'OpenAI',
          quotaType: 0,
          modelRatio: 0.075,
          modelPrice: null,
          completionRatio: 4,
          cacheRatio: 0.1,
          createCacheRatio: null,
          imageRatio: null,
          source: 'ratio',
          inputMicroUsd: 150000,
          outputMicroUsd: 600000,
          imageInputMicroUsd: null,
          imageOutputMicroUsd: null,
          enabledGroups: ['official'],
          supportedEndpointTypes: ['responses'],
        },
      ],
      vendors: { openai: 'OpenAI' },
      groupRatios: {
        official: {
          raw: '0.5',
          decimal: '0.5',
          bps: 5000,
          sourceKey: 'group_ratio',
        },
      },
      usableGroups: ['official'],
      sourceFingerprint: 'fingerprint-123',
    },
  });

  assert.equal(report.status, 'success');
  assert.equal(report.matchedModelCount, 1);
  assert.equal(report.remoteModelCount, 1);
  assert.equal(report.fixedPriceCount, 0);

  const [price] = await modules
    .db()
    .select()
    .from(catalogModelPrice)
    .where(eq(catalogModelPrice.modelId, model.id))
    .limit(1);
  assert.equal(price.source, 'newapi');
  assert.equal(price.baseInputMicroUsd, 150000);
  assert.equal(price.baseCachedInputMicroUsd, 15_000);
  assert.equal(price.baseCacheWrite5mMicroUsd, null);
  assert.equal(price.baseCacheWrite1hMicroUsd, null);
  assert.equal(price.baseOutputMicroUsd, 600000);
  assert.equal(price.sourceFingerprint, 'fingerprint-123');
  assert.equal(price.sourceModelRatio, '0.075');
  assert.equal(price.syncStatus, 'reference_current');
  assert.equal(price.driftStatus, 'ok');

  const [listing] = await modules
    .db()
    .select()
    .from(catalogModelListing)
    .where(eq(catalogModelListing.modelId, model.id))
    .limit(1);
  assert.equal(listing.newapiGroup, 'official');
  assert.equal(listing.priceDriftStatus, 'unknown');
  assert.equal(listing.effectivePriceFormula, null);

  const [run] = await modules
    .db()
    .select()
    .from(catalogPriceSyncRun)
    .where(eq(catalogPriceSyncRun.id, report.syncRunId))
    .limit(1);
  assert.equal(run.status, 'success');
  assert.equal(run.sourceFingerprint, 'fingerprint-123');
  assert.match(run.reportJson, /official/);

  const drift = await modules.pricingSync.buildCatalogPriceDriftReport();
  assert.equal(drift.latestRun.id, report.syncRunId);
  assert.deepEqual(drift.report.groupRatios.official, {
    raw: '0.5',
    decimal: '0.5',
    bps: 5000,
    sourceKey: 'group_ratio',
  });
});

test('成本参照缺少当前分组倍率时告警，但不清空门户售价展示', async () => {
  const { catalogModel, catalogModelListing, catalogModelPrice } =
    modules.schema;
  const [model] = await modules
    .db()
    .select()
    .from(catalogModel)
    .where(eq(catalogModel.modelId, 'gpt-4o-mini'))
    .limit(1);
  await modules
    .db()
    .update(catalogModelPrice)
    .set({
      baseInputMicroUsd: 150000,
      baseOutputMicroUsd: 600000,
      syncStatus: 'synced',
      driftStatus: 'matched',
    })
    .where(eq(catalogModelPrice.modelId, model.id));
  await modules
    .db()
    .update(catalogModelListing)
    .set({
      discountRateBps: 10_000,
      priceDriftStatus: 'matched',
      effectivePriceFormula: '{"source":"stale"}',
    })
    .where(eq(catalogModelListing.modelId, model.id));

  const report = await modules.pricingSync.syncCatalogPricingFromSnapshot({
    operatorUserId: 'operator-missing-ratio',
    snapshot: {
      models: [
        {
          modelId: 'gpt-4o-mini',
          displayName: 'GPT-4o mini',
          vendorId: 'openai',
          vendorName: 'OpenAI',
          quotaType: 0,
          modelRatio: 0.075,
          modelPrice: null,
          completionRatio: 4,
          imageRatio: null,
          source: 'ratio',
          inputMicroUsd: 150000,
          outputMicroUsd: 600000,
          imageInputMicroUsd: null,
          imageOutputMicroUsd: null,
          enabledGroups: ['official'],
          supportedEndpointTypes: ['responses'],
        },
      ],
      vendors: { openai: 'OpenAI' },
      groupRatios: {},
      usableGroups: ['official'],
      sourceFingerprint: 'fingerprint-missing-ratio',
    },
  });

  assert.equal(report.status, 'partial');
  assert.equal(report.conflicts[0]?.type, 'cost_reference_missing_group_ratio');

  const [listing] = await modules
    .db()
    .select()
    .from(catalogModelListing)
    .where(eq(catalogModelListing.modelId, model.id))
    .limit(1);
  assert.equal(listing.priceDriftStatus, 'matched');
  assert.equal(listing.effectivePriceFormula, '{"source":"stale"}');
  assert.equal(listing.effectivePriceSyncedAt, null);

  const publicListings = await modules.queries.getPublicListingsUncached({
    group: 'official',
    status: 'available',
  });
  const publicListing = publicListings.find(
    (item: { modelId: string }) => item.modelId === 'gpt-4o-mini'
  );

  assert.ok(publicListing);
  assert.equal(publicListing.effectiveInputMicroUsd, 150000);
  assert.equal(publicListing.effectiveOutputMicroUsd, 600000);
  assert.equal(publicListing.pricePresentation.showPrice, true);
});

test('固定价成本参照与门户 token 售卖配置可独立共存', async () => {
  const { catalogModel, catalogModelListing, catalogModelPrice } =
    modules.schema;
  const [model] = await modules
    .db()
    .select()
    .from(catalogModel)
    .where(eq(catalogModel.modelId, 'gpt-4o-mini'))
    .limit(1);

  await modules
    .db()
    .update(catalogModelListing)
    .set({
      priceDriftStatus: 'matched',
      effectivePriceFormula: '{"source":"stale"}',
    })
    .where(eq(catalogModelListing.modelId, model.id));

  const report = await modules.pricingSync.syncCatalogPricingFromSnapshot({
    operatorUserId: 'operator-fixed-price',
    snapshot: {
      models: [
        {
          modelId: 'gpt-4o-mini',
          displayName: 'GPT-4o mini',
          vendorId: 'openai',
          vendorName: 'OpenAI',
          quotaType: 1,
          modelRatio: 0,
          modelPrice: 0.01,
          completionRatio: 1,
          imageRatio: null,
          source: 'fixed-price',
          inputMicroUsd: null,
          outputMicroUsd: null,
          imageInputMicroUsd: null,
          imageOutputMicroUsd: null,
          enabledGroups: ['official'],
          supportedEndpointTypes: ['responses'],
        },
      ],
      vendors: { openai: 'OpenAI' },
      groupRatios: {
        official: {
          raw: '0.5',
          decimal: '0.5',
          bps: 5000,
          sourceKey: 'group_ratio',
        },
      },
      usableGroups: ['official'],
      sourceFingerprint: 'fingerprint-fixed-price',
    },
  });

  assert.equal(report.status, 'success');
  assert.equal(report.fixedPriceCount, 1);
  assert.deepEqual(report.conflicts, []);

  const [price] = await modules
    .db()
    .select()
    .from(catalogModelPrice)
    .where(eq(catalogModelPrice.modelId, model.id))
    .limit(1);
  assert.equal(price.pricingMode, 'cost_fixed');
  assert.equal(price.billingScheme, 'per_call');
  assert.equal(price.fixedPriceMicroUsd, 10_000);
  assert.equal(price.baseInputMicroUsd, null);
  assert.equal(price.driftStatus, 'ok');

  const [listing] = await modules
    .db()
    .select()
    .from(catalogModelListing)
    .where(eq(catalogModelListing.modelId, model.id))
    .limit(1);
  assert.equal(listing.priceDriftStatus, 'matched');
  assert.equal(listing.effectivePriceFormula, '{"source":"stale"}');

  const publicListings = await modules.queries.getPublicListingsUncached({
    group: 'official',
    status: 'available',
  });
  const publicListing = publicListings.find(
    (item: { modelId: string }) => item.modelId === 'gpt-4o-mini'
  );

  assert.ok(publicListing);
  assert.equal(publicListing.inputMicroUsd, 150000);
  assert.equal(publicListing.effectiveInputMicroUsd, 150000);
  assert.equal(publicListing.pricePresentation.showPrice, true);
});

test('syncCatalogPricingFromSnapshot preserves the listing discount as the sole sale-price factor', async () => {
  const { catalogModel, catalogModelListing } = modules.schema;
  const [model] = await modules
    .db()
    .select()
    .from(catalogModel)
    .where(eq(catalogModel.modelId, 'gpt-4o-mini'))
    .limit(1);
  await modules
    .db()
    .update(catalogModelListing)
    .set({ discountRateBps: 6500 })
    .where(eq(catalogModelListing.modelId, model.id));

  await modules.pricingSync.syncCatalogPricingFromSnapshot({
    operatorUserId: 'operator-listing-discount',
    snapshot: {
      models: [
        {
          modelId: 'gpt-4o-mini',
          displayName: 'GPT-4o mini',
          vendorId: 'openai',
          vendorName: 'OpenAI',
          quotaType: 0,
          modelRatio: 0.075,
          modelPrice: null,
          completionRatio: 4,
          imageRatio: null,
          source: 'ratio',
          inputMicroUsd: 150000,
          outputMicroUsd: 600000,
          imageInputMicroUsd: null,
          imageOutputMicroUsd: null,
          enabledGroups: ['official'],
          supportedEndpointTypes: ['responses'],
        },
      ],
      vendors: { openai: 'OpenAI' },
      groupRatios: {
        official: {
          raw: '0.5',
          decimal: '0.5',
          bps: 5000,
          sourceKey: 'group_ratio',
        },
      },
      usableGroups: ['official'],
      sourceFingerprint: 'fingerprint-listing-discount',
    },
  });

  const [listing] = await modules
    .db()
    .select()
    .from(catalogModelListing)
    .where(eq(catalogModelListing.modelId, model.id))
    .limit(1);
  assert.equal(listing.discountRateBps, 6500);
  assert.equal(listing.priceDriftStatus, 'matched');
});

test('成本参照只与上一版成本比较，售卖快照变化不会触发成本告警', async () => {
  const {
    catalogGroup,
    catalogModel,
    catalogModelListing,
    catalogModelPrice,
    modelPriceVersion,
  } = modules.schema;
  const [model] = await modules
    .db()
    .select()
    .from(catalogModel)
    .where(eq(catalogModel.modelId, 'gpt-4o-mini'))
    .limit(1);
  const [official] = await modules
    .db()
    .select()
    .from(catalogGroup)
    .where(eq(catalogGroup.slug, 'official'))
    .limit(1);

  await modules
    .db()
    .update(catalogModelPrice)
    .set({ baseInputMicroUsd: 9_000_000, baseOutputMicroUsd: 12_000_000 })
    .where(eq(catalogModelPrice.modelId, model.id));
  const saleId = testId('active-sale');
  await modules
    .db()
    .insert(modelPriceVersion)
    .values({
      id: saleId,
      portalGroupId: official.id,
      portalModelId: model.modelId,
      version: 1,
      status: 'active',
      billingScheme: 'token',
      ratesJson: JSON.stringify({ input: 1_000_000, output: 1_000_000 }),
      tiersJson: '{}',
      publishedBy: 'test:cost-guard',
    });

  const snapshot = (modelRatio: number, fingerprint: string) => ({
    models: [
      {
        modelId: model.modelId,
        displayName: 'GPT-4o mini',
        vendorId: 'openai',
        vendorName: 'OpenAI',
        quotaType: 0,
        modelRatio,
        modelPrice: null,
        completionRatio: 4,
        cacheRatio: 0.1,
        createCacheRatio: null,
        imageRatio: null,
        source: 'ratio' as const,
        inputMicroUsd: modelRatio * 2_000_000,
        outputMicroUsd: modelRatio * 8_000_000,
        imageInputMicroUsd: null,
        imageOutputMicroUsd: null,
        enabledGroups: ['official'],
        supportedEndpointTypes: ['responses'],
      },
    ],
    vendors: { openai: 'OpenAI' },
    groupRatios: {
      official: {
        raw: '0.5',
        decimal: '0.5',
        bps: 5000,
        sourceKey: 'group_ratio',
      },
    },
    usableGroups: ['official'],
    sourceFingerprint: fingerprint,
  });

  await modules.pricingSync.syncCatalogPricingFromSnapshot({
    snapshot: snapshot(0.075, 'cost-baseline'),
  });
  const baseline = await modules.pricingSync.syncCatalogPricingFromSnapshot({
    snapshot: snapshot(0.075, 'cost-baseline-repeat'),
  });
  assert.equal(baseline.status, 'success');
  assert.equal(baseline.driftCount, 0);

  const changed = await modules.pricingSync.syncCatalogPricingFromSnapshot({
    snapshot: snapshot(0.08, 'cost-changed'),
  });
  assert.equal(changed.status, 'partial');
  assert.equal(changed.driftCount, 1);
  assert.equal(changed.conflicts[0]?.type, 'cost_changed');

  await modules
    .db()
    .update(modelPriceVersion)
    .set({
      ratesJson: JSON.stringify({ input: 79_999, output: 1_000_000 }),
    })
    .where(eq(modelPriceVersion.id, saleId));
  const alert = await modules.pricingSync.syncCatalogPricingFromSnapshot({
    snapshot: snapshot(0.08, 'cost-alert'),
  });
  assert.equal(alert.status, 'success');
  assert.equal(alert.driftCount, 0);
  assert.deepEqual(alert.conflicts, []);

  const [price] = await modules
    .db()
    .select()
    .from(catalogModelPrice)
    .where(eq(catalogModelPrice.modelId, model.id));
  assert.equal(price.baseInputMicroUsd, 160_000);
  assert.equal(price.baseOutputMicroUsd, 640_000);
  assert.equal(price.driftStatus, 'ok');
  assert.equal(price.syncStatus, 'reference_current');
  const [listing] = await modules
    .db()
    .select()
    .from(catalogModelListing)
    .where(eq(catalogModelListing.modelId, model.id));
  assert.equal(listing.priceDriftStatus, 'matched');
  const [sale] = await modules
    .db()
    .select()
    .from(modelPriceVersion)
    .where(eq(modelPriceVersion.id, saleId));
  assert.equal(JSON.parse(sale.ratesJson).input, 79_999);
});

test('per_call 成本参照按自身版本检测变化，并保留门户 tier 配置', async () => {
  const {
    catalogModel,
    catalogModelListing,
    catalogModelPrice,
    modelPriceVersion,
  } = modules.schema;
  const [model] = await modules
    .db()
    .select()
    .from(catalogModel)
    .where(eq(catalogModel.modelId, 'gpt-4o-mini'));
  await modules
    .db()
    .update(modelPriceVersion)
    .set({
      billingScheme: 'per_call',
      ratesJson: '{}',
      tiersJson: JSON.stringify({ default: 10_000, premium: 50_000 }),
    })
    .where(eq(modelPriceVersion.status, 'active'));
  await modules
    .db()
    .update(catalogModelPrice)
    .set({ billingScheme: 'per_call', fixedPriceMicroUsd: 777 })
    .where(eq(catalogModelPrice.modelId, model.id));

  const report = await modules.pricingSync.syncCatalogPricingFromSnapshot({
    snapshot: {
      models: [
        {
          modelId: model.modelId,
          displayName: model.displayName,
          vendorId: 'openai',
          vendorName: 'OpenAI',
          quotaType: 1,
          modelRatio: 0,
          modelPrice: 0.03,
          completionRatio: 1,
          imageRatio: null,
          source: 'fixed-price',
          inputMicroUsd: null,
          outputMicroUsd: null,
          imageInputMicroUsd: null,
          imageOutputMicroUsd: null,
          enabledGroups: ['official'],
          supportedEndpointTypes: ['images'],
        },
      ],
      vendors: { openai: 'OpenAI' },
      groupRatios: {
        official: {
          raw: '0.5',
          decimal: '0.5',
          bps: 5000,
          sourceKey: 'group_ratio',
        },
      },
      usableGroups: ['official'],
      sourceFingerprint: 'per-call-cost-alert',
    },
  });

  assert.equal(report.status, 'partial');
  assert.equal(report.conflicts[0]?.type, 'cost_changed');
  const [price] = await modules
    .db()
    .select()
    .from(catalogModelPrice)
    .where(eq(catalogModelPrice.modelId, model.id));
  assert.equal(price.fixedPriceMicroUsd, 30_000);
  assert.equal(price.driftStatus, 'cost_changed');
  const [listing] = await modules
    .db()
    .select()
    .from(catalogModelListing)
    .where(eq(catalogModelListing.modelId, model.id));
  assert.equal(listing.newapiGroup, 'official');
  assert.equal(listing.priceDriftStatus, 'matched');
  const [sale] = await modules
    .db()
    .select()
    .from(modelPriceVersion)
    .where(eq(modelPriceVersion.status, 'active'));
  assert.deepEqual(JSON.parse(sale.tiersJson), {
    default: 10_000,
    premium: 50_000,
  });
});
