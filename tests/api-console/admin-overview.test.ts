import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { createClient } from '@libsql/client';

// Isolated sqlite fixture (mirrors tests/newapi-bridge/portal.test.ts). The
// admin-overview counters query real tables, so we exercise the WHERE
// predicates against seeded rows. `db()` resolves its connection from a
// module-level config captured at import time and is shared across the test
// process, so we assert on the DELTA around our own inserts (with unique ids)
// rather than absolute whole-table counts.
let modules: any;

async function setupOverviewDb() {
  const dbPath = join(process.cwd(), '.tmp', 'admin-overview.db');
  await mkdir(join(process.cwd(), '.tmp'), { recursive: true });
  await rm(dbPath, { force: true });

  process.env.DATABASE_PROVIDER = 'sqlite';
  process.env.DATABASE_URL = `file:${dbPath}`;
  process.env.DB_SCHEMA_FILE = './src/config/db/schema.sqlite.ts';
  process.env.DB_MIGRATIONS_OUT = './src/config/db/migrations_sqlite';
  process.env.DB_SINGLETON_ENABLED = 'false';
  process.env.APIPOOL_CREDENTIALS_SECRET = 'admin-overview-test-secret';

  const client = createClient({ url: `file:${dbPath}` });
  const migrationsDir = join(process.cwd(), 'src/config/db/migrations_sqlite');
  for (const file of (await readdir(migrationsDir))
    .filter((name) => name.endsWith('.sql'))
    .sort()) {
    await client.executeMultiple(
      await readFile(join(migrationsDir, file), 'utf8')
    );
  }

  const {
    user,
    walletAccount,
    newApiUserBinding,
    catalogVendor,
    catalogGroup,
    catalogStatus,
    catalogModel,
    catalogModelListing,
  } = await import('@/config/db/schema');
  const { db } = await import('@/core/db');
  const overview = await import('@/features/api-console/server/admin-overview');

  modules = {
    db,
    user,
    walletAccount,
    newApiUserBinding,
    catalogVendor,
    catalogGroup,
    catalogStatus,
    catalogModel,
    catalogModelListing,
    overview,
  };
}

test('admin overview counters isolate each operational signal', async () => {
  await setupOverviewDb();

  // Unique per-run namespace so inserts never collide with pre-seeded rows
  // that other test files may have left on the shared connection.
  const p = `ov_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  const before = await modules.overview.getAdminOverviewSignals();

  // Users: 0..6 back the bindings and local wallet signals.
  const users: string[] = [];
  for (let i = 0; i < 7; i += 1) {
    const id = `${p}_user_${i}`;
    users.push(id);
    await modules
      .db()
      .insert(modules.user)
      .values({
        id,
        name: id,
        email: `${id}@example.com`,
      });
  }
  // --- 本地钱包：负余额与冻结分别计数，可同时命中 ---
  await modules
    .db()
    .insert(modules.walletAccount)
    .values([
      { userId: users[0], balanceMicroUsd: 10 },
      { userId: users[1], balanceMicroUsd: -1 },
      { userId: users[2], balanceMicroUsd: -2, frozenAt: new Date() },
      { userId: users[3], balanceMicroUsd: 0, frozenAt: new Date() },
    ]);

  // --- bindings: status not in (active, deleted) -> sync delta = 4 ---
  const bindingRows = [
    { user: users[1], status: 'active' },
    { user: users[2], status: 'deleted' },
    { user: users[3], status: 'pending' },
    { user: users[4], status: 'provisioning' },
    { user: users[5], status: 'username_sync_failed' },
    { user: users[6], status: 'conflict_requires_review' },
  ];
  let bindingSeq = 0;
  for (const row of bindingRows) {
    bindingSeq += 1;
    await modules
      .db()
      .insert(modules.newApiUserBinding)
      .values({
        id: `${p}_binding_${bindingSeq}`,
        portalUserId: row.user,
        newapiUserId: `${p}_newapi_${bindingSeq}`,
        status: row.status,
      });
  }

  // --- listings: matched/ok 正常；成本告警与待复核计入运维信号 ---
  await modules
    .db()
    .insert(modules.catalogVendor)
    .values({
      id: `${p}_vendor`,
      slug: `${p}-vendor`,
      name: 'Vendor',
    });
  await modules
    .db()
    .insert(modules.catalogGroup)
    .values([
      { id: `${p}_group_1`, slug: `${p}-group-1`, name: 'Group 1' },
      { id: `${p}_group_2`, slug: `${p}-group-2`, name: 'Group 2' },
      { id: `${p}_group_3`, slug: `${p}-group-3`, name: 'Group 3' },
      { id: `${p}_group_4`, slug: `${p}-group-4`, name: 'Group 4' },
    ]);
  await modules
    .db()
    .insert(modules.catalogStatus)
    .values({
      id: `${p}_status`,
      slug: `${p}-status`,
      name: 'Status',
    });
  await modules
    .db()
    .insert(modules.catalogModel)
    .values({
      id: `${p}_model`,
      modelId: `${p}-model`,
      displayName: 'Model',
      vendorId: `${p}_vendor`,
    });
  await modules
    .db()
    .insert(modules.catalogModelListing)
    .values([
      {
        id: `${p}_listing_matched`,
        modelId: `${p}_model`,
        groupId: `${p}_group_1`,
        statusId: `${p}_status`,
        inputMicroUsd: 1,
        outputMicroUsd: 1,
        priceDriftStatus: 'matched',
      },
      {
        id: `${p}_listing_drift`,
        modelId: `${p}_model`,
        groupId: `${p}_group_2`,
        statusId: `${p}_status`,
        inputMicroUsd: 1,
        outputMicroUsd: 1,
        priceDriftStatus: 'needs_live_check',
      },
      {
        id: `${p}_listing_ok`,
        modelId: `${p}_model`,
        groupId: `${p}_group_3`,
        statusId: `${p}_status`,
        inputMicroUsd: 1,
        outputMicroUsd: 1,
        priceDriftStatus: 'ok',
      },
      {
        id: `${p}_listing_cost_alert`,
        modelId: `${p}_model`,
        groupId: `${p}_group_4`,
        statusId: `${p}_status`,
        inputMicroUsd: 1,
        outputMicroUsd: 1,
        priceDriftStatus: 'cost_alert',
      },
    ]);

  const after = await modules.overview.getAdminOverviewSignals();

  assert.deepEqual(
    {
      negativeWallets: after.negativeWallets - before.negativeWallets,
      frozenWallets: after.frozenWallets - before.frozenWallets,
      bindingSyncIssues: after.bindingSyncIssues - before.bindingSyncIssues,
      priceDriftListings: after.priceDriftListings - before.priceDriftListings,
    },
    {
      negativeWallets: 2,
      frozenWallets: 2,
      bindingSyncIssues: 4,
      priceDriftListings: 2,
    }
  );
});

test('admin overview counters return non-negative integers', async () => {
  await setupOverviewDb();

  const signals = await modules.overview.getAdminOverviewSignals();

  for (const key of [
    'negativeWallets',
    'frozenWallets',
    'bindingSyncIssues',
    'priceDriftListings',
  ] as const) {
    assert.ok(
      Number.isInteger(signals[key]) && signals[key] >= 0,
      `${key} should be a non-negative integer, got ${signals[key]}`
    );
  }
});
