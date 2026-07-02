import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { createClient } from '@libsql/client';
import { eq } from 'drizzle-orm';

let modules: any;

async function setupDb() {
  const dbPath = join(process.cwd(), '.tmp', 'catalog-service.db');
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
  const service = await import('@/features/api-catalog/server/catalog-service');

  modules = {
    db,
    schema,
    service,
  };
}

async function createVendor(slug: string) {
  return modules.service.createVendor({
    slug,
    name: `Vendor ${slug}`,
    sortOrder: 10,
    status: 'active',
  });
}

async function createStatus(slug: string, isCallable = true) {
  return modules.service.createStatus({
    slug,
    name: `Status ${slug}`,
    isCallable,
    isPublicVisible: true,
    sortOrder: 20,
    status: 'active',
  });
}

async function createGroup(slug: string, newapiGroup: string) {
  return modules.service.createGroup({
    slug,
    name: `Group ${slug}`,
    userDescription: `${slug} group`,
    newapiGroup,
    allowCreateKey: true,
    sortOrder: 30,
    status: 'active',
  });
}

async function createCategory(slug: string) {
  return modules.service.createCategory({
    slug,
    name: `Category ${slug}`,
    sortOrder: 40,
    status: 'active',
  });
}

async function createModel(slug: string, vendorId: string) {
  return modules.service.createModel({
    modelId: slug,
    displayName: `Model ${slug}`,
    vendorId,
    category: 'llm',
    contextWindow: 128000,
  });
}

test.before(setupDb);

test('vendor service supports full admin CRUD', async () => {
  const created = await modules.service.createVendor({
    slug: 'crud-vendor',
    name: 'CRUD Vendor',
    sortOrder: 7,
    status: 'active',
  });

  assert.ok(created.id);
  assert.equal(created.slug, 'crud-vendor');
  assert.equal(created.name, 'CRUD Vendor');

  const found = await modules.service.getVendorById(created.id);
  assert.equal(found?.id, created.id);

  const updated = await modules.service.updateVendor(created.id, {
    name: 'CRUD Vendor Updated',
    sortOrder: 17,
  });
  assert.equal(updated.id, created.id);
  assert.equal(updated.name, 'CRUD Vendor Updated');
  assert.equal(updated.sortOrder, 17);

  const allVendors = await modules.service.getVendors();
  assert.equal(
    allVendors.some((vendor: { id: string }) => vendor.id === created.id),
    true
  );

  await modules.service.deleteVendor(created.id);
  assert.equal(await modules.service.getVendorById(created.id), undefined);
  assert.equal(
    (await modules.service.getVendors()).some(
      (vendor: { id: string }) => vendor.id === created.id
    ),
    false
  );
});

test('status service persists callable and public visibility booleans', async () => {
  const status = await modules.service.createStatus({
    slug: 'boolean-status',
    name: 'Boolean Status',
    isCallable: true,
    isPublicVisible: false,
    sortOrder: 1,
    status: 'active',
  });

  const found = await modules.service.getStatusById(status.id);
  assert.equal(found?.isCallable, true);
  assert.equal(found?.isPublicVisible, false);
});

test('setModelCapabilities replaces all capability links for a model', async () => {
  const vendor = await createVendor('cap-vendor');
  const model = await createModel('cap-model', vendor.id);
  const text = await modules.service.createCapability({
    slug: 'cap-text',
    name: 'Text',
    sortOrder: 1,
    status: 'active',
  });
  const vision = await modules.service.createCapability({
    slug: 'cap-vision',
    name: 'Vision',
    sortOrder: 2,
    status: 'active',
  });

  async function linkedCapabilityIds() {
    const rows = await modules
      .db()
      .select()
      .from(modules.schema.catalogModelCapability)
      .where(eq(modules.schema.catalogModelCapability.modelId, model.id));

    return rows.map((row: { capabilityId: string }) => row.capabilityId);
  }

  await modules.service.setModelCapabilities(model.id, [text.id, vision.id]);
  assert.deepEqual(
    new Set(await linkedCapabilityIds()),
    new Set([text.id, vision.id])
  );

  await modules.service.setModelCapabilities(model.id, [text.id]);
  assert.deepEqual(await linkedCapabilityIds(), [text.id]);

  await modules.service.setModelCapabilities(model.id, []);
  assert.deepEqual(await linkedCapabilityIds(), []);
});

test('listing service returns listings by model and exposes group mapping server-side', async () => {
  const vendor = await createVendor('listing-vendor');
  const status = await createStatus('listing-status');
  const model = await createModel('listing-model', vendor.id);
  const official = await createGroup('listing-official', 'official-gateway');
  const deal = await createGroup('listing-deal', 'deal-gateway');

  const first = await modules.service.createListing({
    modelId: model.id,
    groupId: official.id,
    statusId: status.id,
    inputMicroUsd: 150000,
    outputMicroUsd: 600000,
    listInputMicroUsd: 200000,
    listOutputMicroUsd: 800000,
    discountNote: 'Launch price',
    description: 'Official listing',
    smokeTested: true,
    featured: true,
    sortOrder: 1,
  });
  const second = await modules.service.createListing({
    modelId: model.id,
    groupId: deal.id,
    statusId: status.id,
    inputMicroUsd: 100000,
    outputMicroUsd: 500000,
    description: 'Deal listing',
    smokeTested: false,
    featured: false,
    sortOrder: 2,
  });

  const listings = await modules.service.getListingsByModel(model.id);
  assert.deepEqual(
    listings.map((listing: { id: string }) => listing.id),
    [first.id, second.id]
  );
  assert.equal(
    await modules.service.getGroupNewapiMapping(official.id),
    'official-gateway'
  );
});

test('createListing lets the database reject duplicate model and group pairs', async () => {
  const vendor = await createVendor('duplicate-vendor');
  const status = await createStatus('duplicate-status');
  const model = await createModel('duplicate-model', vendor.id);
  const group = await createGroup('duplicate-group', 'duplicate-gateway');
  const listing = {
    modelId: model.id,
    groupId: group.id,
    statusId: status.id,
    inputMicroUsd: 1,
    outputMicroUsd: 2,
    smokeTested: true,
    featured: false,
    sortOrder: 1,
  };

  await modules.service.createListing(listing);
  await assert.rejects(() => modules.service.createListing(listing));
});

test('upsertModelAdminConfig creates and updates model, default listing, categories, and capabilities', async () => {
  const vendor = await createVendor('admin-model-vendor');
  const status = await createStatus('admin-model-status');
  const group = await createGroup('admin-model-group', 'admin-model-gateway');
  const textCategory = await createCategory('admin-model-llm');
  const imageCategory = await createCategory('admin-model-image');
  const text = await modules.service.createCapability({
    slug: 'admin-model-text',
    name: 'Text',
    sortOrder: 1,
    status: 'active',
  });
  const vision = await modules.service.createCapability({
    slug: 'admin-model-vision',
    name: 'Vision',
    sortOrder: 2,
    status: 'active',
  });

  const created = await modules.service.upsertModelAdminConfig({
    operatorUserId: 'operator-create-admin-model',
    model: {
      modelId: 'admin-gpt-image',
      displayName: 'Admin GPT Image',
      vendorId: vendor.id,
      categoryIds: [textCategory.id, imageCategory.id],
    },
    basePrice: {
      inputMicroUsd: 5_000_000,
      outputMicroUsd: 40_000_000,
      imageInputMicroUsd: 10_000_000,
      imageOutputMicroUsd: 40_000_000,
    },
    listing: {
      groupId: group.id,
      statusId: status.id,
      discountRateBps: 500,
      discountNote: '0.5 fold launch discount',
      smokeTested: true,
      featured: false,
      sortOrder: 1,
    },
    capabilityIds: [text.id, vision.id],
  });

  assert.equal(created.model.modelId, 'admin-gpt-image');
  assert.equal(created.model.category, 'admin-model-llm');
  assert.equal(created.listing.imageInputMicroUsd, 10_000_000);
  assert.equal(created.listing.imageOutputMicroUsd, 40_000_000);
  assert.equal(created.listing.discountRateBps, 500);
  assert.equal(created.basePrice.baseInputMicroUsd, 5_000_000);
  assert.equal(created.basePrice.baseOutputMicroUsd, 40_000_000);
  assert.equal(created.basePrice.pricingMode, 'manual_token');
  assert.equal(created.basePrice.source, 'manual');
  assert.equal(created.basePrice.reviewedBy, 'operator-create-admin-model');
  assert.deepEqual(
    new Set(
      (await modules.service.getModelCategories(created.model.id)).map(
        (category: { id: string }) => category.id
      )
    ),
    new Set([textCategory.id, imageCategory.id])
  );
  assert.deepEqual(
    (await modules.service.getModelCapabilities(created.model.id)).map(
      (capability: { id: string }) => capability.id
    ),
    [text.id, vision.id]
  );

  const { catalogModelListing } = modules.schema;
  await modules
    .db()
    .update(catalogModelListing)
    .set({
      priceDriftStatus: 'matched',
      effectivePriceFormula: '{"source":"newapi_group_ratio"}',
      effectivePriceSyncedAt: new Date(),
    })
    .where(eq(catalogModelListing.id, created.listing.id));

  const updated = await modules.service.upsertModelAdminConfig({
    modelId: created.model.id,
    operatorUserId: 'operator-update-admin-model',
    model: {
      modelId: 'admin-gpt-image-latest',
      displayName: 'Admin GPT Image Latest',
      vendorId: vendor.id,
      categoryIds: [imageCategory.id],
    },
    basePrice: {
      inputMicroUsd: 4_000_000,
      outputMicroUsd: 32_000_000,
      imageInputMicroUsd: 8_000_000,
      imageOutputMicroUsd: 32_000_000,
    },
    listing: {
      id: created.listing.id,
      groupId: group.id,
      statusId: status.id,
      discountRateBps: 50,
      discountNote: '0.05 fold experimental discount',
      smokeTested: false,
      featured: true,
      sortOrder: 2,
    },
    capabilityIds: [vision.id],
  });

  assert.equal(updated.model.id, created.model.id);
  assert.equal(updated.model.modelId, 'admin-gpt-image-latest');
  assert.equal(updated.model.category, 'admin-model-image');
  assert.equal(updated.listing.id, created.listing.id);
  assert.equal(updated.listing.inputMicroUsd, 4_000_000);
  assert.equal(updated.listing.imageInputMicroUsd, 8_000_000);
  assert.equal(updated.listing.discountRateBps, 50);
  assert.equal(updated.basePrice.id, created.basePrice.id);
  assert.equal(updated.basePrice.baseInputMicroUsd, 4_000_000);
  assert.equal(updated.basePrice.baseImageInputMicroUsd, 8_000_000);
  assert.equal(updated.basePrice.reviewedBy, 'operator-update-admin-model');
  assert.equal(updated.listing.priceDriftStatus, 'needs_live_check');
  assert.equal(updated.listing.effectivePriceFormula, null);
  assert.equal(updated.listing.effectivePriceSyncedAt, null);
  assert.deepEqual(
    (await modules.service.getModelCategories(created.model.id)).map(
      (category: { id: string }) => category.id
    ),
    [imageCategory.id]
  );
  assert.deepEqual(
    (await modules.service.getModelCapabilities(created.model.id)).map(
      (capability: { id: string }) => capability.id
    ),
    [vision.id]
  );

  const { catalogModelPrice } = modules.schema;
  const [storedBasePrice] = await modules
    .db()
    .select()
    .from(catalogModelPrice)
    .where(eq(catalogModelPrice.modelId, created.model.id))
    .limit(1);
  assert.equal(storedBasePrice.baseOutputMicroUsd, 32_000_000);
  assert.equal(storedBasePrice.syncStatus, 'manual');
});

test('deleteModel removes catalog model relations even without sqlite foreign key enforcement', async () => {
  const vendor = await createVendor('delete-model-vendor');
  const status = await createStatus('delete-model-status');
  const group = await createGroup('delete-model-group', 'delete-model-gateway');
  const category = await createCategory('delete-model-category');
  const capability = await modules.service.createCapability({
    slug: 'delete-model-capability',
    name: 'Delete Model Capability',
    sortOrder: 1,
    status: 'active',
  });
  const created = await modules.service.upsertModelAdminConfig({
    model: {
      modelId: 'delete-model-target',
      displayName: 'Delete Model Target',
      vendorId: vendor.id,
      categoryIds: [category.id],
    },
    basePrice: {
      inputMicroUsd: 1,
      outputMicroUsd: 2,
    },
    listing: {
      groupId: group.id,
      statusId: status.id,
      smokeTested: true,
      featured: false,
      sortOrder: 1,
    },
    capabilityIds: [capability.id],
  });

  await modules.service.deleteModel(created.model.id);

  assert.equal(await modules.service.getModelById(created.model.id), undefined);
  assert.deepEqual(
    await modules.service.getListingsByModel(created.model.id),
    []
  );

  const [capabilityRows, categoryRows] = await Promise.all([
    modules
      .db()
      .select()
      .from(modules.schema.catalogModelCapability)
      .where(
        eq(modules.schema.catalogModelCapability.modelId, created.model.id)
      ),
    modules
      .db()
      .select()
      .from(modules.schema.catalogModelCategory)
      .where(eq(modules.schema.catalogModelCategory.modelId, created.model.id)),
  ]);
  assert.deepEqual(capabilityRows, []);
  assert.deepEqual(categoryRows, []);
});
