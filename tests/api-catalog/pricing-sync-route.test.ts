import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { createClient } from '@libsql/client';
import { eq, ne } from 'drizzle-orm';

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
  // 本文件只验证 gpt-4o-mini 的成本同步路由；其余生产种子由
  // init-catalog 专项测试覆盖，避免未放入模拟快照的模型制造无关 partial。
  await modules
    .db()
    .delete(modules.schema.catalogModel)
    .where(ne(modules.schema.catalogModel.modelId, 'gpt-4o-mini'));
  await modules
    .db()
    .update(modules.schema.catalogModelListing)
    .set({ newapiGroup: 'official' });
  await modules
    .db()
    .update(modules.schema.catalogGroup)
    .set({ newapiGroup: 'legacy-wrong-group' });
}

test.before(setupDb);

test.afterEach(() => {
  modules?.pricingSyncRoute.__resetCatalogPricingSyncRouteDepsForTest();
  modules?.pricingDriftRoute.__resetCatalogPricingDriftRouteDepsForTest();
});

test('admin pricing sync and drift routes run success path without leaking sensitive fields', async () => {
  const {
    catalogModel,
    catalogModelListing,
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
  assert.equal(price.source, 'newapi');
  assert.equal(price.syncStatus, 'reference_current');
  assert.equal(price.driftStatus, 'ok');
  assert.equal(price.sourceFingerprint, 'route-fingerprint');

  const [listing] = await modules
    .db()
    .select()
    .from(catalogModelListing)
    .where(eq(catalogModelListing.modelId, model.id))
    .limit(1);
  assert.equal(listing.newapiGroup, 'official');
  assert.equal(listing.priceDriftStatus, 'unknown');

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
  assert.equal(
    driftPayload.data.latestRun.sourceFingerprint,
    'route-fingerprint'
  );

  const serialized = JSON.stringify({ syncPayload, driftPayload });
  assert.equal(serialized.includes('admin-token'), false);
  assert.equal(serialized.includes('Bearer '), false);
  assert.equal(serialized.includes('newapi-internal'), false);
  assert.equal(serialized.includes('http://'), false);
});

test('admin pricing sync route records sanitized failed run when New API snapshot fails', async () => {
  const { catalogPriceSyncRun } = modules.schema;
  const operator = { id: 'operator-route-failure' };

  modules.pricingSyncRoute.__setCatalogPricingSyncRouteDepsForTest({
    getOperator: async () => operator,
    hasPermissionForUser: async () => true,
    getPricingSnapshot: async () => {
      throw new Error(
        'GET http://newapi-internal.local/api/pricing failed Bearer admin-token'
      );
    },
    revalidate: () => {
      throw new Error('revalidate should not run after sync failure');
    },
  });

  const response = await modules.pricingSyncRoute.POST();
  const payload = await response.json();
  assert.notEqual(payload.code, 0);
  assert.equal(payload.message, 'Model pricing sync is unavailable');
  assert.equal(JSON.stringify(payload).includes('admin-token'), false);
  assert.equal(JSON.stringify(payload).includes('http://'), false);

  const runs = await modules
    .db()
    .select()
    .from(catalogPriceSyncRun)
    .where(eq(catalogPriceSyncRun.operatorUserId, operator.id));

  assert.equal(runs.length, 1);
  assert.equal(runs[0].status, 'failed');
  assert.equal(runs[0].errorMessage.includes('admin-token'), false);
  assert.equal(runs[0].errorMessage.includes('http://'), false);
  assert.match(runs[0].errorMessage, /Bearer \[redacted\]/);
  assert.match(runs[0].reportJson, /redacted/);
});
