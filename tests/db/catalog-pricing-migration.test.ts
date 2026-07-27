import assert from 'node:assert/strict';
import { copyFile, mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { createClient } from '@libsql/client';

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

test('0018 migration atomically converts token and image per-call sale prices into listing-selected profiles', async () => {
  const dbPath = join(process.cwd(), '.tmp', 'catalog-pricing-v3-migration.db');
  await mkdir(join(process.cwd(), '.tmp'), { recursive: true });
  await rm(dbPath, { force: true });
  const client = createClient({ url: `file:${dbPath}` });
  await applyMigrationFiles(client, (file) => file < '0018_');

  const vendor = await client.execute(
    `SELECT id FROM catalog_vendor ORDER BY id LIMIT 1`
  );
  const status = await client.execute(
    `SELECT id FROM catalog_status WHERE slug='available' LIMIT 1`
  );
  const official = await client.execute(
    `SELECT id FROM catalog_group WHERE slug='official' LIMIT 1`
  );
  const textModel = await client.execute(
    `SELECT id FROM catalog_model WHERE model_id='gpt-4o-mini' LIMIT 1`
  );
  assert.equal(textModel.rows.length, 1);
  await client.execute({
    sql: `INSERT INTO catalog_model_price (
      id, model_id, billing_scheme, pricing_mode, base_input_micro_usd,
      base_output_micro_usd, reviewed_at
    ) VALUES ('legacy-text-price', ?, 'token', 'manual_token', 150000, 600000, ?)`,
    args: [textModel.rows[0].id, Date.now()],
  });

  await client.execute({
    sql: `INSERT INTO catalog_model (
      id, model_id, display_name, vendor_id, category
    ) VALUES ('legacy-image-model', 'legacy-image', 'Legacy Image', ?, 'image')`,
    args: [vendor.rows[0].id],
  });
  await client.execute(`
    INSERT INTO catalog_model_price (
      id, model_id, billing_scheme, pricing_mode, fixed_price_micro_usd,
      fixed_price_unit, reviewed_at
    ) VALUES (
      'legacy-image-price', 'legacy-image-model', 'per_call', 'fixed_price',
      40000, 'per_call', ${Date.now()}
    )
  `);
  await client.execute(`
    INSERT INTO catalog_model_price_tier
      (id, model_id, sku_key, price_micro_usd)
    VALUES
      ('legacy-image-default', 'legacy-image-model', 'default', 40000),
      ('legacy-image-hd', 'legacy-image-model', 'quality=high;size=1024x1024', 80000)
  `);
  await client.execute({
    sql: `INSERT INTO catalog_model_listing (
      id, model_id, group_id, status_id, newapi_group,
      input_micro_usd, output_micro_usd, sort_order
    ) VALUES (
      'legacy-image-listing', 'legacy-image-model', ?, ?, 'official',
      0, 0, 20
    )`,
    args: [official.rows[0].id, status.rows[0].id],
  });

  const migrationDir = join(process.cwd(), 'src/config/db/migrations_sqlite');
  const migration = (await readdir(migrationDir)).find((file) =>
    file.startsWith('0018_')
  );
  assert.ok(migration, '0018 迁移文件存在');
  await client.executeMultiple(
    await readFile(join(migrationDir, migration), 'utf8')
  );

  const profiles = await client.execute(`
    SELECT model_id, pricing_basis, quantity_meter, sku_rule_ast_json, rule_hash
    FROM catalog_model_pricing_profile
    ORDER BY model_id
  `);
  assert.equal(profiles.rows.length, 2);
  assert.deepEqual(profiles.rows[0], {
    model_id: 'legacy-image-model',
    pricing_basis: 'unit',
    quantity_meter: 'output_count',
    sku_rule_ast_json:
      '{"version":1,"rules":[{"conditions":[{"field":"quality","operator":"missing"}],"output":{"type":"sku","template":"default"}},{"conditions":[{"field":"quality","operator":"eq","value":"auto"}],"output":{"type":"sku","template":"default"}},{"conditions":[{"field":"size","operator":"missing"}],"output":{"type":"sku","template":"default"}},{"conditions":[{"field":"size","operator":"eq","value":"auto"}],"output":{"type":"sku","template":"default"}}],"fallback":{"type":"sku","template":"quality=${quality};size=${size}"}}',
    rule_hash:
      '484c5ba37b638c11e514b984a3d1754f4a1f7bcda134ecdd53988d14d4f00592',
  });
  assert.equal(profiles.rows[1].model_id, textModel.rows[0].id);
  assert.equal(profiles.rows[1].pricing_basis, 'token');
  assert.equal(profiles.rows[1].quantity_meter, null);
  assert.equal(profiles.rows[1].rule_hash, null);

  const rates = await client.execute(`
    SELECT profile_id, meter_key, sku_key, unit_size, price_micro_usd
    FROM catalog_model_pricing_rate
    ORDER BY profile_id, meter_key, sku_key
  `);
  assert.equal(rates.rows.length, 4);
  assert.equal(
    rates.rows.some(
      (row) =>
        row.profile_id === 'migrated-profile-legacy-image-model' &&
        row.meter_key === 'output_count' &&
        row.sku_key === 'quality=high;size=1024x1024' &&
        row.unit_size === 1 &&
        row.price_micro_usd === 80000
    ),
    true
  );

  const listings = await client.execute(`
    SELECT model_id, pricing_profile_id, input_micro_usd, output_micro_usd
    FROM catalog_model_listing
    WHERE model_id IN ('legacy-image-model', '${String(textModel.rows[0].id)}')
    ORDER BY model_id
  `);
  assert.equal(listings.rows.length, 2);
  assert.equal(
    listings.rows.every(
      (row) => row.pricing_profile_id === `migrated-profile-${row.model_id}`
    ),
    true
  );
  assert.equal(
    listings.rows.find((row) => row.model_id === 'legacy-image-model')
      ?.input_micro_usd,
    0
  );

  const integrity = await client.execute(`PRAGMA integrity_check`);
  assert.equal(integrity.rows[0].integrity_check, 'ok');
  const foreignKeys = await client.execute(`PRAGMA foreign_key_check`);
  assert.equal(foreignKeys.rows.length, 0);
  client.close();
});

test('0014 migration maps legacy fixed price to per_call default tier', async () => {
  const dbPath = join(process.cwd(), '.tmp', 'catalog-pricing-v2-migration.db');
  const backupPath = `${dbPath}.backup`;
  await mkdir(join(process.cwd(), '.tmp'), { recursive: true });
  await rm(dbPath, { force: true });
  await rm(backupPath, { force: true });
  let client = createClient({ url: `file:${dbPath}` });
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
  const migration = (await readdir(dir)).find((file) =>
    file.startsWith('0014_')
  );
  assert.ok(migration, '0014 迁移文件存在');
  client.close();
  await copyFile(dbPath, backupPath);
  client = createClient({ url: `file:${dbPath}` });
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
  const integrity = await client.execute(`PRAGMA integrity_check`);
  assert.equal(integrity.rows[0].integrity_check, 'ok');
  const foreignKeys = await client.execute(`PRAGMA foreign_key_check`);
  assert.equal(foreignKeys.rows.length, 0);
  client.close();

  const backup = createClient({ url: `file:${backupPath}` });
  const backupTierTable = await backup.execute(
    `SELECT name FROM sqlite_master WHERE type='table' AND name='catalog_model_price_tier'`
  );
  assert.equal(backupTierTable.rows.length, 0, '迁移前备份保持可独立恢复');
  backup.close();
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
  const migration = (await readdir(dir)).find((file) =>
    file.startsWith('0014_')
  );
  assert.ok(migration, '0014 迁移文件存在');
  await assert.rejects(
    client.executeMultiple(await readFile(join(dir, migration), 'utf8')),
    /CHECK|constraint/i
  );
  client.close();
});
