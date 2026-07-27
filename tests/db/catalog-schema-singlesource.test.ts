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
  'catalogModelPricingProfile',
  'catalogModelPricingRate',
  'catalogModelPrice',
  'catalogModelPriceTier',
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

test('模型售卖项同时拥有定价档案、折扣和 New API 分组映射', () => {
  const listing = schemaExports.catalogModelListing as
    | Record<string, unknown>
    | undefined;

  assert.ok(listing);
  assert.ok(listing.pricingProfileId, 'pricingProfileId should exist');
  assert.ok(listing.discountRateBps, 'discountRateBps should exist');
  assert.ok(listing.newapiGroup, 'newapiGroup should exist on each listing');
});

test('catalog cost reference and sale pricing profile columns are exported', () => {
  const listing = schemaExports.catalogModelListing as Record<string, unknown>;
  const profile = schemaExports.catalogModelPricingProfile as Record<
    string,
    unknown
  >;
  const rate = schemaExports.catalogModelPricingRate as Record<string, unknown>;
  const price = schemaExports.catalogModelPrice as Record<string, unknown>;
  const tier = schemaExports.catalogModelPriceTier as Record<string, unknown>;
  const syncRun = schemaExports.catalogPriceSyncRun as Record<string, unknown>;
  const usageLog = schemaExports.usageLogSnapshot as Record<string, unknown>;
  const priceVersion = schemaExports.modelPriceVersion as Record<
    string,
    unknown
  >;
  const requestLedger = schemaExports.requestLedger as Record<string, unknown>;

  assert.ok(profile.modelId);
  assert.ok(profile.pricingBasis);
  assert.ok(profile.quantityMeter);
  assert.ok(profile.skuRuleSource);
  assert.ok(profile.skuRuleAstJson);
  assert.ok(profile.ruleHash);
  assert.ok(rate.profileId);
  assert.ok(rate.meterKey);
  assert.ok(rate.skuKey);
  assert.ok(rate.unitSize);
  assert.ok(rate.priceMicroUsd);
  assert.ok(price.pricingMode);
  assert.ok(price.billingScheme);
  assert.ok(price.baseCacheWriteMicroUsd);
  assert.ok(price.baseCachedImageInputMicroUsd);
  assert.ok(price.baseWebSearchMicroUsd);
  assert.ok(price.longContextThresholdTokens);
  assert.ok(price.baseInputLongMicroUsd);
  assert.ok(price.baseCachedInputLongMicroUsd);
  assert.ok(price.baseCacheWriteLongMicroUsd);
  assert.ok(price.baseOutputLongMicroUsd);
  assert.ok(price.billingCapabilitiesJson);
  assert.ok(price.syncStatus);
  assert.ok(price.driftStatus);
  assert.ok(price.baseInputMicroUsd);
  assert.ok(price.fixedPriceMicroUsd);
  assert.ok(tier.modelId);
  assert.ok(tier.skuKey);
  assert.ok(tier.priceMicroUsd);
  assert.ok(listing.pricingProfileId);
  assert.ok(listing.allowLongContext);
  assert.ok(listing.newapiGroup);
  assert.equal(Boolean(listing.pricePolicy), false);
  assert.equal(Boolean(listing.overrideStatus), false);
  assert.ok(listing.priceDriftStatus);
  assert.ok(syncRun.reportJson);
  assert.ok(syncRun.sourceFingerprint);
  assert.ok(usageLog.cacheTokens);
  assert.ok(usageLog.cacheRatio);
  assert.ok(usageLog.cacheCreationTokens);
  assert.ok(usageLog.cacheCreationRatio);
  assert.ok(usageLog.usageSemantic);
  assert.ok(priceVersion.pricingSpecJson);
  assert.ok(priceVersion.pricingProfileId);
  assert.ok(priceVersion.pricingProfileRuleHash);
  assert.ok(priceVersion.admissionLongContextThresholdTokens);
  assert.ok(priceVersion.allowLongContext);
  assert.ok(requestLedger.pricingBasis);
  assert.ok(requestLedger.quantityMeter);
});

test('latest sqlite migration has matching journal and snapshot entries', async () => {
  const migrationsDir = join(process.cwd(), 'src/config/db/migrations_sqlite');
  const sqlFiles = await readdir(migrationsDir);

  const journal = JSON.parse(
    await readFile(join(migrationsDir, 'meta', '_journal.json'), 'utf8')
  ) as { entries: Array<{ idx: number; tag: string }> };
  const latest = journal.entries.at(-1);
  assert.ok(latest, 'migration journal should have entries');

  assert.ok(
    sqlFiles.includes(`${latest.tag}.sql`),
    `latest SQL migration ${latest.tag}.sql should exist`
  );

  const snapshotName = `${String(latest.idx).padStart(4, '0')}_snapshot.json`;
  const snapshot = await readFile(
    join(migrationsDir, 'meta', snapshotName),
    'utf8'
  );
  assert.match(snapshot, /usage_log_snapshot/);
  assert.match(snapshot, /cache_tokens/);
  assert.match(snapshot, /cache_ratio/);
  assert.match(snapshot, /cache_creation_tokens/);
  assert.match(snapshot, /cache_creation_ratio/);
  assert.match(snapshot, /usage_semantic/);
  assert.match(snapshot, /catalog_model_pricing_profile/);
  assert.match(snapshot, /catalog_model_pricing_rate/);
  assert.match(snapshot, /pricing_profile_id/);
  assert.match(snapshot, /pricing_spec_json/);
  assert.match(snapshot, /pricing_basis/);
  assert.match(snapshot, /quantity_meter/);
  assert.match(snapshot, /admission_long_context_threshold_tokens/);
  assert.match(snapshot, /allow_long_context/);

  const legacyPricingJournal = await readFile(
    join(migrationsDir, 'meta', '_journal.json'),
    'utf8'
  );
  assert.match(legacyPricingJournal, /0008_model_catalog_pricing_policy/);

  const pricingSnapshot = await readFile(
    join(migrationsDir, 'meta', '0008_snapshot.json'),
    'utf8'
  );
  assert.match(pricingSnapshot, /catalog_model_price/);
  assert.match(pricingSnapshot, /catalog_price_sync_run/);
  assert.match(pricingSnapshot, /price_policy/);
});

test('newApiKeyBinding exposes the catalog group foreign key column', () => {
  const newApiKeyBinding = schemaExports.newApiKeyBinding as
    | Record<string, unknown>
    | undefined;

  assert.ok(newApiKeyBinding);
  assert.ok(newApiKeyBinding.groupId, 'newApiKeyBinding.groupId should exist');
});
