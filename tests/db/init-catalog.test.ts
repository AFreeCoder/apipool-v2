import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { createClient } from '@libsql/client';
import { and, eq } from 'drizzle-orm';

let modules: any;

const catalogTableKeys = [
  'catalogVendor',
  'catalogCapability',
  'catalogStatus',
  'catalogGroup',
  'catalogModel',
  'catalogModelPrice',
  'catalogModelCapability',
  'catalogModelListing',
] as const;

async function setupDb() {
  const dbPath = join(process.cwd(), '.tmp', 'init-catalog.db');
  await mkdir(join(process.cwd(), '.tmp'), { recursive: true });
  await rm(dbPath, { force: true });

  process.env.DATABASE_PROVIDER = 'sqlite';
  process.env.DATABASE_URL = `file:${dbPath}`;
  process.env.DB_SCHEMA_FILE = './src/config/db/schema.sqlite.ts';
  process.env.DB_SINGLETON_ENABLED = 'false';

  const client = createClient({ url: `file:${dbPath}` });
  await applyMigrations(client);

  const schema = await import('@/config/db/schema');
  const { db } = await import('@/core/db');
  const { initCatalog } = await import('../../scripts/init-catalog');
  const publishReadiness = await import(
    '@/features/api-catalog/server/publish-readiness'
  );

  modules = {
    db,
    initCatalog,
    publishReadiness,
    schema,
  };
}

async function applyMigrations(client: ReturnType<typeof createClient>) {
  const migrationsDir = join(process.cwd(), 'src/config/db/migrations_sqlite');
  for (const file of (await readdir(migrationsDir))
    .filter((name) => name.endsWith('.sql'))
    .sort()) {
    await client.executeMultiple(
      await readFile(join(migrationsDir, file), 'utf8')
    );
  }
}

async function countCatalogRows() {
  const counts: Record<string, number> = {};

  for (const tableKey of catalogTableKeys) {
    counts[tableKey] = (
      await modules.db().select().from(modules.schema[tableKey])
    ).length;
  }

  return counts;
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

async function stageLegacyDiscountSlug() {
  const { catalogGroup } = modules.schema;
  const discount = await findBySlug(
    catalogGroup,
    catalogGroup.slug,
    'discount'
  );
  assert.ok(discount);
  await modules
    .db()
    .update(catalogGroup)
    .set({ slug: 'codex-discount' })
    .where(eq(catalogGroup.id, discount.id));
}

function isSqliteBusy(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes('SQLITE_BUSY') || message.includes('database is locked')
  );
}

async function initCatalogToleratingBusyRetry() {
  let lastError: unknown;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await modules.initCatalog();
      return;
    } catch (error) {
      if (!isSqliteBusy(error)) throw error;
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)));
    }
  }

  throw lastError;
}

test.before(setupDb);

test('migrations seed the minimum official catalog needed at production startup', async () => {
  const dbPath = join(process.cwd(), '.tmp', 'catalog-migration-seed.db');
  await rm(dbPath, { force: true });
  const client = createClient({ url: `file:${dbPath}` });
  await applyMigrations(client);

  const official = await client.execute(
    "select slug, allow_create_key, status from catalog_group where slug = 'official'"
  );
  assert.deepEqual(official.rows[0], {
    slug: 'official',
    allow_create_key: 1,
    status: 'active',
  });

  const listing = await client.execute(`
    select
      catalog_model.model_id as model_id,
      catalog_model_listing.newapi_group as newapi_group,
      catalog_model_listing.smoke_tested as smoke_tested,
      catalog_status.is_callable as is_callable
    from catalog_model_listing
    join catalog_model on catalog_model.id = catalog_model_listing.model_id
    join catalog_group on catalog_group.id = catalog_model_listing.group_id
    join catalog_status on catalog_status.id = catalog_model_listing.status_id
    where catalog_group.slug = 'official'
  `);
  assert.deepEqual(listing.rows[0], {
    model_id: 'gpt-4o-mini',
    // 结构迁移只加字段，绝不从旧门户分组映射自动回填。
    newapi_group: '',
    smoke_tested: 1,
    is_callable: 1,
  });
});

test('initCatalog is idempotent when run twice', async () => {
  await modules.initCatalog();
  const afterFirstRun = await countCatalogRows();

  await modules.initCatalog();
  const afterSecondRun = await countCatalogRows();

  assert.deepEqual(afterSecondRun, afterFirstRun);
});

test('initCatalog seeds the required first catalog data', async () => {
  await modules.initCatalog();

  const {
    catalogVendor,
    catalogCapability,
    catalogStatus,
    catalogGroup,
    catalogModel,
    catalogModelPrice,
    catalogModelCapability,
    catalogModelListing,
  } = modules.schema;

  const counts = await countCatalogRows();
  assert.ok(counts.catalogVendor >= 3);
  assert.ok(counts.catalogCapability >= 4);
  assert.equal(counts.catalogStatus, 3);
  assert.ok(counts.catalogGroup >= 1);
  assert.ok(counts.catalogModel >= 1);
  assert.ok(counts.catalogModelPrice >= 1);
  assert.ok(counts.catalogModelCapability >= 2);
  assert.ok(counts.catalogModelListing >= 1);

  const available = await findBySlug(
    catalogStatus,
    catalogStatus.slug,
    'available'
  );
  assert.equal(available?.isCallable, true);
  assert.equal(available?.isPublicVisible, true);

  const official = await findBySlug(
    catalogGroup,
    catalogGroup.slug,
    'official'
  );
  assert.equal(official?.name, '官方分组');
  assert.equal(official?.allowCreateKey, true);
  assert.equal(official?.status, 'active');

  const openai = await findBySlug(catalogVendor, catalogVendor.slug, 'openai');
  assert.equal(openai?.name, 'OpenAI');

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
  assert.ok(text);
  assert.ok(vision);

  const [model] = await modules
    .db()
    .select()
    .from(catalogModel)
    .where(eq(catalogModel.modelId, 'gpt-4o-mini'))
    .limit(1);
  assert.equal(model?.displayName, 'GPT-4o mini');
  assert.equal(model?.vendorId, openai.id);
  assert.equal(model?.contextWindow, 128000);
  assert.equal(model?.category, 'llm');

  const [modelPrice] = await modules
    .db()
    .select()
    .from(catalogModelPrice)
    .where(eq(catalogModelPrice.modelId, model.id))
    .limit(1);
  assert.equal(modelPrice?.pricingMode, 'cost_token');
  assert.equal(modelPrice?.source, 'seed_cost');
  assert.equal(modelPrice?.baseInputMicroUsd, 150000);
  assert.equal(modelPrice?.baseOutputMicroUsd, 600000);

  const capabilityRows = await modules
    .db()
    .select()
    .from(catalogModelCapability)
    .where(eq(catalogModelCapability.modelId, model.id));
  const capabilityIds = new Set(
    capabilityRows.map((row: { capabilityId: string }) => row.capabilityId)
  );
  assert.equal(capabilityIds.has(text.id), true);
  assert.equal(capabilityIds.has(vision.id), true);

  const [listing] = await modules
    .db()
    .select()
    .from(catalogModelListing)
    .where(
      and(
        eq(catalogModelListing.modelId, model.id),
        eq(catalogModelListing.groupId, official.id)
      )
    )
    .limit(1);
  assert.equal(listing?.inputMicroUsd, 150000);
  assert.equal(listing?.outputMicroUsd, 600000);
  assert.equal(listing?.newapiGroup, '');
  assert.equal(listing?.statusId, available.id);
  assert.equal(listing?.smokeTested, true);
  assert.equal(listing?.sortOrder, 10);
});

test('initCatalog 为 gpt-image-2 初始化分组隔离的 token 与按张定价', async () => {
  await modules.initCatalog();

  const { catalogGroup } = modules.schema;
  const official = await findBySlug(
    catalogGroup,
    catalogGroup.slug,
    'official'
  );
  const discount = await findBySlug(
    catalogGroup,
    catalogGroup.slug,
    'discount'
  );
  assert.ok(official);
  assert.ok(discount);

  const officialReadiness =
    await modules.publishReadiness.assessPublishReadiness(
      official.id,
      'gpt-image-2'
    );
  assert.equal(officialReadiness.ready, true);
  if (!officialReadiness.ready) return;
  assert.equal(officialReadiness.snapshot.newapiGroup, 'official');
  assert.equal(officialReadiness.snapshot.pricingBasis, 'token');
  assert.deepEqual(JSON.parse(officialReadiness.snapshot.ratesJson), {
    cached_image_input: 8_000_000,
    cached_input: 5_000_000,
    image_input: 8_000_000,
    image_output: 30_000_000,
    input: 5_000_000,
  });

  const discountReadiness =
    await modules.publishReadiness.assessPublishReadiness(
      discount.id,
      'gpt-image-2'
    );
  assert.equal(discountReadiness.ready, true);
  if (!discountReadiness.ready) return;
  assert.equal(discountReadiness.snapshot.newapiGroup, 'codex特惠');
  assert.equal(discountReadiness.snapshot.pricingBasis, 'unit');
  assert.deepEqual(JSON.parse(discountReadiness.snapshot.tiersJson), {
    default: 8_500,
    'resolution=2k': 14_000,
    'resolution=4k': 21_000,
  });
});

test('initCatalog 原位重命名特惠分组并清理 discount-1 历史引用', async () => {
  await modules.initCatalog();

  const {
    catalogGroup,
    catalogModel,
    catalogModelListing,
    catalogStatus,
    gatewayTask,
    modelPriceVersion,
    modelRoute,
    newApiKeyBinding,
    portalApiKey,
    requestLedger,
    user,
    walletAccount,
    walletLedger,
  } = modules.schema;
  const discount = await findBySlug(
    catalogGroup,
    catalogGroup.slug,
    'discount'
  );
  const [discountListing] = await modules
    .db()
    .select()
    .from(catalogModelListing)
    .where(eq(catalogModelListing.groupId, discount.id))
    .limit(1);
  const imageModel = await findBySlug(
    catalogModel,
    catalogModel.modelId,
    'gpt-image-2'
  );
  const available = await findBySlug(
    catalogStatus,
    catalogStatus.slug,
    'available'
  );

  await modules
    .db()
    .update(catalogGroup)
    .set({ slug: 'codex-discount', name: 'codex特惠' })
    .where(eq(catalogGroup.id, discount.id));
  await modules.db().insert(catalogGroup).values({
    id: 'retired_discount_group',
    slug: 'discount-1',
    name: '旧特惠分组',
    userDescription: '可删除的历史分组',
    allowCreateKey: false,
    sortOrder: 99,
    status: 'disabled',
  });
  await modules.db().insert(user).values({
    id: 'retired_discount_user',
    name: 'Retired Discount User',
    email: 'retired-discount@example.com',
  });
  await modules.db().insert(walletAccount).values({
    userId: 'retired_discount_user',
    balanceMicroUsd: 90_000,
  });
  await modules.db().insert(portalApiKey).values({
    id: 'retired_discount_portal_key',
    userId: 'retired_discount_user',
    groupId: 'retired_discount_group',
    keyHash: 'retired_discount_key_hash',
    keyPrefix: 'sk-ap-retired',
    status: 'disabled',
    name: 'Retired discount portal key',
  });
  await modules.db().insert(newApiKeyBinding).values({
    id: 'retired_discount_legacy_key',
    portalUserId: 'retired_discount_user',
    newapiUserId: 'retired_discount_remote_user',
    newapiKeyId: 'retired_discount_remote_key',
    keyMasked: 'sk-...retired',
    displayName: 'Retired discount legacy key',
    status: 'disabled',
    groupId: 'retired_discount_group',
    newapiGroup: 'retired-discount-upstream',
    idempotencyKey: 'retired_discount_legacy_key',
  });
  await modules.db().insert(catalogModelListing).values({
    id: 'retired_discount_listing',
    modelId: imageModel.id,
    groupId: 'retired_discount_group',
    newapiGroup: 'retired-discount-upstream',
    statusId: available.id,
    inputMicroUsd: 0,
    outputMicroUsd: 0,
  });
  await modules.db().insert(modelRoute).values({
    id: 'retired_discount_route',
    portalGroupId: 'retired_discount_group',
    portalModelId: 'gpt-image-2',
    newapiGroup: 'retired-discount-upstream',
    newapiModelId: 'gpt-image-2',
    version: 1,
    status: 'retired',
    publishedBy: 'migration-test',
  });
  await modules.db().insert(modelPriceVersion).values({
    id: 'retired_discount_price',
    portalGroupId: 'retired_discount_group',
    portalModelId: 'gpt-image-2',
    version: 1,
    status: 'retired',
    publishedBy: 'migration-test',
  });
  await modules.db().insert(requestLedger).values({
    id: 'retired_discount_request',
    newapiRequestId: 'retired_discount_remote_request',
    userId: 'retired_discount_user',
    portalKeyId: 'retired_discount_portal_key',
    portalGroupId: 'retired_discount_group',
    portalModelId: 'gpt-image-2',
    newapiGroup: 'retired-discount-upstream',
    newapiModelId: 'gpt-image-2',
    credentialId: 'retired_discount_credential',
    routeVersion: 1,
    priceVersionId: 'retired_discount_price',
    endpoint: '/v1/images/generations',
    status: 'settled',
    chargedMicroUsd: 10_000,
  });
  await modules.db().insert(gatewayTask).values({
    id: 'retired_discount_task',
    requestLedgerId: 'retired_discount_request',
    userId: 'retired_discount_user',
    portalKeyId: 'retired_discount_portal_key',
    status: 'failed_unbilled',
  });
  await modules.db().insert(walletLedger).values({
    id: 'retired_discount_wallet_entry',
    userId: 'retired_discount_user',
    entryType: 'request_charge',
    signedAmountMicroUsd: -10_000,
    balanceAfterMicroUsd: 90_000,
    requestLedgerId: 'retired_discount_request',
    idempotencyKey: 'retired_discount_wallet_entry',
  });

  await assert.rejects(
    () =>
      modules.initCatalog({
        deleteLegacyPortalKey: async () => {
          throw new Error('remote delete failed');
        },
      }),
    /remote delete failed/
  );
  assert.ok(
    await findBySlug(catalogGroup, catalogGroup.slug, 'codex-discount')
  );
  const [keyAfterRemoteFailure] = await modules
    .db()
    .select()
    .from(newApiKeyBinding)
    .where(eq(newApiKeyBinding.id, 'retired_discount_legacy_key'));
  assert.equal(keyAfterRemoteFailure.status, 'disabled');

  const remotelyDeletedKeys: Array<[string, string]> = [];
  await modules.initCatalog({
    deleteLegacyPortalKey: async (portalUserId: string, keyId: string) => {
      remotelyDeletedKeys.push([portalUserId, keyId]);
      await modules
        .db()
        .update(newApiKeyBinding)
        .set({ status: 'deleted', deletedAt: new Date() })
        .where(eq(newApiKeyBinding.id, keyId));
    },
  });

  const renamed = await findBySlug(catalogGroup, catalogGroup.slug, 'discount');
  assert.deepEqual(remotelyDeletedKeys, [
    ['retired_discount_user', 'retired_discount_legacy_key'],
  ]);
  assert.equal(renamed.id, discount.id);
  assert.equal(renamed.name, '特惠分组');
  assert.equal(
    await findBySlug(catalogGroup, catalogGroup.slug, 'codex-discount'),
    undefined
  );
  assert.equal(
    await findBySlug(catalogGroup, catalogGroup.slug, 'discount-1'),
    undefined
  );
  const [preservedListing] = await modules
    .db()
    .select()
    .from(catalogModelListing)
    .where(eq(catalogModelListing.id, discountListing.id));
  assert.equal(preservedListing.groupId, discount.id);

  for (const [table, column, id] of [
    [catalogModelListing, catalogModelListing.id, 'retired_discount_listing'],
    [modelRoute, modelRoute.id, 'retired_discount_route'],
    [modelPriceVersion, modelPriceVersion.id, 'retired_discount_price'],
    [requestLedger, requestLedger.id, 'retired_discount_request'],
    [gatewayTask, gatewayTask.id, 'retired_discount_task'],
    [portalApiKey, portalApiKey.id, 'retired_discount_portal_key'],
  ] as const) {
    const rows = await modules.db().select().from(table).where(eq(column, id));
    assert.equal(rows.length, 0);
  }

  const [legacyKey] = await modules
    .db()
    .select()
    .from(newApiKeyBinding)
    .where(eq(newApiKeyBinding.id, 'retired_discount_legacy_key'));
  assert.equal(legacyKey.status, 'deleted');
  assert.equal(legacyKey.groupId, null);
  assert.ok(legacyKey.deletedAt);

  const [walletEntry] = await modules
    .db()
    .select()
    .from(walletLedger)
    .where(eq(walletLedger.id, 'retired_discount_wallet_entry'));
  assert.equal(walletEntry.signedAmountMicroUsd, -10_000);
  assert.equal(walletEntry.balanceAfterMicroUsd, 90_000);
  assert.equal(walletEntry.requestLedgerId, 'retired_discount_request');
});

test('initCatalog 拒绝清理仍有活跃 Key 的 discount-1', async () => {
  const { catalogGroup, newApiKeyBinding } = modules.schema;
  await stageLegacyDiscountSlug();
  await modules.db().insert(catalogGroup).values({
    id: 'active_discount_group',
    slug: 'discount-1',
    name: '有活跃 Key 的旧分组',
    userDescription: '安全门禁测试',
    allowCreateKey: false,
    sortOrder: 99,
    status: 'disabled',
  });
  await modules.db().insert(newApiKeyBinding).values({
    id: 'active_discount_legacy_key',
    portalUserId: 'retired_discount_user',
    newapiUserId: 'active_discount_remote_user',
    newapiKeyId: 'active_discount_remote_key',
    keyMasked: 'sk-...active',
    displayName: 'Active discount legacy key',
    status: 'active',
    groupId: 'active_discount_group',
    newapiGroup: 'active-discount-upstream',
    idempotencyKey: 'active_discount_legacy_key',
  });

  await assert.rejects(
    () => modules.initCatalog(),
    /refused to delete discount-1 with non-disabled API keys/
  );
  assert.ok(await findBySlug(catalogGroup, catalogGroup.slug, 'discount-1'));

  await modules
    .db()
    .update(newApiKeyBinding)
    .set({ status: 'deleted', deletedAt: new Date() })
    .where(eq(newApiKeyBinding.id, 'active_discount_legacy_key'));
  await modules.initCatalog();
  assert.equal(
    await findBySlug(catalogGroup, catalogGroup.slug, 'discount-1'),
    undefined
  );
});

test('initCatalog 拒绝清理 discount-1 的非终态请求和任务', async () => {
  const { catalogGroup, gatewayTask, portalApiKey, requestLedger } =
    modules.schema;
  await stageLegacyDiscountSlug();
  await modules.db().insert(catalogGroup).values({
    id: 'busy_discount_group',
    slug: 'discount-1',
    name: '仍有任务的旧分组',
    userDescription: '非终态门禁测试',
    allowCreateKey: false,
    sortOrder: 99,
    status: 'disabled',
  });
  await modules.db().insert(portalApiKey).values({
    id: 'busy_discount_portal_key',
    userId: 'retired_discount_user',
    groupId: 'busy_discount_group',
    keyHash: 'busy_discount_key_hash',
    keyPrefix: 'sk-ap-busy',
    status: 'disabled',
    name: 'Busy discount portal key',
  });
  await modules.db().insert(requestLedger).values({
    id: 'busy_discount_request',
    userId: 'retired_discount_user',
    portalKeyId: 'busy_discount_portal_key',
    portalGroupId: 'busy_discount_group',
    portalModelId: 'gpt-image-2',
    newapiGroup: 'busy-discount-upstream',
    newapiModelId: 'gpt-image-2',
    credentialId: 'busy_discount_credential',
    routeVersion: 1,
    priceVersionId: 'busy_discount_price',
    endpoint: '/v1/images/generations',
    status: 'open',
  });

  await assert.rejects(
    () => modules.initCatalog(),
    /refused to delete discount-1 with non-terminal requests/
  );

  await modules
    .db()
    .update(requestLedger)
    .set({ status: 'failed_unbilled' })
    .where(eq(requestLedger.id, 'busy_discount_request'));
  await modules.db().insert(gatewayTask).values({
    id: 'busy_discount_task',
    requestLedgerId: 'busy_discount_request',
    userId: 'retired_discount_user',
    portalKeyId: 'busy_discount_portal_key',
    status: 'processing',
  });
  await assert.rejects(
    () => modules.initCatalog(),
    /refused to delete discount-1 with non-terminal tasks/
  );

  await modules
    .db()
    .update(gatewayTask)
    .set({ status: 'failed_unbilled' })
    .where(eq(gatewayTask.id, 'busy_discount_task'));
  await modules.initCatalog();
  assert.equal(
    await findBySlug(catalogGroup, catalogGroup.slug, 'discount-1'),
    undefined
  );
});

test('initCatalog 不会在一次性迁移完成后删除新建的同名分组', async () => {
  const { catalogGroup } = modules.schema;
  await modules.db().insert(catalogGroup).values({
    id: 'future_discount_group',
    slug: 'discount-1',
    name: '未来新建分组',
    userDescription: '不属于一次性迁移',
    allowCreateKey: false,
    sortOrder: 99,
    status: 'disabled',
  });

  await modules.initCatalog();
  assert.ok(await findBySlug(catalogGroup, catalogGroup.slug, 'discount-1'));

  await modules
    .db()
    .delete(catalogGroup)
    .where(eq(catalogGroup.id, 'future_discount_group'));
});

test('initCatalog 不会为已有售卖项推断模型级映射', async () => {
  await modules.initCatalog();

  const { catalogModelListing } = modules.schema;
  const [listing] = await modules.db().select().from(catalogModelListing);
  await modules
    .db()
    .update(catalogModelListing)
    .set({ newapiGroup: '' })
    .where(eq(catalogModelListing.id, listing.id));

  await modules.initCatalog();

  const [after] = await modules
    .db()
    .select()
    .from(catalogModelListing)
    .where(eq(catalogModelListing.id, listing.id));
  assert.equal(after.newapiGroup, '');
});

test('initCatalog 仅在新建售卖项时写入 New API 分组', async () => {
  await modules.initCatalog();

  const { catalogModelListing } = modules.schema;
  await modules.db().delete(catalogModelListing);

  await modules.initCatalog();

  const [created] = await modules.db().select().from(catalogModelListing);
  assert.equal(created.newapiGroup, 'official');
});

test('initCatalog handles concurrent re-entry without unique conflicts', async () => {
  await modules.initCatalog();
  const beforeConcurrentRun = await countCatalogRows();

  await Promise.all([
    initCatalogToleratingBusyRetry(),
    initCatalogToleratingBusyRetry(),
  ]);

  const afterConcurrentRun = await countCatalogRows();
  assert.deepEqual(afterConcurrentRun, beforeConcurrentRun);
});
