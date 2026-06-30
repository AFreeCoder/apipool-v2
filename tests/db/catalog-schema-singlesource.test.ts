import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
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
  'catalogModelListing',
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

test('newApiKeyBinding exposes the catalog group foreign key column', () => {
  const newApiKeyBinding = schemaExports.newApiKeyBinding as
    | Record<string, unknown>
    | undefined;

  assert.ok(newApiKeyBinding);
  assert.ok(newApiKeyBinding.groupId, 'newApiKeyBinding.groupId should exist');
});
