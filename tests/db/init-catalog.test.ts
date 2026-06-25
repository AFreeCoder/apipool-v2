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

  modules = {
    db,
    initCatalog,
    schema,
  };
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
  assert.equal(official?.newapiGroup, '');
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
