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

async function findBySlug(table: any, slugColumn: any, slug: string) {
  const [row] = await modules
    .db()
    .select()
    .from(table)
    .where(eq(slugColumn, slug))
    .limit(1);

  return row;
}

async function createGroup(slug: string) {
  const { catalogGroup } = modules.schema;
  const group = {
    id: testId(`group-${slug}`),
    slug,
    name: `Group ${slug}`,
    newapiGroup: slug,
    allowCreateKey: true,
    sortOrder: 50,
    status: 'active',
  };
  await modules.db().insert(catalogGroup).values(group);
  return group;
}

async function createBackfillFixtureModel(input: {
  modelId: string;
  listings: Array<{
    groupId: string;
    statusId: string;
    inputMicroUsd: number;
    outputMicroUsd: number;
    listInputMicroUsd?: number | null;
    listOutputMicroUsd?: number | null;
    smokeTested?: boolean;
    sortOrder: number;
  }>;
}) {
  const { catalogModel, catalogVendor, catalogModelListing } = modules.schema;
  const openai = await findBySlug(catalogVendor, catalogVendor.slug, 'openai');
  const model = {
    id: testId(`model-${input.modelId}`),
    modelId: input.modelId,
    displayName: input.modelId,
    vendorId: openai.id,
    category: 'llm',
    contextWindow: 128000,
  };
  await modules.db().insert(catalogModel).values(model);
  for (const [index, listing] of input.listings.entries()) {
    await modules
      .db()
      .insert(catalogModelListing)
      .values({
        id: testId(`listing-${input.modelId}-${index}`),
        modelId: model.id,
        groupId: listing.groupId,
        statusId: listing.statusId,
        inputMicroUsd: listing.inputMicroUsd,
        outputMicroUsd: listing.outputMicroUsd,
        listInputMicroUsd: listing.listInputMicroUsd ?? null,
        listOutputMicroUsd: listing.listOutputMicroUsd ?? null,
        smokeTested: listing.smokeTested ?? false,
        featured: false,
        sortOrder: listing.sortOrder,
      });
  }
  return model;
}

test('成本同步只更新 New API 参照，不改门户卖价，并建立 ok 基线', async () => {
  const {
    catalogModel,
    catalogModelListing,
    catalogModelPrice,
    catalogPriceSyncRun,
  } = modules.schema;

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

  const [model] = await modules
    .db()
    .select()
    .from(catalogModel)
    .where(eq(catalogModel.modelId, 'gpt-4o-mini'))
    .limit(1);
  const [price] = await modules
    .db()
    .select()
    .from(catalogModelPrice)
    .where(eq(catalogModelPrice.modelId, model.id))
    .limit(1);
  assert.equal(price.source, 'migration');
  assert.equal(price.baseInputMicroUsd, 150000);
  assert.equal(price.baseCachedInputMicroUsd, null);
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
  assert.equal(listing.priceDriftStatus, 'ok');
  assert.match(listing.effectivePriceFormula, /catalog_base_price/);

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
  assert.equal(listing.priceDriftStatus, 'cost_changed');
  assert.match(listing.effectivePriceFormula, /catalog_base_price/);
  assert.ok(listing.effectivePriceSyncedAt);

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

test('固定价参照不覆盖门户 token 配置，仅作为不可比提示', async () => {
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
  assert.equal(report.conflicts[0]?.type, 'sale_snapshot_missing');

  const [price] = await modules
    .db()
    .select()
    .from(catalogModelPrice)
    .where(eq(catalogModelPrice.modelId, model.id))
    .limit(1);
  assert.equal(price.pricingMode, 'manual_token');
  assert.equal(price.fixedPriceMicroUsd, null);
  assert.equal(price.driftStatus, 'ok');

  const [listing] = await modules
    .db()
    .select()
    .from(catalogModelListing)
    .where(eq(catalogModelListing.modelId, model.id))
    .limit(1);
  assert.equal(listing.priceDriftStatus, 'ok');
  assert.match(listing.effectivePriceFormula, /catalog_base_price/);

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
  assert.equal(listing.priceDriftStatus, 'cost_changed');
});

test('成本守卫逐 meter 检出参照变动与售价倒挂，且绝不改门户价格', async () => {
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
  assert.equal(alert.status, 'partial');
  assert.equal(alert.driftCount, 1);
  assert.equal(alert.conflicts[0]?.type, 'cost_alert');
  assert.deepEqual(alert.conflicts[0]?.meters, ['input']);

  const [price] = await modules
    .db()
    .select()
    .from(catalogModelPrice)
    .where(eq(catalogModelPrice.modelId, model.id));
  assert.equal(price.baseInputMicroUsd, 9_000_000);
  assert.equal(price.baseOutputMicroUsd, 12_000_000);
  assert.equal(price.driftStatus, 'cost_alert');
  assert.equal(price.syncStatus, 'reference_current');
  const [listing] = await modules
    .db()
    .select()
    .from(catalogModelListing)
    .where(eq(catalogModelListing.modelId, model.id));
  assert.equal(listing.priceDriftStatus, 'cost_alert');
});

test('per_call 成本守卫只比较 default 档，并保留门户 tier 配置', async () => {
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
  assert.equal(report.conflicts[0]?.type, 'cost_alert');
  assert.deepEqual(report.conflicts[0]?.meters, ['default']);
  const [price] = await modules
    .db()
    .select()
    .from(catalogModelPrice)
    .where(eq(catalogModelPrice.modelId, model.id));
  assert.equal(price.fixedPriceMicroUsd, 777);
  assert.equal(price.driftStatus, 'cost_alert');
  const [listing] = await modules
    .db()
    .select()
    .from(catalogModelListing)
    .where(eq(catalogModelListing.modelId, model.id));
  assert.equal(listing.newapiGroup, 'official');
});

test('backfillCatalogModelPrices prefers official list price, official effective, consistent listing price, then callable fallback', async () => {
  const {
    catalogGroup,
    catalogModelListing,
    catalogModelPrice,
    catalogStatus,
  } = modules.schema;
  const official = await findBySlug(
    catalogGroup,
    catalogGroup.slug,
    'official'
  );
  const available = await findBySlug(
    catalogStatus,
    catalogStatus.slug,
    'available'
  );
  const partner = await createGroup(testId('partner-backfill'));
  const customA = await createGroup(testId('custom-a'));
  const customB = await createGroup(testId('custom-b'));

  const officialListModel = await createBackfillFixtureModel({
    modelId: testId('official-list'),
    listings: [
      {
        groupId: official.id,
        statusId: available.id,
        inputMicroUsd: 500,
        outputMicroUsd: 1000,
        listInputMicroUsd: 1000,
        listOutputMicroUsd: 2000,
        sortOrder: 20,
      },
      {
        groupId: partner.id,
        statusId: available.id,
        inputMicroUsd: 300,
        outputMicroUsd: 600,
        sortOrder: 1,
      },
    ],
  });
  const officialEffectiveModel = await createBackfillFixtureModel({
    modelId: testId('official-effective'),
    listings: [
      {
        groupId: official.id,
        statusId: available.id,
        inputMicroUsd: 111,
        outputMicroUsd: 222,
        sortOrder: 20,
      },
      {
        groupId: partner.id,
        statusId: available.id,
        inputMicroUsd: 333,
        outputMicroUsd: 444,
        sortOrder: 1,
      },
    ],
  });
  const consistentModel = await createBackfillFixtureModel({
    modelId: testId('consistent'),
    listings: [
      {
        groupId: customA.id,
        statusId: available.id,
        inputMicroUsd: 77,
        outputMicroUsd: 88,
        sortOrder: 20,
      },
      {
        groupId: customB.id,
        statusId: available.id,
        inputMicroUsd: 77,
        outputMicroUsd: 88,
        sortOrder: 1,
      },
    ],
  });
  const fallbackModel = await createBackfillFixtureModel({
    modelId: testId('fallback'),
    listings: [
      {
        groupId: customA.id,
        statusId: available.id,
        inputMicroUsd: 10,
        outputMicroUsd: 20,
        sortOrder: 1,
      },
      {
        groupId: customB.id,
        statusId: available.id,
        inputMicroUsd: 30,
        outputMicroUsd: 40,
        sortOrder: 30,
      },
    ],
  });

  const report = await modules.pricingSync.backfillCatalogModelPrices({
    mode: 'apply',
    operatorUserId: 'operator-backfill-order',
  });

  async function modelPrice(modelId: string) {
    const [price] = await modules
      .db()
      .select()
      .from(catalogModelPrice)
      .where(eq(catalogModelPrice.modelId, modelId))
      .limit(1);
    return price;
  }

  assert.equal(
    (await modelPrice(officialListModel.id)).baseInputMicroUsd,
    1000
  );
  assert.equal(
    (await modelPrice(officialListModel.id)).baseOutputMicroUsd,
    2000
  );
  assert.equal(
    (await modelPrice(officialEffectiveModel.id)).baseInputMicroUsd,
    111
  );
  assert.equal((await modelPrice(consistentModel.id)).baseInputMicroUsd, 77);
  assert.equal((await modelPrice(fallbackModel.id)).baseInputMicroUsd, 10);

  const conflictedListings = await modules
    .db()
    .select()
    .from(catalogModelListing)
    .where(eq(catalogModelListing.modelId, officialListModel.id));
  assert.equal(
    conflictedListings.every(
      (listing: any) => listing.priceDriftStatus === 'needs_live_check'
    ),
    true
  );
  assert.equal(
    report.conflicts.some(
      (conflict: Record<string, unknown>) =>
        conflict.modelId === officialListModel.modelId
    ),
    true
  );
});

test('backfillCatalogModelPrices reports conflicts without changing listing cache', async () => {
  const { catalogModelListing } = modules.schema;
  const before = await modules.db().select().from(catalogModelListing);

  await modules.db().delete(modules.schema.catalogModelPrice);
  const report = await modules.pricingSync.backfillCatalogModelPrices({
    mode: 'apply',
    operatorUserId: 'operator-2',
  });
  const after = await modules.db().select().from(catalogModelListing);
  const prices = await modules
    .db()
    .select()
    .from(modules.schema.catalogModelPrice);

  assert.ok(report.created >= 1);
  assert.equal(prices.length >= 1, true);
  assert.deepEqual(
    after.map((listing: any) => ({
      id: listing.id,
      inputMicroUsd: listing.inputMicroUsd,
      outputMicroUsd: listing.outputMicroUsd,
      imageInputMicroUsd: listing.imageInputMicroUsd,
      imageOutputMicroUsd: listing.imageOutputMicroUsd,
    })),
    before.map((listing: any) => ({
      id: listing.id,
      inputMicroUsd: listing.inputMicroUsd,
      outputMicroUsd: listing.outputMicroUsd,
      imageInputMicroUsd: listing.imageInputMicroUsd,
      imageOutputMicroUsd: listing.imageOutputMicroUsd,
    }))
  );
});
