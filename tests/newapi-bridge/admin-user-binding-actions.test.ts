import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { createClient } from '@libsql/client';
import { eq } from 'drizzle-orm';

let modules: any;

async function setupPortalDb() {
  const dbPath = join(process.cwd(), '.tmp', 'admin-user-binding-actions.db');
  await mkdir(join(process.cwd(), '.tmp'), { recursive: true });
  await rm(dbPath, { force: true });

  process.env.DATABASE_PROVIDER = 'sqlite';
  process.env.DATABASE_URL = `file:${dbPath}`;
  process.env.DB_SCHEMA_FILE = './src/config/db/schema.sqlite.ts';
  process.env.DB_MIGRATIONS_OUT = './src/config/db/migrations_sqlite';
  process.env.DB_SINGLETON_ENABLED = 'false';
  process.env.APIPOOL_CREDENTIALS_SECRET = 'admin-binding-test-secret';

  const client = createClient({ url: `file:${dbPath}` });
  const migrationsDir = join(process.cwd(), 'src/config/db/migrations_sqlite');
  for (const file of (await readdir(migrationsDir))
    .filter((name) => name.endsWith('.sql'))
    .sort()) {
    await client.executeMultiple(
      await readFile(join(migrationsDir, file), 'utf8')
    );
  }

  const { user } = await import('@/config/db/schema');
  const { catalogGroup, newApiBridgeAuditLog, newApiUserBinding } =
    await import('@/config/db/schema');
  const { db } = await import('@/core/db');
  const portal = await import('@/features/newapi-bridge/server/portal');

  modules = {
    db,
    catalogGroup,
    newApiBridgeAuditLog,
    newApiUserBinding,
    portal,
    user,
  };

  await modules.db().insert(modules.catalogGroup).values({
    id: 'catalog_group_admin_binding_test',
    slug: 'admin-binding-test',
    name: 'Admin Binding Test',
    userDescription: 'Admin binding test route',
    newapiGroup: 'ng-admin-binding-test',
    allowCreateKey: true,
    sortOrder: 1,
    status: 'active',
  });
}

async function insertUser(id: string, email: string) {
  await modules.db().insert(modules.user).values({
    id,
    name: id,
    email,
  });
  return { id, name: id, email };
}

function createSuccessfulRemoteClient() {
  return {
    provisionUser: async (input: { username: string }) => ({
      newapiUserId: `remote_${input.username}`,
      accessToken: 'test-access-token',
    }),
    ensureUserGroup: async () => {},
    updateUserProfile: async (input: any) => ({
      newapiUserId: input.newapiUserId,
      username: input.username,
      displayName: input.displayName,
      group: input.group || '',
      role: 1,
      remark: input.remark || '',
    }),
  };
}

test.before(setupPortalDb);

test('disableNewapiUserBindingForAdmin stores disabled state and redacted audit', async () => {
  const portalUser = await insertUser('portal_user_admin_disable', 'ad0@b.co');
  const operator = await insertUser('operator_admin_disable', 'opad@b.co');
  await modules.portal.ensurePortalUserBinding(
    portalUser,
    createSuccessfulRemoteClient()
  );

  const result = await modules.portal.disableNewapiUserBindingForAdmin({
    portalUserId: portalUser.id,
    reason: 'security review',
    operatorUserId: operator.id,
  });

  const binding = await modules.portal.getPortalUserBinding(portalUser.id);
  const audits = await modules
    .db()
    .select()
    .from(modules.newApiBridgeAuditLog)
    .where(eq(modules.newApiBridgeAuditLog.portalUserId, portalUser.id));

  assert.equal(result.status, 'disabled');
  assert.equal(binding.status, 'disabled');
  assert.equal(Object.hasOwn(result, 'newapiUserId'), false);
  assert.equal(Object.hasOwn(result, 'newapiAccessTokenEnc'), false);
  assert.equal(Object.hasOwn(result, 'newapiPasswordEnc'), false);
  assert.equal(
    audits.some(
      (row: any) =>
        row.action === 'newapi.user.binding_disable' &&
        row.status === 'success' &&
        row.operatorUserId === operator.id
    ),
    true
  );
});

test('confirmNewapiUserConflictForAdmin refuses a remote user already bound to another portal user', async () => {
  const first = await insertUser('portal_user_conflict_owner', 'aco@b.co');
  const second = await insertUser('portal_user_conflict_candidate', 'acc@b.co');
  await modules.db().insert(modules.newApiUserBinding).values({
    id: 'binding_conflict_owner',
    portalUserId: first.id,
    newapiUserId: 'remote_42',
    status: 'active',
    newapiUsername: 'aco@b.co',
    targetNewapiUsername: 'aco@b.co',
  });
  await modules.db().insert(modules.newApiUserBinding).values({
    id: 'binding_conflict_candidate',
    portalUserId: second.id,
    newapiUserId: 'pending:conflict',
    status: 'conflict_requires_review',
    targetNewapiUsername: 'acc@b.co',
    conflictNewapiUserId: 'remote_42',
  });

  await assert.rejects(
    modules.portal.confirmNewapiUserConflictForAdmin({
      portalUserId: second.id,
      newapiUserId: 'remote_42',
    }),
    /already bound/
  );
});

test('confirmNewapiUserConflictForAdmin activates a reviewed conflict and writes audit', async () => {
  const portalUser = await insertUser(
    'portal_user_conflict_confirm_success',
    'acs@b.co'
  );
  const operator = await insertUser(
    'operator_conflict_confirm_success',
    'opac@b.co'
  );
  await modules.db().insert(modules.newApiUserBinding).values({
    id: 'binding_conflict_confirm_success',
    portalUserId: portalUser.id,
    newapiUserId: 'pending:conflict-confirm',
    status: 'conflict_requires_review',
    targetNewapiUsername: 'acs@b.co',
    lastSyncErrorCode: 'conflict_requires_review',
    lastSyncError: 'Remote username requires admin review',
    conflictNewapiUserId: 'remote_43',
  });
  const profileReads: any[] = [];
  const fakeRemote = {
    getUserProfile: async (input: any) => {
      profileReads.push(input);
      return {
        newapiUserId: 'remote_43',
        username: 'acs@b.co',
        displayName: 'acs@b.co',
        group: 'ng-official',
        role: 1,
        remark: 'apipool:portalUserId:portal_user_conflict_confirm_success',
      };
    },
  };

  const result = await modules.portal.confirmNewapiUserConflictForAdmin({
    portalUserId: portalUser.id,
    newapiUserId: 'remote_43',
    operatorUserId: operator.id,
    client: fakeRemote,
  });

  const binding = await modules.portal.getPortalUserBinding(portalUser.id);
  const audits = await modules
    .db()
    .select()
    .from(modules.newApiBridgeAuditLog)
    .where(eq(modules.newApiBridgeAuditLog.portalUserId, portalUser.id));

  assert.deepEqual(profileReads[0], {
    newapiUserId: 'remote_43',
    username: 'acs@b.co',
  });
  assert.equal(result.status, 'active');
  assert.equal(Object.hasOwn(result, 'newapiAccessTokenEnc'), false);
  assert.equal(Object.hasOwn(result, 'newapiPasswordEnc'), false);
  assert.equal(Object.hasOwn(result, 'newapiUserId'), false);
  assert.equal(binding.status, 'active');
  assert.equal(binding.newapiUserId, 'remote_43');
  assert.equal(binding.newapiUsername, 'acs@b.co');
  assert.equal(binding.targetNewapiUsername, 'acs@b.co');
  assert.equal(binding.lastSyncErrorCode, null);
  assert.equal(binding.lastSyncError, null);
  assert.equal(binding.conflictNewapiUserId, null);
  assert.equal(
    audits.some(
      (row: any) =>
        row.action === 'newapi.user.conflict_confirm' &&
        row.status === 'success' &&
        row.operatorUserId === operator.id
    ),
    true
  );
});

test('retryNewapiUserBindingForAdmin provisions long emails and records operator on manual retry audit', async () => {
  const portalUser = await insertUser(
    'portal_user_manual_retry_long_email',
    'very-long-retry@example.com'
  );
  const operator = await insertUser(
    'operator_manual_retry_long_email',
    'oprt@b.co'
  );
  const provisionInputs: any[] = [];

  const result = await modules.portal.retryNewapiUserBindingForAdmin({
    portalUserId: portalUser.id,
    operatorUserId: operator.id,
    client: {
      provisionUser: async (input: any) => {
        provisionInputs.push(input);
        return {
          newapiUserId: 'remote_manual_retry_long',
          accessToken: 'token',
        };
      },
      ensureUserGroup: async () => {},
    },
  });

  const binding = await modules.portal.getPortalUserBinding(portalUser.id);

  const audits = await modules
    .db()
    .select()
    .from(modules.newApiBridgeAuditLog)
    .where(eq(modules.newApiBridgeAuditLog.portalUserId, portalUser.id));
  const successAudit = audits.find(
    (row: any) =>
      row.action === 'newapi.user.username_sync' &&
      row.status === 'success' &&
      row.idempotencyKey === `portal-user:${portalUser.id}:manual-retry`
  );

  assert.equal(result.status, 'active');
  assert.equal(binding.status, 'active');
  assert.match(binding.newapiUsername || '', /^pu_[a-f0-9]+$/);
  assert.equal(binding.targetNewapiUsername, 'very-long-retry@example.com');
  assert.equal(provisionInputs[0].username, binding.newapiUsername);
  assert.ok(successAudit, 'manual retry success should be audited');
  assert.equal(successAudit.operatorUserId, operator.id);
});

test('admin binding server actions require permission before current admin lookup and pass operator id', async () => {
  const source = await readFile(
    join(
      process.cwd(),
      'src/features/newapi-bridge/server/admin-user-binding-actions.ts'
    ),
    'utf8'
  );

  assert.match(source, /^'use server';/);
  assert.match(source, /PERMISSIONS\.USERS_WRITE/);
  assert.match(source, /getUserInfo\s*\(/);
  assert.match(source, /admin user session required/);
  assert.equal(
    (source.match(/operatorUserId:\s*currentUser\.id/g) || []).length,
    4
  );

  for (const actionName of [
    'retryNewapiUserBindingAction',
    'confirmNewapiUserConflictAction',
    'disableNewapiUserBindingAction',
    'restoreNewapiUserBindingAction',
  ]) {
    const actionStart = source.indexOf(`export async function ${actionName}`);
    assert.notEqual(actionStart, -1, `${actionName} should exist`);
    const permissionIndex = source.indexOf(
      'await requirePermission',
      actionStart
    );
    const currentUserIndex = source.indexOf(
      'const currentUser = await getCurrentAdminUser()',
      actionStart
    );
    assert.ok(
      permissionIndex !== -1 &&
        currentUserIndex !== -1 &&
        permissionIndex < currentUserIndex,
      `${actionName} should require permission before loading current admin`
    );
  }
});
