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
  sortOrder: number;
}) {
  const model = await modules.service.createModel({
    modelId: input.modelId,
    displayName: input.displayName,
    vendorId: input.vendorId,
    category: 'llm',
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
  await modules.service.createGroup({
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
  await modules.service.createVendor({
    slug: 'hidden-vendor',
    name: 'Hidden Vendor',
    sortOrder: 99,
    status: 'disabled',
  });
  await modules.service.createCapability({
    slug: 'hidden-capability',
    name: 'Hidden Capability',
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
}

test.before(setupDb);

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
  assert.ok(
    categoryListings.every(
      (listing: { category: string }) => listing.category === 'llm'
    )
  );
});

test('getPublicListings aggregates capabilities for each model without exposing internal columns', async () => {
  const listings = await modules.queries.getPublicListingsUncached({
    group: 'official',
    status: 'available',
  });
  const seeded = listings.find(
    (listing: { modelId: string }) => listing.modelId === 'gpt-4o-mini'
  );

  assert.ok(seeded);
  assert.equal(seeded.category, 'llm');
  assert.deepEqual(new Set(seeded.capabilities), new Set(['text', 'vision']));
  assert.equal('id' in seeded, false);
  assert.equal('newapiGroup' in seeded, false);
});

test('getFilterDimensions returns only active dictionary options in sort order', async () => {
  const dimensions = await modules.queries.getFilterDimensionsUncached();

  assert.ok(
    dimensions.vendors.some(
      (vendor: { slug: string }) => vendor.slug === 'openai'
    )
  );
  assert.ok(
    dimensions.groups.some(
      (group: { slug: string }) => group.slug === 'partner'
    )
  );
  assert.ok(
    dimensions.statuses.some(
      (status: { slug: string }) => status.slug === 'retired'
    )
  );
  assert.ok(
    dimensions.categories.some(
      (category: { slug: string }) => category.slug === 'llm'
    )
  );
  assert.equal(
    dimensions.vendors.some(
      (vendor: { slug: string }) => vendor.slug === 'hidden-vendor'
    ),
    false
  );
  assert.equal(
    dimensions.capabilities.some(
      (capability: { slug: string }) => capability.slug === 'hidden-capability'
    ),
    false
  );
  assert.equal(
    dimensions.groups.some(
      (group: { slug: string }) => group.slug === 'disabled-route'
    ),
    false
  );
  assert.equal(
    dimensions.statuses.some(
      (status: { slug: string }) => status.slug === 'disabled-status'
    ),
    false
  );
});

test('getGroupsForKeyCreation returns only active groups that allow key creation and no internal fields', async () => {
  const groups = await modules.queries.getGroupsForKeyCreationUncached();
  const slugs = groups.map((group: { slug: string }) => group.slug);

  assert.ok(slugs.includes('official'));
  assert.ok(slugs.includes('partner'));
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
