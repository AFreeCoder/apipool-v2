import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { createClient } from '@libsql/client';
import { and, eq } from 'drizzle-orm';

let modules: any;
let sequence = 0;

const BASE_PRICE = {
  inputMicroUsdPerM: 120,
  cachedInputMicroUsdPerM: 60,
  cacheWrite5mMicroUsdPerM: 150,
  cacheWrite1hMicroUsdPerM: 240,
  outputMicroUsdPerM: 240,
};

function nextId(prefix: string) {
  sequence += 1;
  return `${prefix}-${sequence}`;
}

async function setupDb() {
  const dbPath = join(process.cwd(), '.tmp', 'routing-admin-publish.db');
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
  const routeService = await import(
    '@/features/routing-admin/server/route-service'
  );
  const worstCase = await import('@/features/routing-admin/server/worst-case');
  modules = { db, routeService, schema, worstCase };

  await db().insert(schema.catalogVendor).values({
    id: 'routing-admin-vendor',
    slug: 'routing-admin-vendor',
    name: 'Routing Admin Vendor',
  });
  await db().insert(schema.catalogStatus).values({
    id: 'routing-admin-status',
    slug: 'routing-admin-ready',
    name: 'Ready',
    isCallable: true,
  });
}

test.before(setupDb);

type FixtureOptions = {
  groupSyncStatus?: string;
  groupNewapiGroup?: string;
  priceSyncStatus?: string;
  reviewedAt?: Date | null;
  endpoints?: string[];
  cacheBaseMissing?: boolean;
  contextWindow?: number | null;
  maxOutputTokens?: number | null;
  withPrice?: boolean;
  withRoute?: boolean;
  routeGroup?: string;
  priceRefGroup?: string | null;
};

async function seedFixture(options: FixtureOptions = {}) {
  const suffix = nextId('fixture');
  const ids = {
    group: `group-${suffix}`,
    modelPk: `model-pk-${suffix}`,
    modelId: `model-${suffix}`,
    listing: `listing-${suffix}`,
    basePrice: `base-price-${suffix}`,
    route: `route-${suffix}`,
    price: `price-${suffix}`,
  };
  const newapiGroup = options.groupNewapiGroup ?? 'official';
  const routeGroup = options.routeGroup ?? newapiGroup;
  const priceRefGroup = options.priceRefGroup ?? routeGroup;

  await modules
    .db()
    .insert(modules.schema.catalogGroup)
    .values({
      id: ids.group,
      slug: ids.group,
      name: ids.group,
      newapiGroup,
      pricingSyncStatus: options.groupSyncStatus ?? 'synced',
    });
  await modules
    .db()
    .insert(modules.schema.catalogModel)
    .values({
      id: ids.modelPk,
      modelId: ids.modelId,
      displayName: ids.modelId,
      vendorId: 'routing-admin-vendor',
      contextWindow:
        options.contextWindow === undefined ? 1_000 : options.contextWindow,
      maxOutputTokens:
        options.maxOutputTokens === undefined ? 100 : options.maxOutputTokens,
    });
  await modules.db().insert(modules.schema.catalogModelListing).values({
    id: ids.listing,
    modelId: ids.modelPk,
    groupId: ids.group,
    statusId: 'routing-admin-status',
    inputMicroUsd: 1,
    outputMicroUsd: 2,
  });
  await modules
    .db()
    .insert(modules.schema.catalogModelPrice)
    .values({
      id: ids.basePrice,
      modelId: ids.modelPk,
      syncStatus: options.priceSyncStatus ?? 'synced',
      reviewedAt: options.reviewedAt ?? null,
      sourceSupportedEndpointTypes: JSON.stringify(
        options.endpoints ?? ['chat']
      ),
      baseInputMicroUsd: 100,
      baseOutputMicroUsd: 200,
      baseCachedInputMicroUsd: options.cacheBaseMissing ? null : 50,
      baseCacheWrite5mMicroUsd: options.cacheBaseMissing ? null : 125,
      baseCacheWrite1hMicroUsd: options.cacheBaseMissing ? null : 200,
    });
  if (options.withPrice !== false) {
    await modules
      .db()
      .insert(modules.schema.modelPriceVersion)
      .values({
        id: ids.price,
        portalGroupId: ids.group,
        portalModelId: ids.modelId,
        version: 1,
        status: 'active',
        ...BASE_PRICE,
        newapiRefInputMicroUsdPerM: 120,
        newapiRefCachedInputMicroUsdPerM: 60,
        newapiRefCacheWrite5mMicroUsdPerM: 150,
        newapiRefCacheWrite1hMicroUsdPerM: 240,
        newapiRefOutputMicroUsdPerM: 240,
        refNewapiGroup: priceRefGroup,
        publishedBy: 'seed',
      });
  }
  if (options.withRoute) {
    await modules.db().insert(modules.schema.modelRoute).values({
      id: ids.route,
      portalGroupId: ids.group,
      portalModelId: ids.modelId,
      newapiGroup: routeGroup,
      newapiModelId: ids.modelId,
      version: 1,
      status: 'active',
      publishedBy: 'seed',
    });
  }
  return ids;
}

function snapshotDeps(
  ratios: Record<string, number> = { official: 12_000 },
  usableGroups = Object.keys(ratios)
) {
  return {
    getPricingSnapshot: async () => ({
      models: [],
      vendors: {},
      groupRatios: Object.fromEntries(
        Object.entries(ratios).map(([group, bps]) => [
          group,
          { raw: String(bps), decimal: String(bps / 10_000), bps },
        ])
      ),
      usableGroups,
      sourceFingerprint: 'test',
    }),
    revalidate: () => undefined,
  };
}

async function rowsFor(table: any, groupId: string, modelId: string) {
  return modules
    .db()
    .select()
    .from(table)
    .where(
      and(eq(table.portalGroupId, groupId), eq(table.portalModelId, modelId))
    );
}

test('价格发布：五维门禁、ref 快照、listing、审计原子闭合', async () => {
  const ids = await seedFixture({ withRoute: true });
  const result = await modules.routeService.publishPriceVersion(
    {
      portalGroupId: ids.group,
      portalModelId: ids.modelId,
      price: BASE_PRICE,
      sourceNote: '管理员复核',
      operatorUserId: 'operator-1',
    },
    snapshotDeps()
  );

  assert.deepEqual(result, { ok: true, version: 2 });
  const versions = await rowsFor(
    modules.schema.modelPriceVersion,
    ids.group,
    ids.modelId
  );
  assert.equal(
    versions.find((row: any) => row.version === 1)?.status,
    'retired'
  );
  const active = versions.find((row: any) => row.status === 'active');
  assert.deepEqual(
    {
      input: active.newapiRefInputMicroUsdPerM,
      cached: active.newapiRefCachedInputMicroUsdPerM,
      write5m: active.newapiRefCacheWrite5mMicroUsdPerM,
      write1h: active.newapiRefCacheWrite1hMicroUsdPerM,
      output: active.newapiRefOutputMicroUsdPerM,
      group: active.refNewapiGroup,
    },
    {
      input: 120,
      cached: 60,
      write5m: 150,
      write1h: 240,
      output: 240,
      group: 'official',
    }
  );
  const [listing] = await modules
    .db()
    .select()
    .from(modules.schema.catalogModelListing)
    .where(eq(modules.schema.catalogModelListing.id, ids.listing));
  assert.equal(listing.inputMicroUsd, BASE_PRICE.inputMicroUsdPerM);
  assert.equal(listing.outputMicroUsd, BASE_PRICE.outputMicroUsdPerM);
  const audits = await modules
    .db()
    .select()
    .from(modules.schema.portalAdminAuditLog);
  assert.equal(
    audits.filter((row: any) => row.targetId === `${ids.group}:${ids.modelId}`)
      .length,
    1
  );
  assert.equal(audits.at(-1).action, 'price.publish');
});

test('ref 快照不可变：catalog cache 基准价漂移不改历史版本', async () => {
  const ids = await seedFixture({ withRoute: true });
  await modules.routeService.publishPriceVersion(
    {
      portalGroupId: ids.group,
      portalModelId: ids.modelId,
      price: BASE_PRICE,
      operatorUserId: 'operator-2',
    },
    snapshotDeps()
  );
  const [before] = await modules
    .db()
    .select()
    .from(modules.schema.modelPriceVersion)
    .where(
      and(
        eq(modules.schema.modelPriceVersion.portalGroupId, ids.group),
        eq(modules.schema.modelPriceVersion.version, 2)
      )
    );
  await modules
    .db()
    .update(modules.schema.catalogModelPrice)
    .set({
      baseCachedInputMicroUsd: 9_999,
      baseCacheWrite5mMicroUsd: 9_999,
      baseCacheWrite1hMicroUsd: 9_999,
    })
    .where(eq(modules.schema.catalogModelPrice.id, ids.basePrice));
  const [after] = await modules
    .db()
    .select()
    .from(modules.schema.modelPriceVersion)
    .where(eq(modules.schema.modelPriceVersion.id, before.id));
  assert.deepEqual(
    [
      after.newapiRefCachedInputMicroUsdPerM,
      after.newapiRefCacheWrite5mMicroUsdPerM,
      after.newapiRefCacheWrite1hMicroUsdPerM,
    ],
    [60, 150, 240]
  );
});

test('方向校验拒绝 input 比成本参照低 1 micro', async () => {
  const ids = await seedFixture({ withRoute: true });
  const result = await modules.routeService.publishPriceVersion(
    {
      portalGroupId: ids.group,
      portalModelId: ids.modelId,
      price: { ...BASE_PRICE, inputMicroUsdPerM: 119 },
      operatorUserId: 'operator-3',
    },
    snapshotDeps()
  );
  assert.equal(result.ok, false);
  assert.ok(
    result.failures.some((failure: any) => failure.check === 'direction:input')
  );
  assert.equal(
    (await rowsFor(modules.schema.modelPriceVersion, ids.group, ids.modelId))
      .length,
    1
  );
});

test('cache 基准价缺失时拒绝发布', async () => {
  const ids = await seedFixture({ cacheBaseMissing: true, withRoute: true });
  const result = await modules.routeService.publishPriceVersion(
    {
      portalGroupId: ids.group,
      portalModelId: ids.modelId,
      price: BASE_PRICE,
      operatorUserId: 'operator-4',
    },
    snapshotDeps()
  );
  assert.equal(result.ok, false);
  assert.ok(
    result.failures.some((failure: any) => failure.check === 'cache_reference')
  );
});

test('group 未 synced 与 manual 未 review 均拒绝', async () => {
  const groupBad = await seedFixture({
    groupSyncStatus: 'unknown',
    withRoute: true,
  });
  const manualBad = await seedFixture({
    priceSyncStatus: 'manual',
    reviewedAt: null,
    withRoute: true,
  });
  const [groupResult, manualResult] = await Promise.all([
    modules.routeService.publishPriceVersion(
      {
        portalGroupId: groupBad.group,
        portalModelId: groupBad.modelId,
        price: BASE_PRICE,
        operatorUserId: 'operator-5',
      },
      snapshotDeps()
    ),
    modules.routeService.publishPriceVersion(
      {
        portalGroupId: manualBad.group,
        portalModelId: manualBad.modelId,
        price: BASE_PRICE,
        operatorUserId: 'operator-5',
      },
      snapshotDeps()
    ),
  ]);
  assert.ok(
    groupResult.failures.some((failure: any) => failure.check === 'group_sync')
  );
  assert.ok(
    manualResult.failures.some((failure: any) => failure.check === 'price_sync')
  );
});

test('路由发布逐项拒绝：usable group、端点、active price、上下文', async () => {
  const unusable = await seedFixture();
  const endpoint = await seedFixture({ endpoints: ['image'] });
  const noPrice = await seedFixture({ withPrice: false });
  const noLimits = await seedFixture({
    contextWindow: null,
    maxOutputTokens: null,
  });
  const inputs = [unusable, endpoint, noPrice, noLimits];
  const deps = [
    snapshotDeps({ official: 12_000 }, []),
    snapshotDeps(),
    snapshotDeps(),
    snapshotDeps(),
  ];
  const results = await Promise.all(
    inputs.map((ids, index) =>
      modules.routeService.publishModelRoute(
        {
          portalGroupId: ids.group,
          portalModelId: ids.modelId,
          newapiGroup: 'official',
          operatorUserId: 'operator-6',
        },
        deps[index]
      )
    )
  );
  assert.ok(
    results[0].failures.some(
      (failure: any) => failure.check === 'usable_groups'
    )
  );
  assert.ok(
    results[1].failures.some(
      (failure: any) => failure.check === 'endpoint_intersection'
    )
  );
  assert.ok(
    results[2].failures.some(
      (failure: any) => failure.check === 'price_missing'
    )
  );
  assert.ok(
    results[3].failures.some(
      (failure: any) => failure.check === 'worst_case_inputs'
    )
  );
});

test('v1 模型 ID 恒等：不等拒绝，缺省或相等均通过', async () => {
  const mismatch = await seedFixture();
  const omitted = await seedFixture();
  const equal = await seedFixture();
  const mismatchResult = await modules.routeService.publishModelRoute(
    {
      portalGroupId: mismatch.group,
      portalModelId: mismatch.modelId,
      newapiGroup: 'official',
      newapiModelId: 'other-model',
      operatorUserId: 'operator-7',
    },
    snapshotDeps()
  );
  assert.ok(
    mismatchResult.failures.some(
      (failure: any) => failure.check === 'model_id_identity'
    )
  );
  assert.equal(
    (
      await modules.routeService.publishModelRoute(
        {
          portalGroupId: omitted.group,
          portalModelId: omitted.modelId,
          newapiGroup: 'official',
          operatorUserId: 'operator-7',
        },
        snapshotDeps()
      )
    ).ok,
    true
  );
  assert.equal(
    (
      await modules.routeService.publishModelRoute(
        {
          portalGroupId: equal.group,
          portalModelId: equal.modelId,
          newapiGroup: 'official',
          newapiModelId: equal.modelId,
          operatorUserId: 'operator-7',
        },
        snapshotDeps()
      )
    ).ok,
    true
  );
});

test('价格发布倍率跟随 active route 目标分组', async () => {
  const ids = await seedFixture({
    withRoute: true,
    routeGroup: 'group-b',
    priceRefGroup: 'group-b',
  });
  const price = {
    ...BASE_PRICE,
    inputMicroUsdPerM: 80,
    cachedInputMicroUsdPerM: 40,
    cacheWrite5mMicroUsdPerM: 100,
    cacheWrite1hMicroUsdPerM: 160,
    outputMicroUsdPerM: 160,
  };
  const result = await modules.routeService.publishPriceVersion(
    {
      portalGroupId: ids.group,
      portalModelId: ids.modelId,
      price,
      operatorUserId: 'operator-8',
    },
    snapshotDeps({ official: 12_000, 'group-b': 8_000 })
  );
  assert.equal(result.ok, true);
  const active = (
    await rowsFor(modules.schema.modelPriceVersion, ids.group, ids.modelId)
  ).find((row: any) => row.status === 'active');
  assert.equal(active.refNewapiGroup, 'group-b');
  assert.equal(active.newapiRefInputMicroUsdPerM, 80);
});

test('目标分组倍率缺失时拒绝价格发布且零写入', async () => {
  const ids = await seedFixture({ withRoute: true });
  const result = await modules.routeService.publishPriceVersion(
    {
      portalGroupId: ids.group,
      portalModelId: ids.modelId,
      price: BASE_PRICE,
      operatorUserId: 'operator-ratio-missing',
    },
    snapshotDeps({})
  );
  assert.equal(result.ok, false);
  assert.ok(
    result.failures.some(
      (failure: any) => failure.check === 'target_group_ratio'
    )
  );
  assert.equal(
    (await rowsFor(modules.schema.modelPriceVersion, ids.group, ids.modelId))
      .length,
    1
  );
});

test('跨分组重映射缺 remapPrice 时拒绝', async () => {
  const ids = await seedFixture({ withRoute: true });
  const result = await modules.routeService.publishModelRoute(
    {
      portalGroupId: ids.group,
      portalModelId: ids.modelId,
      newapiGroup: 'group-b',
      operatorUserId: 'operator-9',
    },
    snapshotDeps({ official: 12_000, 'group-b': 8_000 })
  );
  assert.ok(
    result.failures.some(
      (failure: any) => failure.check === 'remap_requires_price'
    )
  );
});

test('跨分组重映射原子双发；方向失败时零写入', async () => {
  const success = await seedFixture({ withRoute: true });
  const failure = await seedFixture({ withRoute: true });
  const deps = snapshotDeps({ official: 12_000, 'group-b': 8_000 });
  const ok = await modules.routeService.publishModelRoute(
    {
      portalGroupId: success.group,
      portalModelId: success.modelId,
      newapiGroup: 'group-b',
      remapPrice: BASE_PRICE,
      operatorUserId: 'operator-10',
    },
    deps
  );
  assert.equal(ok.ok, true);
  const routes = await rowsFor(
    modules.schema.modelRoute,
    success.group,
    success.modelId
  );
  const prices = await rowsFor(
    modules.schema.modelPriceVersion,
    success.group,
    success.modelId
  );
  assert.equal(routes.length, 2);
  assert.equal(prices.length, 2);
  assert.equal(
    routes.find((row: any) => row.status === 'active').newapiGroup,
    'group-b'
  );
  assert.equal(
    prices.find((row: any) => row.status === 'active').refNewapiGroup,
    'group-b'
  );
  const audits = await modules
    .db()
    .select()
    .from(modules.schema.portalAdminAuditLog);
  const fixtureAudits = audits.filter(
    (row: any) => row.targetId === `${success.group}:${success.modelId}`
  );
  assert.deepEqual(fixtureAudits.map((row: any) => row.action).sort(), [
    'price.publish',
    'routing.publish',
  ]);

  const bad = await modules.routeService.publishModelRoute(
    {
      portalGroupId: failure.group,
      portalModelId: failure.modelId,
      newapiGroup: 'group-b',
      remapPrice: { ...BASE_PRICE, inputMicroUsdPerM: 79 },
      operatorUserId: 'operator-10',
    },
    deps
  );
  assert.ok(
    bad.failures.some(
      (item: any) => item.check === 'price_direction_on_target_group'
    )
  );
  assert.equal(
    (await rowsFor(modules.schema.modelRoute, failure.group, failure.modelId))
      .length,
    1
  );
  assert.equal(
    (
      await rowsFor(
        modules.schema.modelPriceVersion,
        failure.group,
        failure.modelId
      )
    ).length,
    1
  );
});

test('重映射路由 insert 唯一冲突时价格写入一并回滚', async () => {
  const ids = await seedFixture({ withRoute: true });
  const generatedPriceId = nextId('generated-price');
  let idCall = 0;
  await assert.rejects(
    modules.routeService.publishModelRoute(
      {
        portalGroupId: ids.group,
        portalModelId: ids.modelId,
        newapiGroup: 'group-b',
        remapPrice: BASE_PRICE,
        operatorUserId: 'operator-11',
      },
      {
        ...snapshotDeps({ official: 12_000, 'group-b': 8_000 }),
        newId: () => (++idCall === 1 ? generatedPriceId : ids.route),
      }
    )
  );
  const routes = await rowsFor(
    modules.schema.modelRoute,
    ids.group,
    ids.modelId
  );
  const prices = await rowsFor(
    modules.schema.modelPriceVersion,
    ids.group,
    ids.modelId
  );
  assert.equal(routes.length, 1);
  assert.equal(routes[0].status, 'active');
  assert.equal(prices.length, 1);
  assert.equal(prices[0].status, 'active');
});

test('同分组重发携带 remapPrice 时拒绝', async () => {
  const ids = await seedFixture({ withRoute: true });
  const result = await modules.routeService.publishModelRoute(
    {
      portalGroupId: ids.group,
      portalModelId: ids.modelId,
      newapiGroup: 'official',
      remapPrice: BASE_PRICE,
      operatorUserId: 'operator-12',
    },
    snapshotDeps()
  );
  assert.ok(
    result.failures.some(
      (failure: any) => failure.check === 'remap_price_ambiguous'
    )
  );
});

test('发布 CAS：独立价格发布与跨组重映射交错仅一方提交，重试成功', async () => {
  const ids = await seedFixture({ withRoute: true });
  let arrivals = 0;
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const deps = {
    ...snapshotDeps({ official: 12_000, 'group-b': 8_000 }),
    getPricingSnapshot: async () => {
      arrivals += 1;
      if (arrivals === 2) release();
      await barrier;
      return snapshotDeps({
        official: 12_000,
        'group-b': 8_000,
      }).getPricingSnapshot();
    },
  };
  const results = await Promise.allSettled([
    modules.routeService.publishPriceVersion(
      {
        portalGroupId: ids.group,
        portalModelId: ids.modelId,
        price: BASE_PRICE,
        operatorUserId: 'operator-13',
      },
      deps
    ),
    modules.routeService.publishModelRoute(
      {
        portalGroupId: ids.group,
        portalModelId: ids.modelId,
        newapiGroup: 'group-b',
        remapPrice: BASE_PRICE,
        operatorUserId: 'operator-13',
      },
      deps
    ),
  ]);
  assert.equal(results.filter((item) => item.status === 'fulfilled').length, 1);
  assert.equal(results.filter((item) => item.status === 'rejected').length, 1);
  const activeRoute = (
    await rowsFor(modules.schema.modelRoute, ids.group, ids.modelId)
  ).find((row: any) => row.status === 'active');
  const activePrice = (
    await rowsFor(modules.schema.modelPriceVersion, ids.group, ids.modelId)
  ).find((row: any) => row.status === 'active');
  assert.equal(activeRoute.newapiGroup, activePrice.refNewapiGroup);

  if (activeRoute.newapiGroup === 'official') {
    const retry = await modules.routeService.publishModelRoute(
      {
        portalGroupId: ids.group,
        portalModelId: ids.modelId,
        newapiGroup: 'group-b',
        remapPrice: BASE_PRICE,
        operatorUserId: 'operator-13',
      },
      snapshotDeps({ official: 12_000, 'group-b': 8_000 })
    );
    assert.equal(retry.ok, true);
  } else {
    const retry = await modules.routeService.publishPriceVersion(
      {
        portalGroupId: ids.group,
        portalModelId: ids.modelId,
        price: BASE_PRICE,
        operatorUserId: 'operator-13',
      },
      snapshotDeps({ official: 12_000, 'group-b': 8_000 })
    );
    assert.equal(retry.ok, true);
  }
});

test('路由发布成功：版本递增、旧版退休、响应含 worst-case', async () => {
  const ids = await seedFixture({ withRoute: true });
  const result = await modules.routeService.publishModelRoute(
    {
      portalGroupId: ids.group,
      portalModelId: ids.modelId,
      newapiGroup: 'official',
      operatorUserId: 'operator-14',
    },
    snapshotDeps()
  );
  assert.equal(result.ok, true);
  assert.equal(result.version, 2);
  assert.equal(result.worstCaseMicroUsd, BigInt(1));
  const routes = await rowsFor(
    modules.schema.modelRoute,
    ids.group,
    ids.modelId
  );
  assert.equal(routes.find((row: any) => row.version === 1).status, 'retired');
  assert.equal(routes.find((row: any) => row.version === 2).status, 'active');
});

test('路由退休：条件更新、审计、幂等与 reason 门禁', async () => {
  const ids = await seedFixture({ withRoute: true });
  const retired = await modules.routeService.retireModelRoute(
    {
      portalGroupId: ids.group,
      portalModelId: ids.modelId,
      operatorUserId: 'operator-retire',
      reason: '运营下线',
    },
    { revalidate: () => undefined }
  );
  assert.equal(retired, true);
  const routes = await rowsFor(
    modules.schema.modelRoute,
    ids.group,
    ids.modelId
  );
  assert.equal(routes.find((row: any) => row.version === 1).status, 'retired');
  const audits = await modules
    .db()
    .select()
    .from(modules.schema.portalAdminAuditLog);
  assert.equal(
    audits.filter(
      (row: any) =>
        row.targetId === `${ids.group}:${ids.modelId}` &&
        row.action === 'routing.retire'
    ).length,
    1
  );
  assert.equal(
    await modules.routeService.retireModelRoute(
      {
        portalGroupId: ids.group,
        portalModelId: ids.modelId,
        operatorUserId: 'operator-retire',
        reason: '重复下线',
      },
      { revalidate: () => undefined }
    ),
    false
  );
  await assert.rejects(
    modules.routeService.retireModelRoute(
      {
        portalGroupId: ids.group,
        portalModelId: ids.modelId,
        operatorUserId: 'operator-retire',
        reason: '   ',
      },
      { revalidate: () => undefined }
    ),
    /reason/
  );
});

test('并发双路由发布由 CAS/唯一索引保证恰一成功', async () => {
  const ids = await seedFixture({ withRoute: true });
  let arrivals = 0;
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const deps = {
    ...snapshotDeps(),
    getPricingSnapshot: async () => {
      arrivals += 1;
      if (arrivals === 2) release();
      await barrier;
      return snapshotDeps().getPricingSnapshot();
    },
  };
  const results = await Promise.allSettled([
    modules.routeService.publishModelRoute(
      {
        portalGroupId: ids.group,
        portalModelId: ids.modelId,
        newapiGroup: 'official',
        operatorUserId: 'operator-15a',
      },
      deps
    ),
    modules.routeService.publishModelRoute(
      {
        portalGroupId: ids.group,
        portalModelId: ids.modelId,
        newapiGroup: 'official',
        operatorUserId: 'operator-15b',
      },
      deps
    ),
  ]);
  assert.equal(results.filter((item) => item.status === 'fulfilled').length, 1);
  assert.equal(results.filter((item) => item.status === 'rejected').length, 1);
  assert.equal(
    (await rowsFor(modules.schema.modelRoute, ids.group, ids.modelId)).filter(
      (row: any) => row.status === 'active'
    ).length,
    1
  );
});

test('worst-case 使用最大输入价并对总额 ceilDiv', () => {
  assert.equal(
    modules.worstCase.computeWorstCaseMicroUsd({
      contextWindow: 1_000,
      maxOutputTokens: 100,
      price: BASE_PRICE,
    }),
    BigInt(1)
  );
});
