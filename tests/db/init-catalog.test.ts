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

  modules = {
    db,
    initCatalog,
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
  assert.equal(official?.name, 'Official');
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
