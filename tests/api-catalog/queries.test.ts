import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { createClient } from '@libsql/client';
import { eq } from 'drizzle-orm';

let modules: any;

async function setupDb() {
  const dbPath = join(process.cwd(), '.tmp', 'queries.db');
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
  const service = await import('@/features/api-catalog/server/catalog-service');
  const queries = await import('@/features/api-catalog/server/queries');

  modules = {
    db,
    initCatalog,
    queries,
    schema,
    service,
  };

  await modules.initCatalog();
  await seedQueryFixtures();
}

async function findBySlug(table: any, slugColumn: any, slug: string) {
  const [row] = await modules
    .db()
    .select()
    .from(table)
    .where(eq(slugColumn, slug))
    .limit(1);

  return row;
}

async function createFixtureModel(input: {
  modelId: string;
  displayName: string;
  vendorId: string;
  groupId: string;
  statusId: string;
  capabilityIds: string[];
  category?: string;
  sortOrder: number;
}) {
  const model = await modules.service.createModel({
    modelId: input.modelId,
    displayName: input.displayName,
    vendorId: input.vendorId,
    category: input.category ?? 'llm',
    contextWindow: 128000,
  });

  await modules.service.setModelCapabilities(model.id, input.capabilityIds);
  await modules.service.createListing({
    modelId: model.id,
    groupId: input.groupId,
    statusId: input.statusId,
    inputMicroUsd: 100000 + input.sortOrder,
    outputMicroUsd: 200000 + input.sortOrder,
    smokeTested: true,
    featured: false,
    sortOrder: input.sortOrder,
  });

  return model;
}

async function seedQueryFixtures() {
  const {
    catalogCapability,
    catalogGroup,
    catalogModel,
    catalogStatus,
    catalogVendor,
  } = modules.schema;

  const openai = await findBySlug(catalogVendor, catalogVendor.slug, 'openai');
  const anthropic = await findBySlug(
    catalogVendor,
    catalogVendor.slug,
    'anthropic'
  );
  const text = await findBySlug(
    catalogCapability,
    catalogCapability.slug,
    'text'
  );
  const vision = await findBySlug(
    catalogCapability,
    catalogCapability.slug,
    'vision'
  );
  const available = await findBySlug(
    catalogStatus,
    catalogStatus.slug,
    'available'
  );
  const comingSoon = await findBySlug(
    catalogStatus,
    catalogStatus.slug,
    'coming_soon'
  );
  const retired = await findBySlug(
    catalogStatus,
    catalogStatus.slug,
    'retired'
  );
  const official = await findBySlug(
    catalogGroup,
    catalogGroup.slug,
    'official'
  );
  const [seededModel] = await modules
    .db()
    .select()
    .from(catalogModel)
    .where(eq(catalogModel.modelId, 'gpt-4o-mini'))
    .limit(1);

  const partnerGroup = await modules.service.createGroup({
    slug: 'partner',
    name: 'Partner',
    userDescription: 'Partner route for selected accounts.',
    newapiGroup: 'newapi-partner-secret',
    allowCreateKey: true,
    sortOrder: 15,
    status: 'active',
  });
  const disabledRoute = await modules.service.createGroup({
    slug: 'disabled-route',
    name: 'Disabled Route',
    userDescription: 'Disabled route.',
    newapiGroup: 'newapi-disabled-secret',
    allowCreateKey: true,
    sortOrder: 90,
    status: 'disabled',
  });
  await modules.service.createGroup({
    slug: 'read-only-route',
    name: 'Read Only Route',
    userDescription: 'Visible only to admins.',
    newapiGroup: 'newapi-readonly-secret',
    allowCreateKey: false,
    sortOrder: 91,
    status: 'active',
  });
  await modules.service.createGroup({
    slug: 'empty-key-group',
    name: 'Empty Key Group',
    userDescription: 'Group with no configured models.',
    newapiGroup: 'newapi-empty-secret',
    allowCreateKey: true,
    sortOrder: 16,
    status: 'active',
  });
  const hiddenVendor = await modules.service.createVendor({
    slug: 'hidden-vendor',
    name: 'Hidden Vendor',
    sortOrder: 99,
    status: 'disabled',
  });
  const hiddenCapability = await modules.service.createCapability({
    slug: 'hidden-capability',
    name: 'Hidden Capability',
    sortOrder: 99,
    status: 'disabled',
  });
  const crossHiddenVendor = await modules.service.createVendor({
    slug: 'cross-hidden-vendor',
    name: 'Cross Hidden Vendor',
    sortOrder: 98,
    status: 'active',
  });
  const crossHiddenGroup = await modules.service.createGroup({
    slug: 'cross-hidden-group',
    name: 'Cross Hidden Group',
    userDescription: 'Active group hidden by another disabled dimension.',
    newapiGroup: 'newapi-cross-hidden-secret',
    allowCreateKey: true,
    sortOrder: 98,
    status: 'active',
  });
  const crossHiddenCategory = await modules.service.createCategory({
    slug: 'cross-hidden-category',
    name: 'Cross Hidden Category',
    sortOrder: 98,
    status: 'active',
  });
  const crossHiddenCapability = await modules.service.createCapability({
    slug: 'cross-hidden-capability',
    name: 'Cross Hidden Capability',
    sortOrder: 98,
    status: 'active',
  });
  const crossHiddenStatus = await modules.service.createStatus({
    slug: 'cross_hidden_status',
    name: 'Cross Hidden Status',
    isCallable: true,
    isPublicVisible: true,
    sortOrder: 98,
    status: 'active',
  });
  const capabilityOnlyVendor = await modules.service.createVendor({
    slug: 'capability-only-vendor',
    name: 'Capability Only Vendor',
    sortOrder: 97,
    status: 'active',
  });
  const capabilityOnlyGroup = await modules.service.createGroup({
    slug: 'capability-only-group',
    name: 'Capability Only Group',
    userDescription: 'Active group hidden by disabled capability only.',
    newapiGroup: 'newapi-capability-only-secret',
    allowCreateKey: true,
    sortOrder: 97,
    status: 'active',
  });
  const capabilityOnlyCategory = await modules.service.createCategory({
    slug: 'capability-only-category',
    name: 'Capability Only Category',
    sortOrder: 97,
    status: 'active',
  });
  const capabilityOnlyStatus = await modules.service.createStatus({
    slug: 'capability_only_status',
    name: 'Capability Only Status',
    isCallable: true,
    isPublicVisible: true,
    sortOrder: 97,
    status: 'active',
  });
  await modules.service.createCategory({
    slug: 'hidden-category',
    name: 'Hidden Category',
    sortOrder: 99,
    status: 'disabled',
  });
  await modules.service.createStatus({
    slug: 'disabled-status',
    name: 'Disabled Status',
    isCallable: false,
    isPublicVisible: false,
    sortOrder: 99,
    status: 'disabled',
  });

  await modules.service.createListing({
    modelId: seededModel.id,
    groupId: partnerGroup.id,
    statusId: available.id,
    inputMicroUsd: 90000,
    outputMicroUsd: 180000,
    listInputMicroUsd: 120000,
    listOutputMicroUsd: 240000,
    discountNote: 'Partner price',
    description: 'Partner listing',
    smokeTested: true,
    featured: false,
    sortOrder: 14,
  });

  await createFixtureModel({
    modelId: 'claude-query-test',
    displayName: 'Claude Query Test',
    vendorId: anthropic.id,
    groupId: official.id,
    statusId: available.id,
    capabilityIds: [text.id],
    sortOrder: 12,
  });
  await createFixtureModel({
    modelId: 'query-coming-soon',
    displayName: 'Query Coming Soon',
    vendorId: openai.id,
    groupId: official.id,
    statusId: comingSoon.id,
    capabilityIds: [text.id],
    sortOrder: 20,
  });
  await createFixtureModel({
    modelId: 'query-retired',
    displayName: 'Query Retired',
    vendorId: openai.id,
    groupId: official.id,
    statusId: retired.id,
    capabilityIds: [vision.id],
    sortOrder: 30,
  });
  await createFixtureModel({
    modelId: 'query-image-category',
    displayName: 'Query Image Category',
    vendorId: openai.id,
    groupId: official.id,
    statusId: available.id,
    capabilityIds: [vision.id],
    category: 'image',
    sortOrder: 40,
  });
  await createFixtureModel({
    modelId: 'query-disabled-group',
    displayName: 'Query Disabled Group',
    vendorId: openai.id,
    groupId: disabledRoute.id,
    statusId: available.id,
    capabilityIds: [text.id],
    sortOrder: 50,
  });
  await createFixtureModel({
    modelId: 'query-hidden-vendor',
    displayName: 'Query Hidden Vendor',
    vendorId: hiddenVendor.id,
    groupId: official.id,
    statusId: available.id,
    capabilityIds: [text.id],
    sortOrder: 51,
  });
  await createFixtureModel({
    modelId: 'query-hidden-category',
    displayName: 'Query Hidden Category',
    vendorId: openai.id,
    groupId: official.id,
    statusId: available.id,
    capabilityIds: [text.id],
    category: 'hidden-category',
    sortOrder: 52,
  });
  await createFixtureModel({
    modelId: 'query-hidden-capability',
    displayName: 'Query Hidden Capability',
    vendorId: openai.id,
    groupId: official.id,
    statusId: available.id,
    capabilityIds: [hiddenCapability.id],
    sortOrder: 53,
  });
  await createFixtureModel({
    modelId: 'query-cross-vendor-disabled-group',
    displayName: 'Query Cross Vendor Disabled Group',
    vendorId: crossHiddenVendor.id,
    groupId: disabledRoute.id,
    statusId: available.id,
    capabilityIds: [text.id],
    sortOrder: 60,
  });
  await createFixtureModel({
    modelId: 'query-cross-group-hidden-vendor',
    displayName: 'Query Cross Group Hidden Vendor',
    vendorId: hiddenVendor.id,
    groupId: crossHiddenGroup.id,
    statusId: available.id,
    capabilityIds: [text.id],
    sortOrder: 61,
  });
  await createFixtureModel({
    modelId: 'query-cross-category-disabled-group',
    displayName: 'Query Cross Category Disabled Group',
    vendorId: openai.id,
    groupId: disabledRoute.id,
    statusId: available.id,
    capabilityIds: [text.id],
    category: crossHiddenCategory.slug,
    sortOrder: 62,
  });
  await createFixtureModel({
    modelId: 'query-cross-capability-disabled-group',
    displayName: 'Query Cross Capability Disabled Group',
    vendorId: openai.id,
    groupId: disabledRoute.id,
    statusId: available.id,
    capabilityIds: [crossHiddenCapability.id],
    sortOrder: 63,
  });
  await createFixtureModel({
    modelId: 'query-cross-status-disabled-group',
    displayName: 'Query Cross Status Disabled Group',
    vendorId: openai.id,
    groupId: disabledRoute.id,
    statusId: crossHiddenStatus.id,
    capabilityIds: [text.id],
    sortOrder: 64,
  });
  await createFixtureModel({
    modelId: 'query-capability-only-hidden',
    displayName: 'Query Capability Only Hidden',
    vendorId: capabilityOnlyVendor.id,
    groupId: capabilityOnlyGroup.id,
    statusId: capabilityOnlyStatus.id,
    capabilityIds: [hiddenCapability.id],
    category: capabilityOnlyCategory.slug,
    sortOrder: 65,
  });
}

test.before(setupDb);

function assertNoDuplicateRows(
  rows: { modelId: string; groupSlug?: string }[],
  buildKey: (row: { modelId: string; groupSlug?: string }) => string
) {
  const keys = rows.map(buildKey);
  assert.deepEqual(keys, [...new Set(keys)]);
}

test('getPublicListings returns only listings whose catalog status is public visible by default', async () => {
  const listings = await modules.queries.getPublicListingsUncached({});
  const modelIds = listings.map(
    (listing: { modelId: string }) => listing.modelId
  );

  assert.ok(modelIds.includes('gpt-4o-mini'));
  assert.ok(modelIds.includes('query-coming-soon'));
  assert.equal(modelIds.includes('query-retired'), false);
  assert.ok(
    listings.every((listing: { statusSlug: string }) =>
      ['available', 'coming_soon'].includes(listing.statusSlug)
    )
  );
});

test('getPublicListings applies vendor, group, capability, and status filters', async () => {
  const officialListings = await modules.queries.getPublicListingsUncached({
    group: 'official',
  });
  assert.ok(officialListings.length > 0);
  assert.ok(
    officialListings.every(
      (listing: { groupSlug: string }) => listing.groupSlug === 'official'
    )
  );

  const availableListings = await modules.queries.getPublicListingsUncached({
    status: 'available',
  });
  assert.ok(availableListings.length > 0);
  assert.ok(
    availableListings.every(
      (listing: { statusSlug: string }) => listing.statusSlug === 'available'
    )
  );

  const openaiListings = await modules.queries.getPublicListingsUncached({
    vendor: 'openai',
  });
  assert.ok(openaiListings.length > 0);
  assert.equal(
    openaiListings.some(
      (listing: { modelId: string }) => listing.modelId === 'claude-query-test'
    ),
    false
  );

  const visionListings = await modules.queries.getPublicListingsUncached({
    capability: 'vision',
  });
  assert.ok(visionListings.length > 0);
  assert.ok(
    visionListings.every((listing: { capabilities: string[] }) =>
      listing.capabilities.includes('vision')
    )
  );

  const combined = await modules.queries.getPublicListingsUncached({
    vendor: 'anthropic',
    group: 'official',
    capability: 'text',
    status: 'available',
  });
  assert.deepEqual(
    combined.map((listing: { modelId: string }) => listing.modelId),
    ['claude-query-test']
  );

  const categoryListings = await modules.queries.getPublicListingsUncached({
    category: 'llm',
  });
  assert.ok(categoryListings.length > 0);
  assert.equal(
    categoryListings.some(
      (listing: { modelId: string }) =>
        listing.modelId === 'query-image-category'
    ),
    false
  );
  assert.ok(
    categoryListings.every(
      (listing: { category: string }) => listing.category === 'llm'
    )
  );

  const imageListings = await modules.queries.getPublicListingsUncached({
    category: 'image',
  });
  assert.deepEqual(
    imageListings.map((listing: { modelId: string }) => listing.modelId),
    ['query-image-category']
  );
});

test('getPublicListings excludes listings attached to disabled catalog dimensions', async () => {
  const listings = await modules.queries.getPublicListingsUncached({});
  const modelIds = listings.map(
    (listing: { modelId: string }) => listing.modelId
  );

  assert.equal(modelIds.includes('query-disabled-group'), false);
  assert.equal(modelIds.includes('query-hidden-vendor'), false);
  assert.equal(modelIds.includes('query-hidden-category'), false);

  assert.deepEqual(
    await modules.queries.getPublicListingsUncached({
      group: 'disabled-route',
    }),
    []
  );
  assert.deepEqual(
    await modules.queries.getPublicListingsUncached({
      vendor: 'hidden-vendor',
    }),
    []
  );
  assert.deepEqual(
    await modules.queries.getPublicListingsUncached({
      category: 'hidden-category',
    }),
    []
  );
  assert.deepEqual(
    await modules.queries.getPublicListingsUncached({
      capability: 'hidden-capability',
    }),
    []
  );
});

test('getPublicListings aggregates capabilities for each model without exposing internal columns', async () => {
  const listings = await modules.queries.getPublicListingsUncached({
    group: 'official',
    status: 'available',
  });
  assertNoDuplicateRows(
    listings,
    (listing) => `${listing.modelId}:${listing.groupSlug}`
  );
  const seeded = listings.find(
    (listing: { modelId: string }) => listing.modelId === 'gpt-4o-mini'
  );

  assert.ok(seeded);
  assert.equal(seeded.category, 'llm');
  assert.deepEqual(new Set(seeded.capabilities), new Set(['text', 'vision']));
  assert.equal('id' in seeded, false);
  assert.equal('newapiGroup' in seeded, false);
  assert.equal('sourceFingerprint' in seeded, false);
  assert.equal('priceDriftStatus' in seeded, false);
  assert.equal('overrideStatus' in seeded, false);
});

test('public listings do not expose confirmed discounts before New API group match', async () => {
  const listings = await modules.queries.getPublicListingsUncached({
    group: 'partner',
  });
  const partner = listings.find(
    (listing: { modelId: string }) => listing.modelId === 'gpt-4o-mini'
  );

  assert.ok(partner);
  assert.equal(partner.inputMicroUsd, 90000);
  assert.equal(partner.outputMicroUsd, 180000);
  assert.equal(partner.listInputMicroUsd, undefined);
  assert.equal(partner.listOutputMicroUsd, undefined);
  assert.equal(partner.discountNote, undefined);
  assert.equal(partner.effectiveInputMicroUsd, undefined);
  assert.equal(partner.pricePresentation.showPrice, false);
});

test('public listings expose effective price only after matched New API group ratio', async () => {
  const {
    catalogGroup,
    catalogModel,
    catalogModelListing,
    catalogModelPrice,
  } = modules.schema;
  const official = await findBySlug(
    catalogGroup,
    catalogGroup.slug,
    'official'
  );
  const [model] = await modules
    .db()
    .select()
    .from(catalogModel)
    .where(eq(catalogModel.modelId, 'gpt-4o-mini'))
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
      listInputMicroUsd: 150000,
      listOutputMicroUsd: 600000,
      discountNote: 'Official ratio',
      pricePolicy: 'inherit_group',
      priceDriftStatus: 'matched',
    })
    .where(eq(catalogModelListing.modelId, model.id));

  const listings = await modules.queries.getPublicListingsUncached({
    group: 'official',
    status: 'available',
  });
  const seeded = listings.find(
    (listing: { modelId: string }) => listing.modelId === 'gpt-4o-mini'
  );

  assert.ok(seeded);
  assert.equal(seeded.effectiveInputMicroUsd, 75000);
  assert.equal(seeded.effectiveOutputMicroUsd, 300000);
  assert.equal(seeded.listInputMicroUsd, 150000);
  assert.equal(seeded.listOutputMicroUsd, 600000);
  assert.equal(seeded.discountNote, 'Official ratio');
  assert.deepEqual(seeded.pricePresentation, {
    showPrice: true,
    showStrikethrough: true,
    discountLabel: '5 折 (50%)',
    note: 'Official ratio',
  });
});

test('getFilterDimensions returns all active admin-configured dimensions in sort order', async () => {
  const dimensions = await modules.queries.getFilterDimensionsUncached();

  assert.deepEqual(
    dimensions.vendors.map((vendor: { slug: string }) => vendor.slug),
    [
      'openai',
      'anthropic',
      'google',
      'capability-only-vendor',
      'cross-hidden-vendor',
    ]
  );
  assert.deepEqual(
    dimensions.groups.map((group: { slug: string }) => group.slug),
    [
      'official',
      'partner',
      'empty-key-group',
      'read-only-route',
      'capability-only-group',
      'cross-hidden-group',
    ]
  );
  assert.deepEqual(
    dimensions.categories.map((category: { slug: string }) => category.slug),
    [
      'llm',
      'embedding',
      'image',
      'audio',
      'capability-only-category',
      'cross-hidden-category',
    ]
  );
  assert.deepEqual(
    dimensions.capabilities.map(
      (capability: { slug: string }) => capability.slug
    ),
    ['text', 'vision', 'video', 'audio', 'cross-hidden-capability']
  );
  assert.deepEqual(
    dimensions.statuses.map((status: { slug: string }) => status.slug),
    [
      'available',
      'coming_soon',
      'retired',
      'capability_only_status',
      'cross_hidden_status',
    ]
  );
});

test('getGroupsForKeyCreation returns active key-capable groups regardless of listings and no internal fields', async () => {
  const groups = await modules.queries.getGroupsForKeyCreationUncached();
  const slugs = groups.map((group: { slug: string }) => group.slug);

  assert.deepEqual(slugs, [
    'official',
    'partner',
    'empty-key-group',
    'capability-only-group',
    'cross-hidden-group',
  ]);
  assert.equal(slugs.includes('disabled-route'), false);
  assert.equal(slugs.includes('read-only-route'), false);

  for (const group of groups) {
    assert.deepEqual(
      Object.keys(group).sort(),
      ['name', 'slug', 'userDescription'].sort()
    );
    assert.equal('id' in group, false);
    assert.equal('newapiGroup' in group, false);
  }
});

test('getCallableListingsByGroup returns only callable listings in the selected group', async () => {
  const listings =
    await modules.queries.getCallableListingsByGroupUncached('official');
  const modelIds = listings.map(
    (listing: { modelId: string }) => listing.modelId
  );

  assertNoDuplicateRows(
    listings,
    (listing) => `${listing.modelId}:${listing.groupSlug}`
  );
  assert.ok(modelIds.includes('gpt-4o-mini'));
  assert.equal(modelIds.includes('query-coming-soon'), false);
  assert.equal(modelIds.includes('query-retired'), false);
  assert.ok(
    listings.every(
      (listing: { groupSlug: string; isCallable: boolean }) =>
        listing.groupSlug === 'official' && listing.isCallable
    )
  );
});

test('getSmokeTestedCallableModelIdsByGroup returns only publicly callable catalog models', async () => {
  const officialModelIds =
    await modules.queries.getSmokeTestedCallableModelIdsByGroupUncached(
      'official'
    );

  assert.deepEqual(officialModelIds, [...new Set(officialModelIds)]);
  assert.ok(officialModelIds.includes('gpt-4o-mini'));
  assert.equal(officialModelIds.includes('query-hidden-capability'), false);
  assert.deepEqual(
    await modules.queries.getSmokeTestedCallableModelIdsByGroupUncached(
      'disabled-route'
    ),
    []
  );
  assert.deepEqual(
    await modules.queries.getSmokeTestedCallableModelIdsByGroupUncached(
      'capability-only-group'
    ),
    []
  );
});

test('public query outputs do not serialize New API mapping details', async () => {
  const listingsJson = JSON.stringify(
    await modules.queries.getPublicListingsUncached({})
  );
  const groupsJson = JSON.stringify(
    await modules.queries.getGroupsForKeyCreationUncached()
  );

  assert.equal(listingsJson.includes('newapiGroup'), false);
  assert.equal(/newapi/i.test(listingsJson), false);
  assert.equal(groupsJson.includes('newapiGroup'), false);
  assert.equal(/newapi/i.test(groupsJson), false);
});
