import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import * as schema from '@/config/db/schema';

const DIALECT_SCHEMA_FILES = [
  'src/config/db/schema.postgres.ts',
  'src/config/db/schema.mysql.ts',
];

const CATALOG_EXPORTS = [
  'catalogVendor',
  'catalogCapability',
  'catalogStatus',
  'catalogGroup',
  'catalogModel',
  'catalogModelCategory',
  'catalogModelCapability',
  'catalogModelPrice',
  'catalogModelListing',
  'catalogPriceSyncRun',
] as const;

const schemaExports = schema as Record<string, unknown>;

test('catalog tables remain sqlite-only', async () => {
  const offenders: string[] = [];

  for (const file of DIALECT_SCHEMA_FILES) {
    const content = await readFile(join(process.cwd(), file), 'utf8');
    if (content.includes('catalog_')) {
      offenders.push(file);
    }
  }

  assert.deepEqual(offenders, []);
});

test('catalog tables are exported from the schema barrel', () => {
  for (const name of CATALOG_EXPORTS) {
    assert.ok(schemaExports[name], `${name} should be exported`);
  }
});

test('catalog model listing exposes image pricing and discount columns', () => {
  const listing = schemaExports.catalogModelListing as
    | Record<string, unknown>
    | undefined;

  assert.ok(listing);
  assert.ok(listing.imageInputMicroUsd, 'imageInputMicroUsd should exist');
  assert.ok(listing.imageOutputMicroUsd, 'imageOutputMicroUsd should exist');
  assert.ok(listing.discountRateBps, 'discountRateBps should exist');
});

test('catalog pricing policy tables and columns are exported from sqlite schema', () => {
  const group = schemaExports.catalogGroup as Record<string, unknown>;
  const listing = schemaExports.catalogModelListing as Record<string, unknown>;
  const price = schemaExports.catalogModelPrice as Record<string, unknown>;
  const syncRun = schemaExports.catalogPriceSyncRun as Record<string, unknown>;

  assert.ok(group.newapiGroupRatioDecimal);
  assert.ok(group.newapiGroupRatioBps);
  assert.ok(group.newapiGroupRatioRaw);
  assert.ok(group.pricingSyncStatus);
  assert.ok(group.pricingSyncedAt);
  assert.ok(price.pricingMode);
  assert.ok(price.syncStatus);
  assert.ok(price.driftStatus);
  assert.ok(price.baseInputMicroUsd);
  assert.ok(price.fixedPriceMicroUsd);
  assert.ok(listing.pricePolicy);
  assert.ok(listing.overrideStatus);
  assert.ok(listing.priceDriftStatus);
  assert.ok(syncRun.reportJson);
  assert.ok(syncRun.sourceFingerprint);
});

test('latest catalog pricing migration has matching journal and snapshot entries', async () => {
  const migrationsDir = join(process.cwd(), 'src/config/db/migrations_sqlite');
  const sqlFiles = await readdir(migrationsDir);
  assert.ok(
    sqlFiles.includes('0008_model_catalog_pricing_policy.sql'),
    'pricing policy SQL migration should exist'
  );

  const journal = await readFile(
    join(migrationsDir, 'meta', '_journal.json'),
    'utf8'
  );
  assert.match(journal, /0008_model_catalog_pricing_policy/);

  const snapshot = await readFile(
    join(migrationsDir, 'meta', '0008_snapshot.json'),
    'utf8'
  );
  assert.match(snapshot, /catalog_model_price/);
  assert.match(snapshot, /catalog_price_sync_run/);
  assert.match(snapshot, /price_policy/);
});

test('newApiKeyBinding exposes the catalog group foreign key column', () => {
  const newApiKeyBinding = schemaExports.newApiKeyBinding as
    | Record<string, unknown>
    | undefined;

  assert.ok(newApiKeyBinding);
  assert.ok(newApiKeyBinding.groupId, 'newApiKeyBinding.groupId should exist');
});
