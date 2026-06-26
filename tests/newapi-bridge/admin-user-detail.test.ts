import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { createClient } from '@libsql/client';

let modules: any;

async function setupDb() {
  const dbPath = join(process.cwd(), '.tmp', 'admin-user-detail.db');
  await mkdir(join(process.cwd(), '.tmp'), { recursive: true });
  await rm(dbPath, { force: true });

  process.env.DATABASE_PROVIDER = 'sqlite';
  process.env.DATABASE_URL = `file:${dbPath}`;
  process.env.DB_SCHEMA_FILE = './src/config/db/schema.sqlite.ts';
  process.env.DB_MIGRATIONS_OUT = './src/config/db/migrations_sqlite';
  process.env.DB_SINGLETON_ENABLED = 'false';
  process.env.APIPOOL_CREDENTIALS_SECRET = 'admin-user-detail-test-secret';

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
  const portal = await import('@/features/newapi-bridge/server/portal');

  modules = { db, schema, portal };

  await modules.db().insert(modules.schema.catalogGroup).values({
    id: 'admin_detail_group',
    slug: 'admin-detail',
    name: 'Admin Detail Group',
    userDescription: 'Admin detail route',
    newapiGroup: 'sensitive-newapi-group',
    allowCreateKey: true,
    sortOrder: 1,
    status: 'active',
  });
}

async function insertUser(id: string, email: string, name = id) {
  await modules.db().insert(modules.schema.user).values({ id, name, email });
  return { id, name, email };
}

function assertNoFields(record: Record<string, unknown>, fields: string[]) {
  for (const field of fields) {
    assert.equal(
      Object.hasOwn(record, field),
      false,
      `${field} should not be exposed`
    );
  }
}

test.before(setupDb);

test('listKeysByPortalUser returns local key bindings without New API group internals', async () => {
  const user = await insertUser('admin_detail_user_keys', 'keys@example.com');

  await modules
    .db()
    .insert(modules.schema.newApiKeyBinding)
    .values([
      {
        id: 'admin_detail_key_1',
        portalUserId: user.id,
        newapiUserId: 'remote_user_keys',
        newapiKeyId: 'remote_key_1',
        keyMasked: 'sk-...one',
        displayName: 'Primary key',
        status: 'active',
        allowedModels: '["gpt-4o-mini"]',
        groupId: 'admin_detail_group',
        newapiGroup: 'sensitive-newapi-group',
        idempotencyKey: 'admin-detail-key-1',
      },
      {
        id: 'admin_detail_key_2',
        portalUserId: user.id,
        newapiUserId: 'remote_user_keys',
        newapiKeyId: 'remote_key_2',
        keyMasked: 'sk-...two',
        displayName: 'Secondary key',
        status: 'disabled',
        allowedModels: '[]',
        groupId: 'admin_detail_group',
        newapiGroup: 'sensitive-newapi-group',
        idempotencyKey: 'admin-detail-key-2',
      },
    ]);

  const keys = await modules.portal.listKeysByPortalUser(user.id);

  assert.equal(keys.length, 2);
  assert.deepEqual(keys.map((key: any) => key.displayName).sort(), [
    'Primary key',
    'Secondary key',
  ]);
  for (const key of keys) {
    assert.equal(key.groupName, 'Admin Detail Group');
    assertNoFields(key, ['groupId', 'newapiGroup']);
  }
});

test('listAdjustmentLedgerByPortalUser returns manual adjustments with operator and raw USD amount', async () => {
  const user = await insertUser(
    'admin_detail_user_ledger',
    'ledger@example.com'
  );
  const operator = await insertUser(
    'admin_detail_operator',
    'operator@example.com',
    'Quota Operator'
  );

  await modules
    .db()
    .insert(modules.schema.apipoolLedgerEntry)
    .values([
      {
        id: 'admin_detail_manual_adjustment',
        portalUserId: user.id,
        operatorUserId: operator.id,
        newapiUserId: 'remote_user_ledger',
        newapiChangeId: 'change_manual_adjustment',
        amountUsd: 12.34,
        source: 'manual_adjustment',
        status: 'applied',
        executor: 'admin',
        reason: 'Support credit',
        rollbackStatus: 'not_required',
      },
      {
        id: 'admin_detail_recharge',
        portalUserId: user.id,
        operatorUserId: operator.id,
        newapiUserId: 'remote_user_ledger',
        newapiChangeId: 'change_recharge',
        orderNo: 'admin_detail_order',
        amountUsd: 50,
        source: 'recharge',
        status: 'applied',
        executor: 'webhook',
        reason: 'Recharge',
        rollbackStatus: 'not_required',
      },
    ]);

  const entries = await modules.portal.listAdjustmentLedgerByPortalUser(
    user.id
  );

  assert.equal(entries.length, 1);
  assert.equal(entries[0].id, 'admin_detail_manual_adjustment');
  assert.equal(entries[0].source, 'manual_adjustment');
  assert.equal(entries[0].amountUsd, 12.34);
  assert.deepEqual(entries[0].operator, {
    id: operator.id,
    name: operator.name,
    email: operator.email,
  });
});

test('admin detail queries return empty arrays for users without bindings or ledger', async () => {
  const user = await insertUser('admin_detail_empty_user', 'empty@example.com');

  assert.deepEqual(await modules.portal.listKeysByPortalUser(user.id), []);
  assert.deepEqual(
    await modules.portal.listAdjustmentLedgerByPortalUser(user.id),
    []
  );
});

test('admin user detail page keeps the required read-only data sources and i18n guardrails', async () => {
  const page = await readFile(
    join(
      process.cwd(),
      'src/app/[locale]/(admin)/admin/users/[id]/detail/page.tsx'
    ),
    'utf8'
  );

  assert.match(page, /requirePermission\s*\(/);
  assert.match(page, /PERMISSIONS\.USERS_READ/);
  assert.match(page, /getPortalUsage\s*\(/);
  assert.match(page, /listKeysByPortalUser\s*\(/);
  assert.match(page, /listAdjustmentLedgerByPortalUser\s*\(/);
  assert.match(page, /getTranslations\(['"]admin\.users['"]\)/);
  assert.doesNotMatch(page, /[\u4e00-\u9fff]/);
});
