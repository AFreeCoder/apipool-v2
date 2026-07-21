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
    ALTER TABLE catalog_model_price ADD billing_scheme text NOT NULL DEFAULT 'token';
    ALTER TABLE catalog_model_price ADD base_cache_write_micro_usd integer;
    ALTER TABLE catalog_model_price ADD base_cached_image_input_micro_usd integer;
    ALTER TABLE catalog_model_price ADD base_web_search_micro_usd integer;
    ALTER TABLE catalog_model_price ADD long_context_threshold_tokens integer;
    ALTER TABLE catalog_model_price ADD base_input_long_micro_usd integer;
    ALTER TABLE catalog_model_price ADD base_cached_input_long_micro_usd integer;
    ALTER TABLE catalog_model_price ADD base_cache_write_long_micro_usd integer;
    ALTER TABLE catalog_model_price ADD base_output_long_micro_usd integer;
    ALTER TABLE catalog_model_price ADD billing_capabilities_json text;
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
      select price_drift_status
      from catalog_model_listing
      where group_id = ?
    `,
    args: [partnerGroupId],
  });
  assert.deepEqual(partnerListing.rows[0], {
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

test('0014 migration maps legacy fixed price to per_call default tier', async () => {
  const dbPath = join(process.cwd(), '.tmp', 'catalog-pricing-v2-migration.db');
  await mkdir(join(process.cwd(), '.tmp'), { recursive: true });
  await rm(dbPath, { force: true });
  const client = createClient({ url: `file:${dbPath}` });
  await applyMigrationFiles(client, (file) => file < '0014_');

  const vendor = await client.execute(
    `SELECT id FROM catalog_vendor ORDER BY id LIMIT 1`
  );
  assert.equal(vendor.rows.length, 1);
  await client.execute({
    sql: `INSERT INTO catalog_model (id, model_id, display_name, vendor_id, category)
          VALUES ('fixed-model-pk', 'fixed-model', 'Fixed Model', ?, 'image')`,
    args: [vendor.rows[0].id],
  });
  await client.execute(`
    INSERT INTO catalog_model_price (
      id, model_id, pricing_mode, fixed_price_micro_usd, fixed_price_unit
    ) VALUES (
      'fixed-price-pk', 'fixed-model-pk', 'fixed_price', 40000, 'per_call'
    )
  `);

  const dir = join(process.cwd(), 'src/config/db/migrations_sqlite');
  const migration = (await readdir(dir)).find((file) => file.startsWith('0014_'));
  assert.ok(migration, '0014 迁移文件存在');
  await client.executeMultiple(await readFile(join(dir, migration), 'utf8'));

  const price = await client.execute(
    `SELECT billing_scheme FROM catalog_model_price WHERE id='fixed-price-pk'`
  );
  assert.equal(price.rows[0].billing_scheme, 'per_call');
  const tier = await client.execute(
    `SELECT sku_key, price_micro_usd FROM catalog_model_price_tier WHERE model_id='fixed-model-pk'`
  );
  assert.deepEqual(tier.rows[0], {
    sku_key: 'default',
    price_micro_usd: 40000,
  });

  const listingColumns = (
    await client.execute(`PRAGMA table_info(catalog_model_listing)`)
  ).rows.map((row: any) => String(row.name));
  assert.ok(listingColumns.includes('allow_long_context'));
  assert.equal(listingColumns.includes('price_policy'), false);
  assert.equal(listingColumns.includes('override_status'), false);

  const { computePerCallChargeMicroUsd } = await import(
    '@/features/gateway/lib/billing'
  );
  assert.equal(
    computePerCallChargeMicroUsd(2, Number(tier.rows[0].price_micro_usd)),
    BigInt(80_000)
  );
  client.close();
});

test('0014 migration rejects an unmappable fixed_price_unit', async () => {
  const dbPath = join(process.cwd(), '.tmp', 'catalog-pricing-v2-invalid.db');
  await mkdir(join(process.cwd(), '.tmp'), { recursive: true });
  await rm(dbPath, { force: true });
  const client = createClient({ url: `file:${dbPath}` });
  await applyMigrationFiles(client, (file) => file < '0014_');

  const vendor = await client.execute(
    `SELECT id FROM catalog_vendor ORDER BY id LIMIT 1`
  );
  await client.execute({
    sql: `INSERT INTO catalog_model (id, model_id, display_name, vendor_id, category)
          VALUES ('invalid-fixed-model-pk', 'invalid-fixed-model', 'Invalid Fixed Model', ?, 'image')`,
    args: [vendor.rows[0].id],
  });
  await client.execute(`
    INSERT INTO catalog_model_price (
      id, model_id, pricing_mode, fixed_price_micro_usd, fixed_price_unit
    ) VALUES (
      'invalid-fixed-price-pk', 'invalid-fixed-model-pk', 'fixed_price', 40000, 'unknown'
    )
  `);
  const dir = join(process.cwd(), 'src/config/db/migrations_sqlite');
  const migration = (await readdir(dir)).find((file) => file.startsWith('0014_'));
  assert.ok(migration, '0014 迁移文件存在');
  await assert.rejects(
    client.executeMultiple(await readFile(join(dir, migration), 'utf8')),
    /CHECK|constraint/i
  );
  client.close();
});
