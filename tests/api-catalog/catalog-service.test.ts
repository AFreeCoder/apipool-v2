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
