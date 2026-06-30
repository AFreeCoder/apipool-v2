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
  await modules
    .db()
    .insert(modules.schema.newApiBridgeAuditLog)
    .values({
      id: 'admin_detail_manual_adjustment_audit',
      portalUserId: user.id,
      operatorUserId: operator.id,
      action: 'newapi.quota.adjust',
      targetType: 'newapi_user',
      targetId: 'remote_user_ledger',
      status: 'success',
      idempotencyKey: 'portal-adjustment:admin_detail_user_ledger:success',
      requestBody: JSON.stringify({
        amountUsd: 12.34,
        reason: 'Support credit',
      }),
      responseBody: JSON.stringify({ changeId: 'change_manual_adjustment' }),
    });

  const entries = await modules.portal.listAdjustmentLedgerByPortalUser(
    user.id
  );

  assert.equal(entries.length, 1);
  assert.equal(entries[0].id, 'admin_detail_manual_adjustment');
  assert.equal(entries[0].source, 'manual_adjustment');
  assert.equal(entries[0].amountUsd, 12.34);
  assert.equal(entries[0].newapiUserId, 'remote_user_ledger');
  assert.equal(entries[0].newapiChangeId, 'change_manual_adjustment');
  assert.deepEqual(entries[0].audit, {
    id: 'admin_detail_manual_adjustment_audit',
    status: 'success',
    idempotencyKey: 'portal-adjustment:admin_detail_user_ledger:success',
    errorMessage: null,
  });
  assert.deepEqual(entries[0].operator, {
    id: operator.id,
    name: operator.name,
    email: operator.email,
  });
});

test('listAdjustmentLedgerByPortalUser links failed decrease adjustments to failed audit data', async () => {
  const user = await insertUser(
    'admin_detail_user_failed_adjustment',
    'failed-adjustment@example.com'
  );
  const operator = await insertUser(
    'admin_detail_operator_failed_adjustment',
    'operator-failed-adjustment@example.com',
    'Quota Operator'
  );

  await modules.db().insert(modules.schema.apipoolLedgerEntry).values({
    id: 'admin_detail_failed_decrease',
    portalUserId: user.id,
    operatorUserId: operator.id,
    newapiUserId: 'remote_user_failed_adjustment',
    amountUsd: -5,
    source: 'manual_adjustment',
    status: 'failed',
    executor: 'admin',
    reason: 'Refund correction',
    rollbackStatus: 'not_required',
  });
  await modules
    .db()
    .insert(modules.schema.newApiBridgeAuditLog)
    .values({
      id: 'admin_detail_failed_decrease_audit',
      portalUserId: user.id,
      operatorUserId: operator.id,
      action: 'newapi.quota.adjust',
      targetType: 'newapi_user',
      targetId: 'remote_user_failed_adjustment',
      status: 'failed',
      idempotencyKey:
        'portal-adjustment:admin_detail_user_failed_adjustment:failed',
      requestBody: JSON.stringify({
        amountUsd: -5,
        reason: 'Refund correction',
      }),
      errorMessage: 'quota update timed out',
    });

  const entries = await modules.portal.listAdjustmentLedgerByPortalUser(
    user.id
  );

  assert.equal(entries.length, 1);
  assert.equal(entries[0].id, 'admin_detail_failed_decrease');
  assert.equal(entries[0].amountUsd, -5);
  assert.equal(entries[0].status, 'failed');
  assert.equal(entries[0].newapiUserId, 'remote_user_failed_adjustment');
  assert.equal(entries[0].newapiChangeId, null);
  assert.deepEqual(entries[0].audit, {
    id: 'admin_detail_failed_decrease_audit',
    status: 'failed',
    idempotencyKey:
      'portal-adjustment:admin_detail_user_failed_adjustment:failed',
    errorMessage: 'quota update timed out',
  });
});

test('listAdjustmentLedgerByPortalUser matches adjustment audits by exact change reference', async () => {
  const user = await insertUser(
    'admin_detail_user_repeated_adjustment',
    'repeated-adjustment@example.com'
  );
  const operator = await insertUser(
    'admin_detail_operator_repeated_adjustment',
    'operator-repeated-adjustment@example.com',
    'Quota Operator'
  );

  await modules
    .db()
    .insert(modules.schema.apipoolLedgerEntry)
    .values([
      {
        id: 'admin_detail_repeated_adjustment_one',
        portalUserId: user.id,
        operatorUserId: operator.id,
        newapiUserId: 'remote_user_repeated_adjustment',
        newapiChangeId: 'change_repeated_one',
        amountUsd: 10,
        source: 'manual_adjustment',
        status: 'applied',
        executor: 'admin',
        reason: 'Repeated correction',
        rollbackStatus: 'not_required',
      },
      {
        id: 'admin_detail_repeated_adjustment_two',
        portalUserId: user.id,
        operatorUserId: operator.id,
        newapiUserId: 'remote_user_repeated_adjustment',
        newapiChangeId: 'change_repeated_two',
        amountUsd: 10,
        source: 'manual_adjustment',
        status: 'applied',
        executor: 'admin',
        reason: 'Repeated correction',
        rollbackStatus: 'not_required',
      },
    ]);
  await modules
    .db()
    .insert(modules.schema.newApiBridgeAuditLog)
    .values([
      {
        id: 'admin_detail_repeated_audit_one',
        portalUserId: user.id,
        operatorUserId: operator.id,
        action: 'newapi.quota.adjust',
        targetType: 'newapi_user',
        targetId: 'remote_user_repeated_adjustment',
        status: 'success',
        idempotencyKey: 'portal-adjustment:repeated:one',
        requestBody: JSON.stringify({
          amountUsd: 10,
          reason: 'Repeated correction',
        }),
        responseBody: JSON.stringify({ changeId: 'change_repeated_one' }),
      },
      {
        id: 'admin_detail_repeated_audit_two',
        portalUserId: user.id,
        operatorUserId: operator.id,
        action: 'newapi.quota.adjust',
        targetType: 'newapi_user',
        targetId: 'remote_user_repeated_adjustment',
        status: 'success',
        idempotencyKey: 'portal-adjustment:repeated:two',
        requestBody: JSON.stringify({
          amountUsd: 10,
          reason: 'Repeated correction',
        }),
        responseBody: JSON.stringify({ changeId: 'change_repeated_two' }),
      },
    ]);

  const entries = await modules.portal.listAdjustmentLedgerByPortalUser(
    user.id
  );
  const one = entries.find(
    (entry: any) => entry.id === 'admin_detail_repeated_adjustment_one'
  );
  const two = entries.find(
    (entry: any) => entry.id === 'admin_detail_repeated_adjustment_two'
  );

  assert.equal(one.audit.id, 'admin_detail_repeated_audit_one');
  assert.equal(two.audit.id, 'admin_detail_repeated_audit_two');
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
  assert.match(page, /hasPermission\s*\(/);
  assert.match(page, /PERMISSIONS\.APIPOOL_QUOTA_ADJUST/);
  assert.match(page, /canAdjustApipoolQuota/);
  assert.match(page, /formatOptionalQuotaUnits/);
  assert.doesNotMatch(
    page,
    /formatOptionalBalanceUsd\(\s*usageResult\.data\.summary\.quotaRemaining/
  );
  assert.match(page, /detail\.ledger\.columns\.newapi_change/);
  assert.match(page, /detail\.ledger\.columns\.audit/);
  assert.match(page, /getTranslations\(['"]admin\.users['"]\)/);
  assert.doesNotMatch(page, /[\u4e00-\u9fff]/);
});
