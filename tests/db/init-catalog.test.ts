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
    "select slug, newapi_group, allow_create_key, status from catalog_group where slug = 'official'"
  );
  assert.deepEqual(official.rows[0], {
    slug: 'official',
    newapi_group: 'official',
    allow_create_key: 1,
    status: 'active',
  });

  const listing = await client.execute(`
    select
      catalog_model.model_id as model_id,
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
    catalogModelCapability,
    catalogModelListing,
  } = modules.schema;

  const counts = await countCatalogRows();
  assert.ok(counts.catalogVendor >= 3);
  assert.ok(counts.catalogCapability >= 4);
  assert.equal(counts.catalogStatus, 3);
  assert.ok(counts.catalogGroup >= 1);
  assert.ok(counts.catalogModel >= 1);
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
  assert.equal(official?.newapiGroup, 'official');
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
  assert.equal(listing?.statusId, available.id);
  assert.equal(listing?.smokeTested, true);
  assert.equal(listing?.sortOrder, 10);
});

test('initCatalog repairs older official groups that still target the default New API group', async () => {
  await modules.initCatalog();

  const { catalogGroup } = modules.schema;
  await modules
    .db()
    .update(catalogGroup)
    .set({ newapiGroup: '' })
    .where(eq(catalogGroup.slug, 'official'));

  await modules.initCatalog();

  const official = await findBySlug(
    catalogGroup,
    catalogGroup.slug,
    'official'
  );
  assert.equal(official?.newapiGroup, 'official');
});

test('official New API group migration repairs older empty mappings', async () => {
  await modules.initCatalog();

  const { catalogGroup } = modules.schema;
  await modules
    .db()
    .update(catalogGroup)
    .set({ newapiGroup: '' })
    .where(eq(catalogGroup.slug, 'official'));

  const migration = await readFile(
    join(
      process.cwd(),
      'src/config/db/migrations_sqlite/0006_official_newapi_group.sql'
    ),
    'utf8'
  );
  const client = createClient({ url: process.env.DATABASE_URL! });
  await client.executeMultiple(migration);
  await client.executeMultiple(migration);

  const official = await findBySlug(
    catalogGroup,
    catalogGroup.slug,
    'official'
  );
  assert.equal(official?.newapiGroup, 'official');
});

test('key creation group mapping migration repairs custom groups targeting official', async () => {
  await modules.initCatalog();

  const { catalogGroup } = modules.schema;
  await modules.db().insert(catalogGroup).values({
    id: 'legacy_custom_group_official_mapping',
    slug: 'codex-local-official',
    name: 'Codex Local Official',
    userDescription: 'Legacy custom route',
    newapiGroup: 'official',
    allowCreateKey: true,
    sortOrder: 1,
    status: 'active',
  });

  const migration = await readFile(
    join(
      process.cwd(),
      'src/config/db/migrations_sqlite/0008_key_creation_group_mapping.sql'
    ),
    'utf8'
  );
  const client = createClient({ url: process.env.DATABASE_URL! });
  await client.executeMultiple(migration);
  await client.executeMultiple(migration);

  const custom = await findBySlug(
    catalogGroup,
    catalogGroup.slug,
    'codex-local-official'
  );
  const official = await findBySlug(
    catalogGroup,
    catalogGroup.slug,
    'official'
  );
  assert.equal(custom?.newapiGroup, 'codex-local-official');
  assert.equal(official?.newapiGroup, 'official');
});

test('initCatalog preserves an operator-provided official New API mapping', async () => {
  await modules.initCatalog();

  const { catalogGroup } = modules.schema;
  await modules
    .db()
    .update(catalogGroup)
    .set({ newapiGroup: 'production-official' })
    .where(eq(catalogGroup.slug, 'official'));

  await modules.initCatalog();

  const official = await findBySlug(
    catalogGroup,
    catalogGroup.slug,
    'official'
  );
  assert.equal(official?.newapiGroup, 'production-official');
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
