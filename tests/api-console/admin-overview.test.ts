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
    apipoolLedgerEntry,
    newApiUserBinding,
    catalogVendor,
    catalogGroup,
    catalogStatus,
    catalogModel,
    catalogModelListing,
  } = await import('@/config/db/schema');
  const { db } = await import('@/core/db');
  const overview = await import(
    '@/features/api-console/server/admin-overview'
  );

  modules = {
    db,
    user,
    apipoolLedgerEntry,
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

  // Users: 0 = operator, 1..6 back the bindings / ledger portal user.
  const users: string[] = [];
  for (let i = 0; i < 7; i += 1) {
    const id = `${p}_user_${i}`;
    users.push(id);
    await modules.db().insert(modules.user).values({
      id,
      name: id,
      email: `${id}@example.com`,
    });
  }
  const operator = users[0];

  // --- ledger: reconciliation (any source) vs pending manual adjustment ---
  const ledgerRows = [
    // reconciliation_required across mixed sources -> reconciliation delta = 3
    { source: 'recharge', status: 'reconciliation_required' },
    { source: 'manual_adjustment', status: 'reconciliation_required' },
    { source: 'recharge', status: 'reconciliation_required' },
    // manual adjustment pending/processing -> pending delta = 2
    { source: 'manual_adjustment', status: 'pending' },
    { source: 'manual_adjustment', status: 'processing' },
    // noise that must NOT land in either counter above
    { source: 'manual_adjustment', status: 'applied' },
    { source: 'recharge', status: 'pending' },
  ];
  let ledgerSeq = 0;
  for (const row of ledgerRows) {
    ledgerSeq += 1;
    await modules.db().insert(modules.apipoolLedgerEntry).values({
      id: `${p}_ledger_${ledgerSeq}`,
      portalUserId: users[1],
      operatorUserId: operator,
      newapiUserId: `${p}_remote_${ledgerSeq}`,
      amountUsd: 100,
      source: row.source,
      status: row.status,
      executor: 'admin',
      reason: 'test',
    });
  }

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
    await modules.db().insert(modules.newApiUserBinding).values({
      id: `${p}_binding_${bindingSeq}`,
      portalUserId: row.user,
      newapiUserId: `${p}_newapi_${bindingSeq}`,
      status: row.status,
    });
  }

  // --- listings: price_drift_status != matched -> drift delta = 1 ---
  await modules.db().insert(modules.catalogVendor).values({
    id: `${p}_vendor`,
    slug: `${p}-vendor`,
    name: 'Vendor',
  });
  await modules.db().insert(modules.catalogGroup).values([
    { id: `${p}_group_1`, slug: `${p}-group-1`, name: 'Group 1' },
    { id: `${p}_group_2`, slug: `${p}-group-2`, name: 'Group 2' },
  ]);
  await modules.db().insert(modules.catalogStatus).values({
    id: `${p}_status`,
    slug: `${p}-status`,
    name: 'Status',
  });
  await modules.db().insert(modules.catalogModel).values({
    id: `${p}_model`,
    modelId: `${p}-model`,
    displayName: 'Model',
    vendorId: `${p}_vendor`,
  });
  await modules.db().insert(modules.catalogModelListing).values([
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
  ]);

  const after = await modules.overview.getAdminOverviewSignals();

  assert.deepEqual(
    {
      reconciliationRequired:
        after.reconciliationRequired - before.reconciliationRequired,
      pendingManualAdjustments:
        after.pendingManualAdjustments - before.pendingManualAdjustments,
      bindingSyncIssues: after.bindingSyncIssues - before.bindingSyncIssues,
      priceDriftListings: after.priceDriftListings - before.priceDriftListings,
    },
    {
      reconciliationRequired: 3,
      pendingManualAdjustments: 2,
      bindingSyncIssues: 4,
      priceDriftListings: 1,
    }
  );
});

test('admin overview counters return non-negative integers', async () => {
  await setupOverviewDb();

  const signals = await modules.overview.getAdminOverviewSignals();

  for (const key of [
    'reconciliationRequired',
    'pendingManualAdjustments',
    'bindingSyncIssues',
    'priceDriftListings',
  ] as const) {
    assert.ok(
      Number.isInteger(signals[key]) && signals[key] >= 0,
      `${key} should be a non-negative integer, got ${signals[key]}`
    );
  }
});
