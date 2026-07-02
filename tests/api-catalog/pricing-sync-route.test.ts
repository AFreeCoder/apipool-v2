import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { createClient } from '@libsql/client';
import { eq } from 'drizzle-orm';

let modules: any;

async function setupDb() {
  const dbPath = join(process.cwd(), '.tmp', 'pricing-sync-route.db');
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
  const pricingSyncRoute = await import(
    '@/app/api/apipool/admin/catalog/pricing/sync/route'
  );
  const pricingDriftRoute = await import(
    '@/app/api/apipool/admin/catalog/pricing/drift/route'
  );

  modules = {
    db,
    initCatalog,
    pricingDriftRoute,
    pricingSyncRoute,
    schema,
  };

  await modules.initCatalog();
}

test.before(setupDb);

test.afterEach(() => {
  modules?.pricingSyncRoute.__resetCatalogPricingSyncRouteDepsForTest();
  modules?.pricingDriftRoute.__resetCatalogPricingDriftRouteDepsForTest();
});

test('admin pricing sync and drift routes run success path without leaking sensitive fields', async () => {
  const {
    catalogGroup,
    catalogModel,
    catalogModelPrice,
    catalogPriceSyncRun,
  } = modules.schema;
  const operator = { id: 'operator-route' };
  const hasPermissionForUser = async () => true;

  modules.pricingSyncRoute.__setCatalogPricingSyncRouteDepsForTest({
    getOperator: async () => operator,
    hasPermissionForUser,
    getPricingSnapshot: async () => ({
      models: [
        {
          modelId: 'gpt-4o-mini',
          displayName: 'GPT-4o mini',
          vendorId: 'openai',
          vendorName: 'OpenAI',
          quotaType: 0,
          modelRatio: 0.075,
          modelPrice: null,
          completionRatio: 4,
          imageRatio: null,
          source: 'ratio',
          inputMicroUsd: 150000,
          outputMicroUsd: 600000,
          imageInputMicroUsd: null,
          imageOutputMicroUsd: null,
          enabledGroups: ['official'],
          supportedEndpointTypes: ['responses'],
        },
      ],
      vendors: { openai: 'OpenAI' },
      groupRatios: {
        official: {
          raw: '0.5',
          decimal: '0.5',
          bps: 5000,
          sourceKey: 'group_ratio',
        },
      },
      usableGroups: ['official'],
      sourceFingerprint: 'route-fingerprint',
    }),
    revalidate: () => undefined,
  });

  const syncResponse = await modules.pricingSyncRoute.POST();
  const syncPayload = await syncResponse.json();
  assert.equal(syncPayload.code, 0);
  assert.equal(syncPayload.data.status, 'success');
  assert.equal(syncPayload.data.remoteModelCount, 1);

  const [model] = await modules
    .db()
    .select()
    .from(catalogModel)
    .where(eq(catalogModel.modelId, 'gpt-4o-mini'))
    .limit(1);
  const [price] = await modules
    .db()
    .select()
    .from(catalogModelPrice)
    .where(eq(catalogModelPrice.modelId, model.id))
    .limit(1);
  assert.equal(price.baseInputMicroUsd, 150000);
  assert.equal(price.sourceFingerprint, 'route-fingerprint');

  const [group] = await modules
    .db()
    .select()
    .from(catalogGroup)
    .where(eq(catalogGroup.slug, 'official'))
    .limit(1);
  assert.equal(group.newapiGroupRatioBps, 5000);

  const [run] = await modules
    .db()
    .select()
    .from(catalogPriceSyncRun)
    .where(eq(catalogPriceSyncRun.id, syncPayload.data.syncRunId))
    .limit(1);
  assert.equal(run.sourceFingerprint, 'route-fingerprint');
  assert.match(run.reportJson, /official/);

  modules.pricingDriftRoute.__setCatalogPricingDriftRouteDepsForTest({
    getOperator: async () => operator,
    hasPermissionForUser,
  });
  const driftResponse = await modules.pricingDriftRoute.GET();
  const driftPayload = await driftResponse.json();
  assert.equal(driftPayload.code, 0);
  assert.equal(driftPayload.data.latestRun.id, syncPayload.data.syncRunId);
  assert.equal(driftPayload.data.latestRun.sourceFingerprint, 'route-fingerprint');

  const serialized = JSON.stringify({ syncPayload, driftPayload });
  assert.equal(serialized.includes('admin-token'), false);
  assert.equal(serialized.includes('Bearer '), false);
  assert.equal(serialized.includes('newapi-internal'), false);
  assert.equal(serialized.includes('http://'), false);
});
