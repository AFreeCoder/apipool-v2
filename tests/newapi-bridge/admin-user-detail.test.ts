import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { createClient } from '@libsql/client';

let modules: any;

const detailPagePath =
  'src/app/[locale]/(admin)/admin/users/[id]/detail/page.tsx';
const listPagePath = 'src/app/[locale]/(admin)/admin/users/page.tsx';
const actionPath =
  'src/features/newapi-bridge/server/admin-user-binding-actions.ts';

function getByPath(obj: any, path: string) {
  return path.split('.').reduce((current, key) => current?.[key], obj);
}

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

  // 充值行必须一起可见：用户投诉「付了钱没到账」时，只看人工调额等于
  // 看不到任何证据（原先这里断言 length === 1，把该缺陷写成了期望）。
  assert.equal(entries.length, 2);
  const recharge = entries.find((row: any) => row.source === 'recharge');
  assert.ok(recharge, 'recharge ledger rows must be visible to admins');
  assert.equal(recharge.orderNo, 'admin_detail_order');
  assert.equal(recharge.amountUsd, 50);

  const manual = entries.find(
    (row: any) => row.id === 'admin_detail_manual_adjustment'
  );
  assert.ok(manual);
  assert.equal(manual.source, 'manual_adjustment');
  assert.equal(manual.amountUsd, 12.34);
  assert.equal(manual.newapiUserId, 'remote_user_ledger');
  assert.equal(manual.newapiChangeId, 'change_manual_adjustment');
  assert.deepEqual(manual.audit, {
    id: 'admin_detail_manual_adjustment_audit',
    status: 'success',
    idempotencyKey: 'portal-adjustment:admin_detail_user_ledger:success',
    errorMessage: null,
  });
  assert.deepEqual(manual.operator, {
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

test('admin user detail page uses local wallet, request ledger, and portal keys', async () => {
  const page = await readFile(join(process.cwd(), detailPagePath), 'utf8');

  assert.match(page, /requirePermission\s*\(/);
  assert.match(page, /PERMISSIONS\.USERS_READ/);
  assert.match(page, /getWalletUsageView\s*\(/);
  assert.match(page, /getWalletBillingView\s*\(/);
  assert.match(page, /listPortalApiKeys\s*\(/);
  assert.doesNotMatch(page, /getPortalUsage\s*\(/);
  assert.doesNotMatch(page, /listAdjustmentLedgerByPortalUser\s*\(/);
  assert.match(page, /hasPermission\s*\(/);
  assert.match(page, /PERMISSIONS\.APIPOOL_QUOTA_ADJUST/);
  assert.match(page, /canAdjustApipoolQuota/);
  assert.doesNotMatch(page, /formatOptionalQuotaUnits/);
  assert.match(page, /detail\.ledger\.columns\.balance_after/);
  assert.match(page, /getTranslations\(['"]admin\.users['"]\)/);

  assert.doesNotMatch(page, /ResolveAdjustmentButton/);
  assert.match(page, /detail\.ledger\.columns\.source/);
  // \u53ea\u8bfb\u7ba1\u7406\u5458\u4e0d\u8be5\u770b\u5230 USERS_WRITE \u7684\u6309\u94ae
  assert.match(page, /canWriteUsers/);

  // \u5b88\u536b\u9488\u5bf9\u7684\u662f\u786c\u7f16\u7801\u4e2d\u6587 UI \u6587\u6848\uff0c\u4e0d\u662f\u6ce8\u91ca\u3002\u5265\u6389\u6ce8\u91ca\u518d\u67e5\uff0c
  // \u5426\u5219\u7528\u4e2d\u6587\u89e3\u91ca\u300c\u4e3a\u4ec0\u4e48\u8fd9\u4e48\u5199\u300d\u672c\u8eab\u4f1a\u8e29\u7ea2\u706f\u3002
  const pageCode = page
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  assert.doesNotMatch(pageCode, /[\u4e00-\u9fff]/);
});

test('admin user detail page renders New API binding card and recovery actions', async () => {
  const source = await readFile(join(process.cwd(), detailPagePath), 'utf8');

  assert.match(source, /getPortalUserBinding/);
  assert.match(source, /toAdminBindingDto/);
  assert.match(source, /detail\.binding\.title/);
  assert.match(source, /detail\.binding\.fields\.target_username/);
  assert.match(source, /detail\.binding\.fields\.confirmed_username/);
  assert.match(source, /detail\.binding\.fields\.error_code/);
  assert.match(source, /retryNewapiUserBindingAction/);
  assert.match(source, /confirmNewapiUserConflictAction/);
  assert.match(source, /disableNewapiUserBindingAction/);
  assert.match(source, /conflict_requires_review/);
  assert.doesNotMatch(source, /newapiAccessTokenEnc/);
  assert.doesNotMatch(source, /newapiPasswordEnc/);
});

test('admin user list exposes server-side binding filters and safe columns', async () => {
  const source = await readFile(join(process.cwd(), listPagePath), 'utf8');

  assert.match(source, /newApiBindingStatus/);
  assert.match(source, /lastSyncErrorCode/);
  assert.match(source, /fields\.newapi_binding_status/);
  assert.match(source, /fields\.newapi_sync_error/);
  assert.match(source, /list\.filters\.username_sync_failed/);
  assert.match(source, /list\.filters\.newapi_username_too_long/);
  assert.doesNotMatch(source, /newapiAccessTokenEnc/);
  assert.doesNotMatch(source, /newapiPasswordEnc/);
});

test('admin binding actions are exported with USERS_WRITE permission checks', async () => {
  const source = await readFile(join(process.cwd(), actionPath), 'utf8');

  assert.match(source, /export async function retryNewapiUserBindingAction/);
  assert.match(source, /export async function confirmNewapiUserConflictAction/);
  assert.match(source, /export async function disableNewapiUserBindingAction/);
  assert.match(source, /export async function restoreNewapiUserBindingAction/);
  assert.match(source, /PERMISSIONS\.USERS_WRITE/);
  assert.match(source, /getUserInfo/);
  assert.match(source, /admin user session required/);
  assert.equal(
    (source.match(/operatorUserId:\s*currentUser\.id/g) || []).length,
    4
  );
  assert.equal((source.match(/await requirePermission/g) || []).length, 4);
});

test('admin users locale files contain all New API binding keys used by pages', async () => {
  const requiredKeys = [
    'fields.newapi_binding_status',
    'fields.newapi_sync_error',
    'list.filters.username_sync_failed',
    'list.filters.conflict_requires_review',
    'list.filters.newapi_username_too_long',
    'detail.errors.binding',
    'detail.binding.title',
    'detail.binding.description',
    'detail.binding.fields.status',
    'detail.binding.fields.target_username',
    'detail.binding.fields.confirmed_username',
    'detail.binding.fields.error_code',
    'detail.binding.fields.last_attempted',
    'detail.binding.fields.last_synced',
    'detail.binding.actions.retry',
    'detail.binding.actions.confirm_conflict',
    'detail.binding.actions.disable',
    'detail.status.binding.pending',
    'detail.status.binding.provisioning',
    'detail.status.binding.active',
    'detail.status.binding.username_sync_pending',
    'detail.status.binding.username_sync_failed',
    'detail.status.binding.conflict_requires_review',
    'detail.status.binding.disabled',
  ];

  for (const locale of ['zh', 'en']) {
    const json = JSON.parse(
      await readFile(
        join(
          process.cwd(),
          `src/config/locale/messages/${locale}/admin/users.json`
        ),
        'utf8'
      )
    );
    for (const key of requiredKeys) {
      assert.equal(
        typeof getByPath(json, key),
        'string',
        `${locale} missing ${key}`
      );
      assert.equal(
        getByPath(json, key).includes('admin.users.'),
        false,
        `${locale} ${key} must not be a raw translation key`
      );
    }
  }
});
