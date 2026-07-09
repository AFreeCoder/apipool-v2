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

async function createModel(slug: string, vendorId: string, category = 'llm') {
  return modules.service.createModel({
    modelId: slug,
    displayName: `Model ${slug}`,
    vendorId,
    category,
    contextWindow: 128000,
  });
}

async function createModelListing(slug: string) {
  const vendor = await createVendor(`${slug}-vendor`);
  const status = await createStatus(`${slug}-status`);
  const model = await createModel(`${slug}-model`, vendor.id);
  const group = await createGroup(`${slug}-group`, `${slug}-gateway`);
  const listing = await modules.service.createListing({
    modelId: model.id,
    groupId: group.id,
    statusId: status.id,
    inputMicroUsd: 1,
    outputMicroUsd: 2,
    smokeTested: true,
    featured: false,
    sortOrder: 1,
  });

  return { vendor, status, model, group, listing };
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

test('dictionary update services reject slug changes and preserve stored slugs', async () => {
  const vendor = await createVendor('immutable-vendor');
  const group = await createGroup('immutable-group', 'immutable-gateway');
  const category = await createCategory('immutable-category');
  const capability = await modules.service.createCapability({
    slug: 'immutable-capability',
    name: 'Immutable Capability',
    sortOrder: 1,
    status: 'active',
  });
  const status = await createStatus('immutable-status');

  const cases = [
    {
      update: () =>
        modules.service.updateVendor(vendor.id, { slug: 'changed-vendor' }),
      read: () => modules.service.getVendorById(vendor.id),
      slug: vendor.slug,
    },
    {
      update: () =>
        modules.service.updateGroup(group.id, { slug: 'changed-group' }),
      read: () => modules.service.getGroupById(group.id),
      slug: group.slug,
    },
    {
      update: () =>
        modules.service.updateCategory(category.id, {
          slug: 'changed-category',
        }),
      read: () => modules.service.getCategoryById(category.id),
      slug: category.slug,
    },
    {
      update: () =>
        modules.service.updateCapability(capability.id, {
          slug: 'changed-capability',
        }),
      read: () => modules.service.getCapabilityById(capability.id),
      slug: capability.slug,
    },
    {
      update: () =>
        modules.service.updateStatus(status.id, { slug: 'changed-status' }),
      read: () => modules.service.getStatusById(status.id),
      slug: status.slug,
    },
  ];

  for (const item of cases) {
    await assert.rejects(item.update, /slug/i);
    assert.equal((await item.read())?.slug, item.slug);
  }
});

test('dictionary update services accept original slug while updating non-slug fields', async () => {
  const vendor = await createVendor('immutable-positive-vendor');
  const group = await createGroup(
    'immutable-positive-group',
    'immutable-positive-gateway'
  );
  const category = await createCategory('immutable-positive-category');
  const capability = await modules.service.createCapability({
    slug: 'immutable-positive-capability',
    name: 'Immutable Positive Capability',
    sortOrder: 1,
    status: 'active',
  });
  const status = await createStatus('immutable-positive-status');

  const updatedVendor = await modules.service.updateVendor(vendor.id, {
    slug: vendor.slug,
    name: 'Immutable Positive Vendor Updated',
  });
  assert.equal(updatedVendor.slug, vendor.slug);
  assert.equal(updatedVendor.name, 'Immutable Positive Vendor Updated');

  const updatedGroup = await modules.service.updateGroup(group.id, {
    slug: group.slug,
    name: 'Immutable Positive Group Updated',
  });
  assert.equal(updatedGroup.slug, group.slug);
  assert.equal(updatedGroup.name, 'Immutable Positive Group Updated');

  const updatedCategory = await modules.service.updateCategory(category.id, {
    slug: category.slug,
    name: 'Immutable Positive Category Updated',
  });
  assert.equal(updatedCategory.slug, category.slug);
  assert.equal(updatedCategory.name, 'Immutable Positive Category Updated');

  const updatedCapability = await modules.service.updateCapability(
    capability.id,
    {
      slug: capability.slug,
      name: 'Immutable Positive Capability Updated',
    }
  );
  assert.equal(updatedCapability.slug, capability.slug);
  assert.equal(updatedCapability.name, 'Immutable Positive Capability Updated');

  const updatedStatus = await modules.service.updateStatus(status.id, {
    slug: status.slug,
    name: 'Immutable Positive Status Updated',
  });
  assert.equal(updatedStatus.slug, status.slug);
  assert.equal(updatedStatus.name, 'Immutable Positive Status Updated');
});

test('dictionary delete services allow unreferenced records', async () => {
  const vendor = await createVendor('delete-free-vendor');
  const group = await createGroup('delete-free-group', 'delete-free-gateway');
  const category = await createCategory('delete-free-category');
  const capability = await modules.service.createCapability({
    slug: 'delete-free-capability',
    name: 'Delete Free Capability',
    sortOrder: 1,
    status: 'active',
  });
  const status = await createStatus('delete-free-status');

  await modules.service.deleteVendor(vendor.id);
  await modules.service.deleteGroup(group.id);
  await modules.service.deleteCategory(category.id);
  await modules.service.deleteCapability(capability.id);
  await modules.service.deleteStatus(status.id);

  assert.equal(await modules.service.getVendorById(vendor.id), undefined);
  assert.equal(await modules.service.getGroupById(group.id), undefined);
  assert.equal(await modules.service.getCategoryById(category.id), undefined);
  assert.equal(await modules.service.getCapabilityById(capability.id), undefined);
  assert.equal(await modules.service.getStatusById(status.id), undefined);
});

test('dictionary delete services block referenced vendor, group, capability, and status records', async () => {
  const created = await createModelListing('delete-blocked');
  const capability = await modules.service.createCapability({
    slug: 'delete-blocked-capability',
    name: 'Delete Blocked Capability',
    sortOrder: 1,
    status: 'active',
  });
  await modules.service.setModelCapabilities(created.model.id, [capability.id]);

  for (const action of [
    () => modules.service.deleteVendor(created.vendor.id),
    () => modules.service.deleteGroup(created.group.id),
    () => modules.service.deleteCapability(capability.id),
    () => modules.service.deleteStatus(created.status.id),
  ]) {
    await assert.rejects(action, (error: unknown) => {
      assert.equal(
        error instanceof modules.service.CatalogDeleteBlockedError,
        true
      );
      return true;
    });
  }
});

test('category deletion is blocked by model category links and legacy category slug references', async () => {
  const vendor = await createVendor('category-block-vendor');
  const linkedCategory = await createCategory('category-block-linked');
  const linkedModel = await createModel('category-block-linked-model', vendor.id);

  await modules
    .db()
    .insert(modules.schema.catalogModelCategory)
    .values({
      id: 'category_block_link',
      modelId: linkedModel.id,
      categoryId: linkedCategory.id,
    });

  await assert.rejects(
    () => modules.service.deleteCategory(linkedCategory.id),
    (error: unknown) =>
      error instanceof modules.service.CatalogDeleteBlockedError
  );

  const slugCategory = await createCategory('category-block-slug');
  await createModel('category-block-slug-model', vendor.id, slugCategory.slug);

  await assert.rejects(
    () => modules.service.deleteCategory(slugCategory.id),
    (error: unknown) =>
      error instanceof modules.service.CatalogDeleteBlockedError
  );
});

test('group deletion ignores deleted key bindings but blocks active key bindings', async () => {
  const deletedGroup = await createGroup(
    'key-binding-deleted-group',
    'key-binding-deleted-gateway'
  );
  const activeGroup = await createGroup(
    'key-binding-active-group',
    'key-binding-active-gateway'
  );

  await modules.db().insert(modules.schema.user).values({
    id: 'key_binding_guard_user',
    name: 'Key Binding Guard',
    email: 'key-binding-guard@example.com',
  });

  await modules.db().insert(modules.schema.newApiKeyBinding).values([
    {
      id: 'key_binding_guard_deleted',
      portalUserId: 'key_binding_guard_user',
      newapiUserId: 'remote_key_binding_guard_deleted',
      newapiKeyId: 'remote_key_binding_guard_deleted_key',
      keyMasked: 'sk-...deleted',
      displayName: 'Deleted key binding',
      status: 'deleted',
      groupId: deletedGroup.id,
      newapiGroup: deletedGroup.newapiGroup,
      idempotencyKey: 'key_binding_guard_deleted',
    },
    {
      id: 'key_binding_guard_active',
      portalUserId: 'key_binding_guard_user',
      newapiUserId: 'remote_key_binding_guard_active',
      newapiKeyId: 'remote_key_binding_guard_active_key',
      keyMasked: 'sk-...active',
      displayName: 'Active key binding',
      status: 'active',
      groupId: activeGroup.id,
      newapiGroup: activeGroup.newapiGroup,
      idempotencyKey: 'key_binding_guard_active',
    },
  ]);

  await modules.service.deleteGroup(deletedGroup.id);
  assert.equal(await modules.service.getGroupById(deletedGroup.id), undefined);

  await assert.rejects(
    () => modules.service.deleteGroup(activeGroup.id),
    (error: unknown) =>
      error instanceof modules.service.CatalogDeleteBlockedError
  );
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

async function readGroupRow(id: string) {
  const [row] = await modules
    .db()
    .select()
    .from(modules.schema.catalogGroup)
    .where(eq(modules.schema.catalogGroup.id, id));
  return row;
}

async function readListingRow(id: string) {
  const [row] = await modules
    .db()
    .select()
    .from(modules.schema.catalogModelListing)
    .where(eq(modules.schema.catalogModelListing.id, id));
  return row;
}

async function seedSyncedGroupPricing(groupId: string, listingId: string) {
  await modules
    .db()
    .update(modules.schema.catalogGroup)
    .set({
      newapiGroupRatioBps: 10000,
      newapiGroupRatioDecimal: '1',
      newapiGroupRatioRaw: '1.0',
      pricingSyncStatus: 'synced',
      pricingSyncedAt: new Date(),
    })
    .where(eq(modules.schema.catalogGroup.id, groupId));

  await modules
    .db()
    .update(modules.schema.catalogModelListing)
    .set({ priceDriftStatus: 'matched' })
    .where(eq(modules.schema.catalogModelListing.id, listingId));
}

test('remapping a group to another New API group invalidates its cached ratio and listing prices', async () => {
  const { group, listing } = await createModelListing('remap');
  await seedSyncedGroupPricing(group.id, listing.id);

  // 建 Key 与计费立刻走新映射，展示价却仍按旧倍率算 → 用户按页面价估算会扣错钱
  await modules.service.updateGroup(group.id, {
    slug: group.slug,
    name: group.name,
    newapiGroup: 'another-gateway',
    allowCreateKey: true,
    sortOrder: 30,
    status: 'active',
  });

  const groupRow = await readGroupRow(group.id);
  assert.equal(groupRow.newapiGroup, 'another-gateway');
  assert.equal(groupRow.newapiGroupRatioBps, null);
  assert.equal(groupRow.newapiGroupRatioDecimal, null);
  assert.equal(groupRow.newapiGroupRatioRaw, null);
  assert.equal(groupRow.pricingSyncStatus, 'unknown');
  assert.equal(groupRow.pricingSyncedAt, null);

  // 公开价转为「—」，直到重新跑一次价格同步确认
  const listingRow = await readListingRow(listing.id);
  assert.equal(listingRow.priceDriftStatus, 'needs_live_check');
});

test('editing a group without changing its New API mapping keeps synced pricing intact', async () => {
  const { group, listing } = await createModelListing('rename-only');
  await seedSyncedGroupPricing(group.id, listing.id);

  await modules.service.updateGroup(group.id, {
    slug: group.slug,
    name: 'Renamed Group',
    newapiGroup: 'rename-only-gateway',
    allowCreateKey: true,
    sortOrder: 31,
    status: 'active',
  });

  const groupRow = await readGroupRow(group.id);
  assert.equal(groupRow.name, 'Renamed Group');
  assert.equal(groupRow.newapiGroupRatioBps, 10000);
  assert.equal(groupRow.pricingSyncStatus, 'synced');

  const listingRow = await readListingRow(listing.id);
  assert.equal(listingRow.priceDriftStatus, 'matched');
});

test('deleting a model also removes its base price row', async () => {
  const { model } = await createModelListing('delete-with-price');

  await modules
    .db()
    .insert(modules.schema.catalogModelPrice)
    .values({
      id: 'price_delete_model',
      modelId: model.id,
      baseInputMicroUsd: 150000,
      baseOutputMicroUsd: 600000,
      source: 'manual',
      syncStatus: 'synced',
      driftStatus: 'matched',
    });

  await modules.service.deleteModel(model.id);

  // 事务里显式删掉，不依赖 FK cascade —— libsql 运行时是否开启
  // PRAGMA foreign_keys 从未验证过（OQ-1）
  const prices = await modules
    .db()
    .select()
    .from(modules.schema.catalogModelPrice)
    .where(eq(modules.schema.catalogModelPrice.modelId, model.id));
  assert.equal(prices.length, 0);
});

test('capability and category writes are transactional so a failure cannot clear them', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(
    'src/features/api-catalog/server/catalog-service.ts',
    'utf8'
  );

  // delete + insert 非事务时，insert 失败会把模型的能力清空 → 模型从公开页消失
  for (const fn of ['setModelCapabilities', 'setModelCategories']) {
    const body = source.split(`export async function ${fn}(`)[1].split('}\n')[0];
    assert.match(body, /transaction/, `${fn} must run in a transaction`);
  }
});
