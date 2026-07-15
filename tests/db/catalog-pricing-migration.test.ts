import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { createClient } from '@libsql/client';

function id(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

async function applyMigrationFiles(
  client: ReturnType<typeof createClient>,
  predicate: (file: string) => boolean
) {
  const migrationsDir = join(process.cwd(), 'src/config/db/migrations_sqlite');
  for (const file of (await readdir(migrationsDir))
    .filter((name) => name.endsWith('.sql'))
    .filter(predicate)
    .sort()) {
    await client.executeMultiple(
      await readFile(join(migrationsDir, file), 'utf8')
    );
  }
}

async function listingCache(client: ReturnType<typeof createClient>) {
  const rows = await client.execute(`
    select
      id,
      model_id,
      group_id,
      input_micro_usd,
      output_micro_usd,
      image_input_micro_usd,
      image_output_micro_usd
    from catalog_model_listing
    order by id
  `);
  return rows.rows.map((row) => ({ ...row }));
}

test('0008 migration plus backfill CLI apply preserves listing cache and reports conflicts', async () => {
  const dbPath = join(process.cwd(), '.tmp', 'catalog-pricing-migration.db');
  await mkdir(join(process.cwd(), '.tmp'), { recursive: true });
  await rm(dbPath, { force: true });

  process.env.DATABASE_PROVIDER = 'sqlite';
  process.env.DATABASE_URL = `file:${dbPath}`;
  process.env.DB_SCHEMA_FILE = './src/config/db/schema.sqlite.ts';
  process.env.DB_SINGLETON_ENABLED = 'false';

  const client = createClient({ url: `file:${dbPath}` });
  await applyMigrationFiles(client, (file) => file < '0008_');

  const model = await client.execute(
    "select id from catalog_model where model_id = 'gpt-4o-mini' limit 1"
  );
  const status = await client.execute(
    "select id from catalog_status where slug = 'available' limit 1"
  );
  const partnerGroupId = id('legacy-partner-group');
  await client.execute({
    sql: `
      insert into catalog_group
        (id, slug, name, user_description, newapi_group, allow_create_key, sort_order, status)
      values (?, ?, ?, ?, ?, 1, 11, 'active')
    `,
    args: [
      partnerGroupId,
      'legacy-partner-conflict',
      'Legacy Partner Conflict',
      'Legacy partner route.',
      'legacy-partner-conflict',
    ],
  });
  await client.execute({
    sql: `
      insert into catalog_model_listing
        (id, model_id, group_id, status_id, input_micro_usd, output_micro_usd, smoke_tested, featured, sort_order)
      values (?, ?, ?, ?, 90000, 180000, 1, 0, 12)
    `,
    args: [
      id('legacy-listing'),
      model.rows[0].id,
      partnerGroupId,
      status.rows[0].id,
    ],
  });

  const beforeCache = await listingCache(client);
  await applyMigrationFiles(client, (file) =>
    file.startsWith('0008_model_catalog_pricing_policy')
  );
  // 当前运行时 schema 会读取 0012 新增的可空 catalog 列；本测试仍专注验证
  // 0008 回填语义，因此只补齐这些无行为影响的列，不引入 0012 的新业务表或数据。
  await client.executeMultiple(`
    ALTER TABLE catalog_model ADD max_output_tokens integer;
    ALTER TABLE catalog_model_price ADD base_cached_input_micro_usd integer;
    ALTER TABLE catalog_model_price ADD base_cache_write_5m_micro_usd integer;
    ALTER TABLE catalog_model_price ADD base_cache_write_1h_micro_usd integer;
    ALTER TABLE catalog_model_price ADD cache_price_note text;
  `);

  const { getPublicListingsUncached } = await import(
    '@/features/api-catalog/server/queries'
  );
  const publicBefore = await getPublicListingsUncached({});
  assert.ok(publicBefore.length > 0);

  const { parseCatalogPricingBackfillArgs, runCatalogPricingBackfill } =
    await import('../../scripts/backfill-catalog-pricing');
  assert.throws(
    () => parseCatalogPricingBackfillArgs(['--mode=apply']),
    /requires --yes/
  );

  const originalLog = console.log;
  const originalError = console.error;
  console.log = () => undefined;
  console.error = () => undefined;
  let result: Awaited<ReturnType<typeof runCatalogPricingBackfill>>;
  try {
    result = await runCatalogPricingBackfill(['--mode=apply', '--yes']);
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }

  assert.equal(result.target.databaseProvider, 'sqlite');
  assert.equal(result.target.databaseUrl, `file:${dbPath}`);
  assert.ok(result.report.created >= 1);
  assert.equal(
    result.report.conflicts.some(
      (conflict) => conflict.groupId === partnerGroupId
    ),
    true
  );

  const prices = await client.execute(
    'select model_id from catalog_model_price'
  );
  const modelsWithListings = await client.execute(`
    select distinct catalog_model.id
    from catalog_model
    join catalog_model_listing on catalog_model_listing.model_id = catalog_model.id
  `);
  assert.equal(prices.rows.length, modelsWithListings.rows.length);
  assert.deepEqual(await listingCache(client), beforeCache);

  const partnerListing = await client.execute({
    sql: `
      select price_policy, price_drift_status
      from catalog_model_listing
      where group_id = ?
    `,
    args: [partnerGroupId],
  });
  assert.deepEqual(partnerListing.rows[0], {
    price_policy: 'legacy_override',
    price_drift_status: 'needs_live_check',
  });

  const publicAfter = await getPublicListingsUncached({});
  assert.deepEqual(
    publicAfter.map((listing) => ({
      modelId: listing.modelId,
      groupSlug: listing.groupSlug,
      inputMicroUsd: listing.inputMicroUsd,
      outputMicroUsd: listing.outputMicroUsd,
    })),
    publicBefore.map((listing) => ({
      modelId: listing.modelId,
      groupSlug: listing.groupSlug,
      inputMicroUsd: listing.inputMicroUsd,
      outputMicroUsd: listing.outputMicroUsd,
    }))
  );
});
