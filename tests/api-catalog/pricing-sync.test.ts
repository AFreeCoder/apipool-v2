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

test('syncCatalogPricingFromSnapshot updates prices, group ratio, listing drift, and sync report', async () => {
  const {
    catalogGroup,
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
  assert.equal(price.source, 'newapi_pricing');
  assert.equal(price.baseInputMicroUsd, 150000);
  assert.equal(price.baseOutputMicroUsd, 600000);
  assert.equal(price.sourceFingerprint, 'fingerprint-123');
  assert.equal(price.syncStatus, 'synced');
  assert.equal(price.driftStatus, 'matched');

  const [group] = await modules
    .db()
    .select()
    .from(catalogGroup)
    .where(eq(catalogGroup.slug, 'official'))
    .limit(1);
  assert.equal(group.newapiGroupRatioDecimal, '0.5');
  assert.equal(group.newapiGroupRatioBps, 5000);
  assert.equal(group.pricingSyncStatus, 'synced');

  const [listing] = await modules
    .db()
    .select()
    .from(catalogModelListing)
    .where(eq(catalogModelListing.modelId, model.id))
    .limit(1);
  assert.equal(listing.priceDriftStatus, 'matched');
  assert.match(listing.effectivePriceFormula, /newapi_group_ratio/);

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

test('syncCatalogPricingFromSnapshot does not confirm prices when snapshot omits current group ratio', async () => {
  const {
    catalogGroup,
    catalogModel,
    catalogModelListing,
    catalogModelPrice,
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
    .update(catalogGroup)
    .set({
      newapiGroupRatioDecimal: '0.5',
      newapiGroupRatioBps: 5000,
      pricingSyncStatus: 'synced',
    })
    .where(eq(catalogGroup.id, official.id));
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
      pricePolicy: 'inherit_group',
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
  assert.equal(report.conflicts[0]?.type, 'missing_group_ratio');

  const [listing] = await modules
    .db()
    .select()
    .from(catalogModelListing)
    .where(eq(catalogModelListing.modelId, model.id))
    .limit(1);
  assert.equal(listing.priceDriftStatus, 'missing_group');
  assert.equal(listing.effectivePriceFormula, null);
  assert.equal(listing.effectivePriceSyncedAt, null);

  const publicListings = await modules.queries.getPublicListingsUncached({
    group: 'official',
    status: 'available',
  });
  const publicListing = publicListings.find(
    (item: { modelId: string }) => item.modelId === 'gpt-4o-mini'
  );

  assert.ok(publicListing);
  assert.equal(publicListing.effectiveInputMicroUsd, undefined);
  assert.equal(publicListing.effectiveOutputMicroUsd, undefined);
  assert.equal(publicListing.pricePresentation.showPrice, false);
});

test('syncCatalogPricingFromSnapshot keeps non-inherit policies out of matched without live evidence', async () => {
  const { catalogModel, catalogModelListing } = modules.schema;
  const [model] = await modules
    .db()
    .select()
    .from(catalogModel)
    .where(eq(catalogModel.modelId, 'gpt-4o-mini'))
    .limit(1);
  const cases = [
    {
      policy: 'listing_multiplier',
      overrideStatus: 'none',
      expectedStatus: 'needs_live_check',
      expectedType: 'listing_multiplier_needs_live_check',
    },
    {
      policy: 'price_override',
      overrideStatus: 'pending',
      expectedStatus: 'drifted',
      expectedType: 'price_override_unverified',
    },
    {
      policy: 'price_override',
      overrideStatus: 'verified',
      expectedStatus: 'needs_live_check',
      expectedType: 'price_override_needs_live_check',
    },
    {
      policy: 'legacy_override',
      overrideStatus: 'none',
      expectedStatus: 'needs_live_check',
      expectedType: 'legacy_override_needs_live_check',
    },
    {
      policy: 'fixed_price_review',
      overrideStatus: 'none',
      expectedStatus: 'needs_live_check',
      expectedType: 'fixed_price_review_needs_live_check',
    },
  ];

  for (const item of cases) {
    await modules
      .db()
      .update(catalogModelListing)
      .set({
        pricePolicy: item.policy,
        overrideStatus: item.overrideStatus,
        effectivePriceFormula: '{"source":"stale"}',
      })
      .where(eq(catalogModelListing.modelId, model.id));

    const report = await modules.pricingSync.syncCatalogPricingFromSnapshot({
      operatorUserId: `operator-${item.policy}`,
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
        sourceFingerprint: `fingerprint-${item.policy}`,
      },
    });

    const [listing] = await modules
      .db()
      .select()
      .from(catalogModelListing)
      .where(eq(catalogModelListing.modelId, model.id))
      .limit(1);
    assert.equal(listing.priceDriftStatus, item.expectedStatus);
    assert.equal(listing.effectivePriceFormula, null);
    assert.equal(
      report.conflicts.some(
        (conflict: Record<string, unknown>) =>
          conflict.type === item.expectedType &&
          conflict.pricePolicy === item.policy
      ),
      true
    );
  }
});

test('backfillCatalogModelPrices prefers official list price, official effective, consistent listing price, then smoke callable fallback', async () => {
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
        smokeTested: true,
        sortOrder: 20,
      },
      {
        groupId: partner.id,
        statusId: available.id,
        inputMicroUsd: 300,
        outputMicroUsd: 600,
        smokeTested: true,
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
        smokeTested: false,
        sortOrder: 20,
      },
      {
        groupId: partner.id,
        statusId: available.id,
        inputMicroUsd: 333,
        outputMicroUsd: 444,
        smokeTested: true,
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
        smokeTested: false,
        sortOrder: 20,
      },
      {
        groupId: customB.id,
        statusId: available.id,
        inputMicroUsd: 77,
        outputMicroUsd: 88,
        smokeTested: true,
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
        smokeTested: false,
        sortOrder: 1,
      },
      {
        groupId: customB.id,
        statusId: available.id,
        inputMicroUsd: 30,
        outputMicroUsd: 40,
        smokeTested: true,
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
  assert.equal((await modelPrice(fallbackModel.id)).baseInputMicroUsd, 30);

  const conflictedListings = await modules
    .db()
    .select()
    .from(catalogModelListing)
    .where(eq(catalogModelListing.modelId, officialListModel.id));
  assert.equal(
    conflictedListings.every(
      (listing: any) =>
        listing.pricePolicy === 'legacy_override' &&
        listing.priceDriftStatus === 'needs_live_check'
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
  const prices = await modules.db().select().from(modules.schema.catalogModelPrice);

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
