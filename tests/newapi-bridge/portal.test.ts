import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { createClient } from '@libsql/client';
import { eq } from 'drizzle-orm';

let modules: any;
let remoteKeySeq = 0;

async function setupPortalDb() {
  const dbPath = join(process.cwd(), '.tmp', 'portal-bridge.db');
  await mkdir(join(process.cwd(), '.tmp'), { recursive: true });
  await rm(dbPath, { force: true });

  process.env.DATABASE_PROVIDER = 'sqlite';
  process.env.DATABASE_URL = `file:${dbPath}`;
  process.env.DB_SCHEMA_FILE = './src/config/db/schema.sqlite.ts';
  process.env.DB_MIGRATIONS_OUT = './src/config/db/migrations_sqlite';
  process.env.DB_SINGLETON_ENABLED = 'false';
  process.env.APIPOOL_CREDENTIALS_SECRET = 'portal-test-secret';

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
  const {
    catalogGroup,
    newApiBridgeAuditLog,
    newApiKeyBinding,
    newApiUserBinding,
    usageLogSnapshot,
    usageSnapshot,
  } = await import('@/config/db/schema');
  const { db } = await import('@/core/db');
  const { NewApiBridgeError } = await import(
    '@/features/newapi-bridge/server/client'
  );
  const portal = await import('@/features/newapi-bridge/server/portal');
  const userModel = await import('@/shared/models/user');

  modules = {
    db,
    rawClient: client,
    newApiBridgeAuditLog,
    newApiKeyBinding,
    newApiUserBinding,
    NewApiBridgeError,
    portal,
    catalogGroup,
    usageLogSnapshot,
    usageSnapshot,
    userModel,
    user,
  };

  await modules.db().insert(modules.catalogGroup).values({
    id: 'catalog_group_portal_test',
    slug: 'portal-test',
    name: 'Portal Test',
    userDescription: 'Portal test route',
    newapiGroup: 'ng-portal-test',
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
    createKey: async () => {
      remoteKeySeq += 1;
      return {
        id: `remote_key_${remoteKeySeq}`,
        key: `sk-live-${remoteKeySeq}`,
        maskedKey: `sk-...${remoteKeySeq}`,
        status: 'active',
      };
    },
    disableKey: async (_user: any, newapiKeyId: string) => ({
      id: newapiKeyId,
      maskedKey: 'sk-...disabled',
      status: 'disabled',
    }),
    deleteKey: async (_user: any, newapiKeyId: string) => ({
      id: newapiKeyId,
      deleted: true,
    }),
    getQuota: async () => ({ balanceUsd: 25, quotaRemaining: 25 }),
    getUsageSummary: async () => ({
      requestCount: 1,
      inputTokens: 12,
      outputTokens: 8,
      spendUsd: 1,
      byModel: [
        { modelId: 'gpt-4o-mini', requests: 1, tokens: 20, spendUsd: 1 },
      ],
    }),
    listUsageLogs: async () => [
      {
        id: 'remote_request_successful_client',
        keyMasked: 'sk-...usage',
        modelId: 'gpt-4o-mini',
        status: 'success',
        inputTokens: 12,
        outputTokens: 8,
        spendUsd: 1,
        createdAt: '2026-05-24T10:00:00.000Z',
      },
    ],
  };
}

function portalKeyInput(name: string) {
  return { name, groupSlug: 'portal-test' };
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

test.before(setupPortalDb);

test('newapi user binding sync fields survive sqlite migrations', async () => {
  const portalUser = await insertUser(
    'portal_user_binding_sync_schema',
    'a@b.co'
  );
  const attemptedAt = new Date(1782931200000);
  const syncedAt = new Date(1783017600000);

  const [row] = await modules
    .db()
    .insert(modules.newApiUserBinding)
    .values({
      id: 'binding_sync_schema_row',
      portalUserId: portalUser.id,
      newapiUserId: 'pending:binding-sync-schema',
      status: 'username_sync_failed',
      newapiUsername: 'pu_legacy',
      targetNewapiUsername: 'a@b.co',
      lastSyncErrorCode: 'newapi_username_too_long',
      lastSyncError: 'New API username exceeds the Phase A limit',
      lastSyncAction: 'signup_provision',
      lastSyncedAt: syncedAt,
      lastSyncAttemptedAt: attemptedAt,
      conflictNewapiUserId: 'remote_conflict_42',
    })
    .returning();

  assert.equal(row.targetNewapiUsername, 'a@b.co');
  assert.equal(row.lastSyncErrorCode, 'newapi_username_too_long');
  assert.equal(row.lastSyncError, 'New API username exceeds the Phase A limit');
  assert.equal(row.lastSyncAction, 'signup_provision');
  assert.equal(row.conflictNewapiUserId, 'remote_conflict_42');
  assert.equal(row.lastSyncedAt?.getTime(), syncedAt.getTime());
  assert.equal(row.lastSyncAttemptedAt?.getTime(), attemptedAt.getTime());
});

test('getUsers can filter by New API binding status and sync error without exposing credentials', async () => {
  await modules
    .db()
    .delete(modules.newApiUserBinding)
    .where(eq(modules.newApiUserBinding.id, 'binding_sync_schema_row'));

  const userA = await insertUser('portal_user_filter_status', 'flt@b.co');
  const userB = await insertUser('portal_user_filter_other', 'flo@b.co');
  await modules
    .db()
    .insert(modules.newApiUserBinding)
    .values([
      {
        id: 'binding_filter_status',
        portalUserId: userA.id,
        newapiUserId: 'pending:filter-status',
        status: 'username_sync_failed',
        targetNewapiUsername: 'flt@b.co',
        lastSyncErrorCode: 'newapi_username_too_long',
        newapiAccessTokenEnc: 'secret-token',
        newapiPasswordEnc: 'secret-password',
      },
      {
        id: 'binding_filter_other',
        portalUserId: userB.id,
        newapiUserId: 'remote_other',
        status: 'active',
        targetNewapiUsername: 'flo@b.co',
      },
    ]);

  const rows = await modules.userModel.getUsers({
    newApiBindingStatus: 'username_sync_failed',
    lastSyncErrorCode: 'newapi_username_too_long',
    limit: 30,
  });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, userA.id);
  assert.equal(rows[0].newApiBinding?.status, 'username_sync_failed');
  assert.equal(
    rows[0].newApiBinding?.lastSyncErrorCode,
    'newapi_username_too_long'
  );
  assert.equal(
    Object.hasOwn(rows[0].newApiBinding || {}, 'newapiUserId'),
    false
  );
  assert.equal(
    Object.hasOwn(rows[0].newApiBinding || {}, 'newapiAccessTokenEnc'),
    false
  );
  assert.equal(
    Object.hasOwn(rows[0].newApiBinding || {}, 'newapiPasswordEnc'),
    false
  );
});

test('getUsers keeps users without New API bindings when binding filters are absent', async () => {
  const unboundUser = await insertUser(
    'portal_user_filter_unbound',
    'unbound@b.co'
  );

  const rows = await modules.userModel.getUsers({
    email: unboundUser.email,
    limit: 30,
  });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, unboundUser.id);
  assert.equal(rows[0].newApiBinding, null);
});

test('getUsersCount matches rows under New API binding status and sync error filters', async () => {
  const matchingUser = await insertUser(
    'portal_user_filter_count_match',
    'fcm@b.co'
  );
  const otherErrorUser = await insertUser(
    'portal_user_filter_count_other_error',
    'fco@b.co'
  );
  await modules
    .db()
    .insert(modules.newApiUserBinding)
    .values([
      {
        id: 'binding_filter_count_match',
        portalUserId: matchingUser.id,
        newapiUserId: 'pending:filter-count-match',
        status: 'username_sync_failed',
        targetNewapiUsername: 'fcm@b.co',
        lastSyncErrorCode: 'task5_count_error',
      },
      {
        id: 'binding_filter_count_other_error',
        portalUserId: otherErrorUser.id,
        newapiUserId: 'pending:filter-count-other-error',
        status: 'username_sync_failed',
        targetNewapiUsername: 'fco@b.co',
        lastSyncErrorCode: 'task5_other_error',
      },
    ]);

  const filters = {
    newApiBindingStatus: 'username_sync_failed',
    lastSyncErrorCode: 'task5_count_error',
    limit: 30,
  };
  const rows = await modules.userModel.getUsers(filters);
  const total = await modules.userModel.getUsersCount({
    newApiBindingStatus: filters.newApiBindingStatus,
    lastSyncErrorCode: filters.lastSyncErrorCode,
  });

  assert.equal(rows.length, 1);
  assert.equal(total, rows.length);
  assert.equal(rows[0].id, matchingUser.id);
});

test('normalizeNewapiUsernameEmail lowercases trims and accepts long verified emails', async () => {
  assert.deepEqual(
    modules.portal.normalizeNewapiUsernameEmail(' User@Example.COM '),
    {
      ok: true,
      username: 'user@example.com',
      remoteUsername: 'user@example.com',
      usesSurrogateUsername: false,
    }
  );
  assert.deepEqual(modules.portal.normalizeNewapiUsernameEmail('   '), {
    ok: false,
    code: 'portal_user_email_missing',
    message: 'Portal user email is missing',
  });
  assert.deepEqual(
    modules.portal.normalizeNewapiUsernameEmail('very-long-user@example.com'),
    {
      ok: true,
      username: 'very-long-user@example.com',
      remoteUsername: '',
      usesSurrogateUsername: true,
    }
  );
});

test('ensurePortalUserBinding provisions short normalized email usernames without pu hash', async () => {
  const portalUser = await insertUser(
    'portal_user_short_email_binding',
    ' A@B.CO '
  );
  const provisionInputs: any[] = [];
  const fakeRemote = {
    provisionUser: async (input: any) => {
      provisionInputs.push(input);
      return { newapiUserId: 'remote_short_email', accessToken: 'token' };
    },
    ensureUserGroup: async () => {},
  };

  const binding = await modules.portal.ensurePortalUserBinding(
    portalUser,
    fakeRemote
  );

  assert.equal(provisionInputs[0].username, 'a@b.co');
  assert.equal(provisionInputs[0].displayName, 'a@b.co');
  assert.equal(binding.status, 'active');
  assert.equal(binding.newapiUsername, 'a@b.co');
  assert.equal(binding.targetNewapiUsername, 'a@b.co');
  assert.equal(/^pu_/.test(binding.newapiUsername || ''), false);
});

test('ensurePortalUserBinding provisions long emails with a New API compatible username', async () => {
  const portalUser = await insertUser(
    'portal_user_long_email_binding',
    'very-long-bind@example.com'
  );
  const provisionInputs: any[] = [];
  const fakeRemote = {
    provisionUser: async (input: any) => {
      provisionInputs.push(input);
      return { newapiUserId: 'remote_long_email', accessToken: 'token' };
    },
    ensureUserGroup: async () => {},
  };

  const binding = await modules.portal.ensurePortalUserBinding(
    portalUser,
    fakeRemote
  );

  assert.match(provisionInputs[0].username, /^pu_[a-f0-9]+$/);
  assert.ok(provisionInputs[0].username.length <= 20);
  assert.equal(provisionInputs[0].displayName, provisionInputs[0].username);
  assert.equal(binding.status, 'active');
  assert.equal(binding.newapiUsername, provisionInputs[0].username);
  assert.equal(binding.targetNewapiUsername, 'very-long-bind@example.com');
  assert.equal(binding.lastSyncErrorCode, null);
  assert.equal(/^pu_/.test(binding.newapiUsername || ''), true);

  const audits = await modules
    .db()
    .select()
    .from(modules.newApiBridgeAuditLog)
    .where(eq(modules.newApiBridgeAuditLog.portalUserId, portalUser.id));
  const failedAudit = audits.find(
    (row: any) =>
      row.action === 'newapi.user.username_sync' && row.status === 'failed'
  );
  assert.equal(failedAudit, undefined);
});

test('ensurePortalUserBinding blocks empty emails with audit before remote calls', async () => {
  const portalUser = await insertUser('portal_user_empty_email_binding', '   ');
  let remoteCalled = false;
  const fakeRemote = {
    provisionUser: async () => {
      remoteCalled = true;
      throw new Error('remote should not be called');
    },
    ensureUserGroup: async () => {},
  };

  await assert.rejects(
    modules.portal.ensurePortalUserBinding(portalUser, fakeRemote),
    (error: any) => {
      assert.ok(error instanceof modules.NewApiBridgeError);
      assert.equal(error.code, 'portal_user_email_missing');
      return true;
    }
  );

  const binding = await modules.portal.getPortalUserBinding(portalUser.id);
  assert.equal(binding.status, 'username_sync_failed');
  assert.equal(binding.targetNewapiUsername, null);
  assert.equal(binding.lastSyncErrorCode, 'portal_user_email_missing');
  assert.equal(remoteCalled, false);

  const audits = await modules
    .db()
    .select()
    .from(modules.newApiBridgeAuditLog)
    .where(eq(modules.newApiBridgeAuditLog.portalUserId, portalUser.id));
  const failedAudit = audits.find(
    (row: any) =>
      row.action === 'newapi.user.username_sync' && row.status === 'failed'
  );
  assert.ok(failedAudit, 'empty email username block should be audited');
  assert.match(failedAudit.errorMessage || '', /email is missing/);
});

test('ensurePortalUserBinding syncs legacy active pu usernames before reuse', async () => {
  const portalUser = await insertUser(
    'portal_user_legacy_binding_sync',
    'c@d.co'
  );
  const updates: any[] = [];
  const fakeRemote = {
    provisionUser: async () => ({
      newapiUserId: '7',
      accessToken: 'token',
    }),
    ensureUserGroup: async () => {},
    updateUserProfile: async (input: any) => {
      updates.push(input);
      return {
        newapiUserId: input.newapiUserId,
        username: input.username,
        displayName: input.displayName,
        group: input.group || '',
        role: 1,
        remark: input.remark || '',
      };
    },
  };

  const first = await modules.portal.ensurePortalUserBinding(
    portalUser,
    fakeRemote
  );
  await modules
    .db()
    .update(modules.newApiUserBinding)
    .set({ newapiUsername: 'pu_legacy_user' })
    .where(eq(modules.newApiUserBinding.id, first.id));

  const synced = await modules.portal.ensurePortalUserBinding(
    portalUser,
    fakeRemote,
    { requiredNewapiGroup: 'ng-portal-test' }
  );

  assert.equal(updates[0].newapiUserId, '7');
  assert.equal(updates[0].currentUsername, 'pu_legacy_user');
  assert.equal(updates[0].username, 'c@d.co');
  assert.equal(updates[0].group, 'ng-portal-test');
  assert.equal(synced.status, 'active');
  assert.equal(synced.newapiUsername, 'c@d.co');
});

test('ensurePortalUserBinding stores conflict_requires_review candidates for existing remote usernames', async () => {
  const portalUser = await insertUser(
    'portal_user_conflict_binding',
    'conf@t.co'
  );
  const fakeRemote = {
    provisionUser: async () => {
      const error = new modules.NewApiBridgeError({
        code: 'conflict_requires_review',
        message: 'New API username already exists and requires review',
        conflictNewapiUserId: 'remote_conflict_7',
      });
      throw error;
    },
    ensureUserGroup: async () => {},
  };

  await assert.rejects(
    modules.portal.ensurePortalUserBinding(portalUser, fakeRemote),
    (error: any) => {
      assert.ok(error instanceof modules.NewApiBridgeError);
      assert.equal(error.code, 'conflict_requires_review');
      return true;
    }
  );

  const binding = await modules.portal.getPortalUserBinding(portalUser.id);
  assert.equal(binding.status, 'conflict_requires_review');
  assert.equal(binding.targetNewapiUsername, 'conf@t.co');
  assert.equal(binding.lastSyncErrorCode, 'conflict_requires_review');
  assert.equal(binding.conflictNewapiUserId, 'remote_conflict_7');
});

test('provisionPortalUserAfterSignup provisions long emails without throwing to auth', async () => {
  const portalUser = await insertUser(
    'portal_user_signup_long_email',
    'very-long-sign@example.com'
  );
  const provisionInputs: any[] = [];

  await modules.portal.provisionPortalUserAfterSignup(portalUser, {
    provisionUser: async (input: any) => {
      provisionInputs.push(input);
      return { newapiUserId: 'remote_signup_long', accessToken: 'token' };
    },
    ensureUserGroup: async () => {},
  });

  const binding = await modules.portal.getPortalUserBinding(portalUser.id);
  assert.equal(binding.status, 'active');
  assert.match(binding.newapiUsername || '', /^pu_[a-f0-9]+$/);
  assert.equal(binding.targetNewapiUsername, 'very-long-sign@example.com');
  assert.equal(binding.lastSyncAction, 'signup_provision');
  assert.equal(binding.lastSyncErrorCode, null);
  assert.equal(provisionInputs[0].username, binding.newapiUsername);
});

test('updatePortalUserEmailWithNewapiSync updates local email only after remote username succeeds', async () => {
  const portalUser = await insertUser(
    'portal_user_email_change_short',
    'e4s0@b.co'
  );
  const operator = await insertUser(
    'operator_email_change_short',
    'ops4s@b.co'
  );
  const updates: any[] = [];
  const fakeRemote = {
    provisionUser: async () => ({
      newapiUserId: 'remote_email_change_short',
      accessToken: 'token',
    }),
    ensureUserGroup: async () => {},
    updateUserProfile: async (input: any) => {
      updates.push(input);
      return {
        newapiUserId: input.newapiUserId,
        username: input.username,
        displayName: input.displayName,
        group: input.group || '',
        role: 1,
        remark: input.remark || '',
      };
    },
  };
  await modules.portal.ensurePortalUserBinding(portalUser, fakeRemote);

  const result = await modules.portal.updatePortalUserEmailWithNewapiSync({
    portalUserId: portalUser.id,
    newEmail: ' E4S1@B.CO ',
    operatorUserId: operator.id,
    client: fakeRemote,
  });

  const [updated] = await modules
    .db()
    .select()
    .from(modules.user)
    .where(eq(modules.user.id, portalUser.id))
    .limit(1);
  const binding = await modules.portal.getPortalUserBinding(portalUser.id);

  assert.equal(result.status, 'active');
  assert.equal(updates[0].username, 'e4s1@b.co');
  assert.equal(updated.email, 'e4s1@b.co');
  assert.equal(binding.newapiUsername, 'e4s1@b.co');
  assert.equal(binding.lastSyncAction, 'email_change');
});

test('updatePortalUserEmailWithNewapiSync commits long emails after remote username succeeds', async () => {
  const portalUser = await insertUser(
    'portal_user_email_change_long',
    'e4l0@b.co'
  );
  const operator = await insertUser('operator_email_change_long', 'ops4l@b.co');

  const result = await modules.portal.updatePortalUserEmailWithNewapiSync({
    portalUserId: portalUser.id,
    newEmail: 'very-long-user@example.com',
    operatorUserId: operator.id,
    client: createSuccessfulRemoteClient(),
  });

  const [updated] = await modules
    .db()
    .select()
    .from(modules.user)
    .where(eq(modules.user.id, portalUser.id))
    .limit(1);
  const binding = await modules.portal.getPortalUserBinding(portalUser.id);

  assert.equal(result.status, 'active');
  assert.equal(updated.email, 'very-long-user@example.com');
  assert.equal(binding.status, 'active');
  assert.match(binding.newapiUsername || '', /^pu_[a-f0-9]+$/);
  assert.equal(binding.targetNewapiUsername, 'very-long-user@example.com');
  assert.equal(binding.lastSyncErrorCode, null);
});

test('updatePortalUserEmailWithNewapiSync lets admins replace a previously blocked long email with a short email', async () => {
  const portalUser = await insertUser(
    'portal_user_email_change_from_long',
    'very-long-old-email@example.com'
  );
  const operator = await insertUser(
    'operator_email_change_from_long',
    'op4x@b.co'
  );
  await modules.db().insert(modules.newApiUserBinding).values({
    id: 'binding_email_change_from_long',
    portalUserId: portalUser.id,
    newapiUserId: 'pending:email-change-from-long',
    status: 'username_sync_failed',
    targetNewapiUsername: 'very-long-old-email@example.com',
    lastSyncErrorCode: 'newapi_username_too_long',
    lastSyncError: 'New API username exceeds the Phase A limit',
    lastSyncAction: 'email_change',
  });
  const provisions: any[] = [];
  const updates: any[] = [];
  const fakeRemote = {
    provisionUser: async (input: any) => {
      provisions.push(input);
      return {
        newapiUserId: 'remote_email_change_from_long',
        accessToken: 'token-from-long',
      };
    },
    ensureUserGroup: async () => {},
    updateUserProfile: async (input: any) => {
      updates.push(input);
      return {
        newapiUserId: input.newapiUserId,
        username: input.username,
        displayName: input.displayName,
        group: input.group || '',
        role: 1,
        remark: input.remark || '',
      };
    },
  };

  const result = await modules.portal.updatePortalUserEmailWithNewapiSync({
    portalUserId: portalUser.id,
    newEmail: ' E4X@B.CO ',
    operatorUserId: operator.id,
    client: fakeRemote,
  });

  const [updated] = await modules
    .db()
    .select()
    .from(modules.user)
    .where(eq(modules.user.id, portalUser.id))
    .limit(1);
  const binding = await modules.portal.getPortalUserBinding(portalUser.id);

  assert.equal(result.status, 'active');
  assert.equal(provisions.length, 1);
  assert.equal(provisions[0].username, 'e4x@b.co');
  assert.equal(updates.length, 0);
  assert.equal(updated.email, 'e4x@b.co');
  assert.equal(binding.status, 'active');
  assert.equal(binding.newapiUserId, 'remote_email_change_from_long');
  assert.equal(binding.newapiUsername, 'e4x@b.co');
  assert.equal(binding.targetNewapiUsername, 'e4x@b.co');
  assert.equal(binding.lastSyncErrorCode, null);
});

test('updatePortalUserEmailWithNewapiSync records local_commit_failed when remote update succeeds but local transaction fails', async () => {
  const portalUser = await insertUser(
    'portal_user_email_change_local_fail',
    'e4f0@b.co'
  );
  const operator = await insertUser(
    'operator_email_change_local_fail',
    'ops4f@b.co'
  );
  await insertUser('portal_user_email_change_conflicting_email', 'e4f1@b.co');
  const updates: any[] = [];
  const fakeRemote = {
    provisionUser: async () => ({
      newapiUserId: 'remote_email_change_local_fail',
      accessToken: 'token',
    }),
    ensureUserGroup: async () => {},
    updateUserProfile: async (input: any) => {
      updates.push(input);
      return {
        newapiUserId: input.newapiUserId,
        username: input.username,
        displayName: input.displayName,
        group: input.group || '',
        role: 1,
        remark: input.remark || '',
      };
    },
  };
  await modules.portal.ensurePortalUserBinding(portalUser, fakeRemote);

  const result = await modules.portal.updatePortalUserEmailWithNewapiSync({
    portalUserId: portalUser.id,
    newEmail: 'e4f1@b.co',
    operatorUserId: operator.id,
    client: fakeRemote,
  });

  const [updated] = await modules
    .db()
    .select()
    .from(modules.user)
    .where(eq(modules.user.id, portalUser.id))
    .limit(1);
  const binding = await modules.portal.getPortalUserBinding(portalUser.id);
  const audits = await modules
    .db()
    .select()
    .from(modules.newApiBridgeAuditLog)
    .where(eq(modules.newApiBridgeAuditLog.portalUserId, portalUser.id));

  assert.equal(updates.length, 1);
  assert.equal(result.status, 'username_sync_failed');
  assert.equal(updated.email, 'e4f0@b.co');
  assert.equal(binding.status, 'username_sync_failed');
  assert.equal(binding.targetNewapiUsername, 'e4f1@b.co');
  assert.equal(binding.lastSyncErrorCode, 'local_commit_failed');
  assert.match(
    binding.lastSyncError || '',
    /remote username may already be updated/i
  );
  assert.equal(
    audits.some(
      (row: any) =>
        row.action === 'newapi.user.username_sync' &&
        row.status === 'failed' &&
        /local_commit_failed/.test(row.errorMessage || '')
    ),
    true
  );
});

test('ensurePortalUserBinding keeps disabled bindings disabled and avoids remote calls', async () => {
  const portalUser = await insertUser(
    'portal_user_disabled_binding_guard',
    'dbg@b.co'
  );
  const operator = await insertUser(
    'operator_disabled_binding_guard',
    'opdg@b.co'
  );
  await modules.portal.ensurePortalUserBinding(
    portalUser,
    createSuccessfulRemoteClient()
  );
  await modules.portal.disableNewapiUserBindingForAdmin({
    portalUserId: portalUser.id,
    reason: 'security review',
    operatorUserId: operator.id,
  });
  let remoteCalls = 0;
  const forbiddenRemote = {
    provisionUser: async () => {
      remoteCalls += 1;
      throw new Error('remote provision should not be called');
    },
    ensureUserGroup: async () => {
      remoteCalls += 1;
      throw new Error('remote group sync should not be called');
    },
    updateUserProfile: async () => {
      remoteCalls += 1;
      throw new Error('remote profile update should not be called');
    },
  };

  await assert.rejects(
    modules.portal.ensurePortalUserBinding(portalUser, forbiddenRemote),
    (error: any) => {
      assert.ok(error instanceof modules.NewApiBridgeError);
      assert.equal(error.code, 'forbidden');
      return true;
    }
  );

  const binding = await modules.portal.getPortalUserBinding(portalUser.id);
  assert.equal(binding.status, 'disabled');
  assert.equal(remoteCalls, 0);
});

test('restoreNewapiUserBindingForAdmin recovers a disabled binding through the idempotent provision path', async () => {
  const portalUser = await insertUser(
    'portal_user_restore_binding',
    'rsb@b.co'
  );
  const operator = await insertUser('operator_restore_binding', 'oprs@b.co');
  await modules.portal.ensurePortalUserBinding(
    portalUser,
    createSuccessfulRemoteClient()
  );
  await modules.portal.disableNewapiUserBindingForAdmin({
    portalUserId: portalUser.id,
    reason: 'mistaken click',
    operatorUserId: operator.id,
  });

  const restored = await modules.portal.restoreNewapiUserBindingForAdmin({
    portalUserId: portalUser.id,
    operatorUserId: operator.id,
    client: createSuccessfulRemoteClient(),
  });

  assert.equal(restored.status, 'active');
  const binding = await modules.portal.getPortalUserBinding(portalUser.id);
  assert.equal(binding.status, 'active');

  // 恢复后常规链路（建 Key / 充值前置）不再被 forbidden 挡住
  const ensured = await modules.portal.ensurePortalUserBinding(
    portalUser,
    createSuccessfulRemoteClient()
  );
  assert.equal(ensured.status, 'active');
});

test('restoreNewapiUserBindingForAdmin rejects bindings that are not disabled', async () => {
  const portalUser = await insertUser(
    'portal_user_restore_active_guard',
    'rsa@b.co'
  );
  const operator = await insertUser(
    'operator_restore_active_guard',
    'opra@b.co'
  );
  await modules.portal.ensurePortalUserBinding(
    portalUser,
    createSuccessfulRemoteClient()
  );

  await assert.rejects(
    modules.portal.restoreNewapiUserBindingForAdmin({
      portalUserId: portalUser.id,
      operatorUserId: operator.id,
      client: createSuccessfulRemoteClient(),
    }),
    /not disabled/
  );
});

test('restoreNewapiUserBindingForAdmin surfaces the degraded state when the remote retry fails', async () => {
  const portalUser = await insertUser(
    'portal_user_restore_degraded',
    'rsd@b.co'
  );
  const operator = await insertUser('operator_restore_degraded', 'oprd@b.co');
  await modules.portal.ensurePortalUserBinding(
    portalUser,
    createSuccessfulRemoteClient()
  );
  await modules.portal.disableNewapiUserBindingForAdmin({
    portalUserId: portalUser.id,
    reason: 'security review',
    operatorUserId: operator.id,
  });

  const failingRemote = {
    provisionUser: async () => {
      throw new Error('remote temporarily down');
    },
    ensureUserGroup: async () => {},
    updateUserProfile: async () => {
      throw new Error('remote temporarily down');
    },
  } as any;

  // 恢复动作本身不抛：本地已离开 disabled，远端失败按常规同步失败记录
  const restored = await modules.portal.restoreNewapiUserBindingForAdmin({
    portalUserId: portalUser.id,
    operatorUserId: operator.id,
    client: failingRemote,
  });

  assert.notEqual(restored.status, 'disabled');
  const binding = await modules.portal.getPortalUserBinding(portalUser.id);
  assert.notEqual(binding.status, 'disabled');
  assert.ok(binding.lastSyncError);
});

test('a disable landing mid-restore is not silently reverted to active', async () => {
  const portalUser = await insertUser('portal_user_restore_race', 'rsrc@b.co');
  const operator = await insertUser('operator_restore_race', 'oprr@b.co');
  await modules.portal.ensurePortalUserBinding(
    portalUser,
    createSuccessfulRemoteClient()
  );
  await modules.portal.disableNewapiUserBindingForAdmin({
    portalUserId: portalUser.id,
    reason: 'security review',
    operatorUserId: operator.id,
  });

  const racingRemote = {
    provisionUser: async (input: { username: string }) => {
      // 远端供给在飞时，另一名管理员再次停用该绑定
      await modules.portal.disableNewapiUserBindingForAdmin({
        portalUserId: portalUser.id,
        reason: 'second disable wins',
        operatorUserId: operator.id,
      });
      return {
        newapiUserId: `remote_${input.username}`,
        accessToken: 'test-access-token',
      };
    },
    ensureUserGroup: async () => {},
    updateUserProfile: async () => {
      throw new Error('should not be called');
    },
  } as any;

  await modules.portal
    .restoreNewapiUserBindingForAdmin({
      portalUserId: portalUser.id,
      operatorUserId: operator.id,
      client: racingRemote,
    })
    .catch(() => undefined);

  // 较新的停用决定必须胜出，不能被在途恢复写回 active
  const binding = await modules.portal.getPortalUserBinding(portalUser.id);
  assert.equal(binding.status, 'disabled');
});

test('restoreNewapiUserBindingForAdmin claims the disabled row atomically', async () => {
  const portalUser = await insertUser('portal_user_restore_cas', 'rscas@b.co');
  const operator = await insertUser('operator_restore_cas', 'oprcas@b.co');
  await modules.portal.ensurePortalUserBinding(
    portalUser,
    createSuccessfulRemoteClient()
  );
  await modules.portal.disableNewapiUserBindingForAdmin({
    portalUserId: portalUser.id,
    reason: 'mistaken click',
    operatorUserId: operator.id,
  });

  // 两个并发恢复，只有一个能 claim 到 disabled 行
  const results = await Promise.allSettled([
    modules.portal.restoreNewapiUserBindingForAdmin({
      portalUserId: portalUser.id,
      operatorUserId: operator.id,
      client: createSuccessfulRemoteClient(),
    }),
    modules.portal.restoreNewapiUserBindingForAdmin({
      portalUserId: portalUser.id,
      operatorUserId: operator.id,
      client: createSuccessfulRemoteClient(),
    }),
  ]);

  const rejected = results.filter((r) => r.status === 'rejected');
  assert.equal(rejected.length, 1);
});

test('adjustPortalQuota applies ledger for long email users after binding succeeds', async () => {
  const portalUser = await insertUser(
    'portal_user_long_email_quota',
    'very-long-quota@example.com'
  );
  const operator = await insertUser('operator_long_email_quota', 'ops@b.co');
  const fakeRemote = {
    provisionUser: async (input: { username: string }) => ({
      newapiUserId: `remote_${input.username}`,
      accessToken: 'test-access-token',
    }),
    adjustQuota: async () => ({
      changeId: 'change_long_email_quota_1',
      balanceUsd: 10,
    }),
  } as any;

  const ledger = await modules.portal.adjustPortalQuota({
    portalUser,
    operatorUserId: operator.id,
    amountUsd: 10,
    reason: 'long email recharge',
    idempotencyKey: 'long-email-quota-applied',
    client: fakeRemote,
  });

  const rows = await modules.portal.listAdjustmentLedgerByPortalUser(
    portalUser.id
  );
  const binding = await modules.portal.getPortalUserBinding(portalUser.id);
  assert.equal(ledger.status, 'applied');
  assert.equal(ledger.newapiChangeId, 'change_long_email_quota_1');
  assert.equal(
    rows.some((row: any) => row.status === 'applied'),
    true
  );
  assert.equal(binding.status, 'active');
  assert.match(binding.newapiUsername || '', /^pu_[a-f0-9]+$/);
  assert.equal(binding.targetNewapiUsername, 'very-long-quota@example.com');
});

test('long-email quota adjustment records no failed username sync audit', async () => {
  const portalUser = await insertUser(
    'portal_user_long_email_ledger_regression',
    'very-long-ledger@example.com'
  );
  const operator = await insertUser(
    'operator_long_email_ledger_regression',
    'op6@b.co'
  );
  const fakeRemote = {
    provisionUser: async (input: { username: string }) => ({
      newapiUserId: `remote_${input.username}`,
      accessToken: 'test-access-token',
    }),
    adjustQuota: async () => ({
      changeId: 'change_long_email_ledger_regression_1',
      balanceUsd: 20,
    }),
  } as any;

  const applied = await modules.portal.adjustPortalQuota({
    portalUser,
    operatorUserId: operator.id,
    amountUsd: 20,
    reason: 'regression guard',
    idempotencyKey: 'long-email-ledger-regression',
    client: fakeRemote,
  });

  const ledger = await modules.portal.listAdjustmentLedgerByPortalUser(
    portalUser.id
  );
  const audits = await modules
    .db()
    .select()
    .from(modules.newApiBridgeAuditLog)
    .where(eq(modules.newApiBridgeAuditLog.portalUserId, portalUser.id));

  assert.equal(applied.status, 'applied');
  assert.equal(
    ledger.some((row: any) => row.status === 'applied'),
    true
  );
  assert.equal(
    audits.some(
      (row: any) =>
        row.action === 'newapi.user.username_sync' && row.status === 'failed'
    ),
    false
  );
});

test('getPortalUsage lazily provisions missing signup binding and returns zero balance for new users', async () => {
  const portalUser = await insertUser(
    'portal_user_usage_lazy_signup',
    'lazy-signup@example.com'
  );
  const provisionInputs: any[] = [];
  const fakeRemote = {
    provisionUser: async (input: any) => {
      provisionInputs.push(input);
      return { newapiUserId: 'remote_lazy_signup', accessToken: 'token' };
    },
    getQuota: async () => ({ balanceUsd: 0, quotaRemaining: 0 }),
    getUsageSummary: async () => ({
      requestCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      byModel: [],
    }),
    listUsageLogs: async () => [],
  } as any;

  const usage = await modules.portal.getPortalUsage(
    portalUser,
    '7d',
    fakeRemote
  );
  const binding = await modules.portal.getPortalUserBinding(portalUser.id);

  assert.match(provisionInputs[0].username, /^pu_[a-f0-9]+$/);
  assert.ok(provisionInputs[0].username.length <= 20);
  assert.equal(binding.status, 'active');
  assert.equal(binding.newapiUsername, provisionInputs[0].username);
  assert.equal(binding.targetNewapiUsername, 'lazy-signup@example.com');
  assert.equal(usage.summary.balanceUsd, 0);
  assert.equal(usage.summary.quotaRemaining, 0);
  assert.equal(usage.summary.status, 'empty');
});

test('getPortalUsage reports an unknown balance when the signup binding is temporarily unavailable', async () => {
  const portalUser = await insertUser(
    'portal_user_usage_lazy_signup_down',
    'lazy-down@example.com'
  );
  let provisionCalls = 0;
  const failingRemote = {
    provisionUser: async () => {
      provisionCalls += 1;
      throw new modules.NewApiBridgeError({
        code: 'timeout',
        message: 'New API is temporarily unavailable',
      });
    },
  } as any;

  const usage = await modules.portal.getPortalUsage(
    portalUser,
    '7d',
    failingRemote
  );

  assert.equal(provisionCalls, 1);
  // 同步失败 != 余额为零。写成 0 会让控制台显示 $0.00 并误弹「余额不足，去充值」，
  // 击穿 isLowBalance 专门设计的「undefined 不告警」（balance-warning-view.ts）。
  assert.equal(usage.summary.balanceUsd, undefined);
  assert.equal(usage.summary.status, 'failed');
  // 桥接错误无可安全展示的文案 → undefined，页面显示已本地化的 usageSync.failed
  assert.equal(usage.summary.errorMessage, undefined);
});

test('createPortalApiKey 只写本地哈希 Key 且不调用 New API', async () => {
  const portalUser = await insertUser(
    'portal_user_local_key_create',
    'local-key@b.co'
  );
  let remoteCalls = 0;
  const remoteMustNotRun = new Proxy(
    {},
    {
      get() {
        remoteCalls += 1;
        throw new Error('local key lifecycle must not call New API');
      },
    }
  );

  const result = await modules.portal.createPortalApiKey(
    portalUser,
    portalKeyInput('local-only-key'),
    remoteMustNotRun as any
  );
  const keys = await modules.portal.listPortalApiKeys(
    portalUser.id,
    remoteMustNotRun as any
  );

  assert.match(result.plainKey, /^sk-ap-[A-Za-z0-9_-]{43}$/);
  assert.equal(result.binding.keyMasked, result.binding.keyPrefix);
  assert.equal(
    result.binding.keyMasked.endsWith(result.plainKey.slice(-4)),
    true
  );
  assert.equal(keys.length, 1);
  assert.equal(keys[0].legacy, false);
  assert.equal(remoteCalls, 0);
  assertNoFields(keys[0], [
    'newapiUserId',
    'newapiKeyId',
    'newapiGroup',
    'keyHash',
  ]);
});

test('门户本地 Key 生命周期校验所有权并保持禁用/删除幂等', async () => {
  const owner = await insertUser('portal_user_local_key_owner', 'owner@b.co');
  const other = await insertUser('portal_user_local_key_other', 'other@b.co');
  const created = await modules.portal.createPortalApiKey(
    owner,
    portalKeyInput('owner-local-key')
  );

  await assert.rejects(
    modules.portal.disablePortalApiKey(other.id, created.binding.id),
    /not found/i
  );
  await assert.rejects(
    modules.portal.deletePortalApiKey(other.id, created.binding.id),
    /not found/i
  );

  const disabled = await modules.portal.disablePortalApiKey(
    owner.id,
    created.binding.id
  );
  const disabledReplay = await modules.portal.disablePortalApiKey(
    owner.id,
    created.binding.id
  );
  assert.equal(disabled.status, 'disabled');
  assert.equal(disabledReplay.status, 'disabled');

  const deleted = await modules.portal.deletePortalApiKey(
    owner.id,
    created.binding.id
  );
  const deletedReplay = await modules.portal.deletePortalApiKey(
    owner.id,
    created.binding.id
  );
  assert.equal(deleted.status, 'deleted');
  assert.equal(deletedReplay.status, 'deleted');
});

test('listPortalApiKeys 合并旧 Key 为只读 legacy 行且不做远端同步', async () => {
  const portalUser = await insertUser(
    'portal_user_legacy_key_readonly',
    'legacy-key@b.co'
  );
  await modules.db().insert(modules.newApiKeyBinding).values({
    id: 'legacy_key_readonly',
    portalUserId: portalUser.id,
    newapiUserId: 'legacy-newapi-user',
    newapiKeyId: 'legacy-newapi-key',
    keyMasked: 'sk-...legacy',
    displayName: 'Legacy key',
    status: 'active',
    allowedModels: '[]',
    groupId: 'catalog_group_portal_test',
    newapiGroup: 'ng-portal-test',
    idempotencyKey: 'legacy-key-readonly-idempotency',
  });
  let remoteCalls = 0;
  const remoteMustNotRun = new Proxy(
    {},
    {
      get() {
        remoteCalls += 1;
        throw new Error('legacy list must not call New API');
      },
    }
  );

  const keys = await modules.portal.listPortalApiKeys(
    portalUser.id,
    remoteMustNotRun as any
  );

  assert.equal(keys.length, 1);
  assert.equal(keys[0].legacy, true);
  assert.equal(keys[0].keyMasked, 'sk-...legacy');
  assert.equal(remoteCalls, 0);
  await assert.rejects(
    modules.portal.disablePortalApiKey(
      portalUser.id,
      'legacy_key_readonly',
      remoteMustNotRun as any
    ),
    /read-only/i
  );
  await assert.rejects(
    modules.portal.deletePortalApiKey(
      portalUser.id,
      'legacy_key_readonly',
      remoteMustNotRun as any
    ),
    /read-only/i
  );
});
test('adjustPortalQuota applies ledger only after New API returns a change id', async () => {
  const portalUser = await insertUser(
    'portal_user_adjust_success',
    'adj1@t.co'
  );
  const operator = await insertUser('operator_adjust_success', 'ops1@t.co');
  const fakeRemote = {
    provisionUser: async (input: { username: string }) => ({
      newapiUserId: `remote_${input.username}`,
      accessToken: 'test-access-token',
    }),
    adjustQuota: async () => ({
      changeId: 'change_success_1',
      balanceUsd: 25,
    }),
  } as any;

  const ledger = await modules.portal.adjustPortalQuota({
    portalUser,
    operatorUserId: operator.id,
    amountUsd: 25,
    reason: 'Manual MVP credit',
    client: fakeRemote,
  });

  assert.equal(ledger.status, 'applied');
  assert.equal(ledger.newapiChangeId, 'change_success_1');
  assert.equal(ledger.rollbackStatus, 'not_required');
});

test('adjustPortalQuota reuses an idempotency key without applying quota twice', async () => {
  const portalUser = await insertUser(
    'portal_user_adjust_idempotent',
    'adj2@t.co'
  );
  const operator = await insertUser('operator_adjust_idempotent', 'ops2@t.co');
  let adjustmentCalls = 0;
  const fakeRemote = {
    provisionUser: async (input: { username: string }) => ({
      newapiUserId: `remote_${input.username}`,
      accessToken: 'test-access-token',
    }),
    adjustQuota: async () => {
      adjustmentCalls += 1;
      return {
        changeId: 'change_idempotent_1',
        balanceUsd: 25,
      };
    },
  } as any;
  const input = {
    portalUser,
    operatorUserId: operator.id,
    amountUsd: 25,
    reason: 'Manual MVP idempotent credit',
    idempotencyKey: 'portal-adjustment:test-idempotency-key',
    client: fakeRemote,
  };

  const first = await modules.portal.adjustPortalQuota(input);
  const second = await modules.portal.adjustPortalQuota(input);

  assert.equal(first.id, second.id);
  assert.equal(first.status, 'applied');
  assert.equal(second.status, 'applied');
  assert.equal(adjustmentCalls, 1);

  const entries = await modules.portal.listLedgerEntries(portalUser.id);
  assert.equal(entries.length, 1);
});

test('customer ledger list does not expose New API or operator internals', async () => {
  const portalUser = await insertUser(
    'portal_user_safe_ledger_dto',
    'ledg@t.co'
  );
  const operator = await insertUser('operator_safe_ledger_dto', 'ops3@t.co');
  const fakeRemote = {
    provisionUser: async (input: { username: string }) => ({
      newapiUserId: `remote_${input.username}`,
      accessToken: 'test-access-token',
    }),
    adjustQuota: async () => ({
      changeId: 'change_safe_ledger_1',
      balanceUsd: 15,
    }),
  } as any;

  await modules.portal.adjustPortalQuota({
    portalUser,
    operatorUserId: operator.id,
    amountUsd: 15,
    reason: 'Manual MVP credit',
    client: fakeRemote,
  });

  const entries = await modules.portal.listLedgerEntries(portalUser.id);
  assert.equal(entries.length, 1);
  assertNoFields(entries[0], [
    'portalUserId',
    'operatorUserId',
    'newapiUserId',
    'newapiChangeId',
    'executor',
  ]);
});

test('adjustPortalQuota keeps failed remote adjustment as unapplied ledger entry', async () => {
  const portalUser = await insertUser(
    'portal_user_adjust_failure',
    'adjf@t.co'
  );
  const operator = await insertUser('operator_adjust_failure', 'ops4@t.co');
  const fakeRemote = {
    provisionUser: async (input: { username: string }) => ({
      newapiUserId: `remote_${input.username}`,
      accessToken: 'test-access-token',
    }),
    adjustQuota: async () => {
      throw new modules.NewApiBridgeError({
        code: 'timeout',
        message: 'quota adjust timed out',
      });
    },
  } as any;

  const ledger = await modules.portal.adjustPortalQuota({
    portalUser,
    operatorUserId: operator.id,
    amountUsd: 25,
    reason: 'Manual MVP credit',
    client: fakeRemote,
  });

  assert.equal(ledger.status, 'failed');
  assert.equal(ledger.newapiChangeId, null);
  assert.equal(ledger.rollbackStatus, 'not_required');

  const entries = await modules.portal.listLedgerEntries(portalUser.id);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].status, 'failed');
  assert.equal(entries[0].rollbackStatus, 'not_required');
});

test('adjustPortalQuota persists the remote attempt marker before any remote side effect', async () => {
  const portalUser = await insertUser('portal_user_adjust_marker', 'adjm@t.co');
  const operator = await insertUser('operator_adjust_marker', 'opsm@t.co');
  const { apipoolLedgerEntry } = await import('@/config/db/schema');
  const idempotencyKey = 'portal-adjustment:test-remote-marker';

  let markerAtCall: unknown;
  const fakeRemote = {
    provisionUser: async (input: { username: string }) => ({
      newapiUserId: `remote_${input.username}`,
      accessToken: 'test-access-token',
    }),
    adjustQuota: async () => {
      // adjustQuota 的第一件事就是 POST /api/redemption/（远端副作用）。
      // 在它被调用之前，ledger 必须已经留下「远端已尝试」的持久化证据。
      const rows = await modules
        .db()
        .select()
        .from(apipoolLedgerEntry)
        .where(eq(apipoolLedgerEntry.idempotencyKey, idempotencyKey));
      markerAtCall = rows[0]?.remoteAttemptAt;
      return { changeId: 'change_marker_1', balanceUsd: 25 };
    },
  } as any;

  const ledger = await modules.portal.adjustPortalQuota({
    portalUser,
    operatorUserId: operator.id,
    amountUsd: 25,
    reason: 'Manual MVP credit',
    idempotencyKey,
    client: fakeRemote,
  });

  assert.equal(ledger.status, 'applied');
  assert.ok(
    markerAtCall instanceof Date,
    'remoteAttemptAt must be persisted before adjustQuota runs'
  );
});

test('adjustPortalQuota stores the redemption code before dispatch and escalates later failures', async () => {
  const portalUser = await insertUser(
    'portal_user_adjust_precommit',
    'adjp@t.co'
  );
  const operator = await insertUser('operator_adjust_precommit', 'opsp@t.co');
  const { apipoolLedgerEntry } = await import('@/config/db/schema');
  const idempotencyKey = 'portal-adjustment:test-code-precommit';

  let changeIdAtDispatch: string | null | undefined;
  const fakeRemote = {
    provisionUser: async (input: { username: string }) => ({
      newapiUserId: `remote_${input.username}`,
      accessToken: 'test-access-token',
    }),
    adjustQuota: async (input: any) => {
      // 兑换码已生成，尚未发出兑换请求
      await input.onRedemptionCreated?.('code-adjust-precommit');
      const rows = await modules
        .db()
        .select()
        .from(apipoolLedgerEntry)
        .where(eq(apipoolLedgerEntry.idempotencyKey, idempotencyKey));
      changeIdAtDispatch = rows[0]?.newapiChangeId;
      // 模拟兑换请求飞行途中进程被杀：普通错误，非 reconciliation
      throw new Error('process killed mid-topup');
    },
  } as any;

  const ledger = await modules.portal.adjustPortalQuota({
    portalUser,
    operatorUserId: operator.id,
    amountUsd: 25,
    reason: 'Manual MVP credit',
    idempotencyKey,
    client: fakeRemote,
  });

  // 码值必须在发出兑换请求之前落库，否则崩溃后无从判断远端是否已入账
  assert.equal(changeIdAtDispatch, 'code-adjust-precommit');
  // 码已发出后的任何失败都不能落终态 failed：远端可能已入账，
  // 管理员换个幂等键重试会生成第二张码 → 双倍到账。
  assert.equal(ledger.status, 'reconciliation_required');
  assert.equal(ledger.newapiChangeId, 'code-adjust-precommit');
});

async function seedAdjustmentLedgerRow(input: {
  id: string;
  portalUserId: string;
  operatorUserId: string;
  status: string;
  remoteAttemptAt: Date | null;
  updatedAt?: Date;
}) {
  const { apipoolLedgerEntry } = await import('@/config/db/schema');
  await modules
    .db()
    .insert(apipoolLedgerEntry)
    .values({
      id: input.id,
      portalUserId: input.portalUserId,
      operatorUserId: input.operatorUserId,
      newapiUserId: 'remote_seeded',
      idempotencyKey: `portal-adjustment:${input.id}`,
      amountUsd: 5,
      source: 'manual_adjustment',
      status: input.status,
      executor: 'internal_quota_executor',
      reason: 'seeded row',
      remoteAttemptAt: input.remoteAttemptAt,
    });
  if (input.updatedAt) {
    // drizzle 的 $onUpdate 会覆写 updatedAt，只能走原始 SQL 造陈旧行
    await modules.rawClient.execute({
      sql: 'UPDATE apipool_ledger_entry SET updated_at = ? WHERE id = ?',
      args: [input.updatedAt.getTime(), input.id],
    });
  }
}

let countingClientSeq = 0;

function createCountingRemoteClient() {
  let adjustCalls = 0;
  // changeId 上有唯一索引：夹具若对每个实例返回同一个码值，第二次落库会撞
  // 索引并被正确地判为「远端已动、结局未知」，看起来像被测代码的 bug。
  countingClientSeq += 1;
  const changeId = `change_counting_${countingClientSeq}`;
  return {
    client: {
      provisionUser: async (input: { username: string }) => ({
        newapiUserId: `remote_${input.username}`,
        accessToken: 'test-access-token',
      }),
      ensureUserGroup: async () => {},
      adjustQuota: async () => {
        adjustCalls += 1;
        return { changeId, balanceUsd: 25 };
      },
    } as any,
    getAdjustCalls: () => adjustCalls,
  };
}

test('adjustPortalQuota refuses a new adjustment while an earlier one needs reconciliation', async () => {
  const portalUser = await insertUser('portal_user_block_recon', 'blkr@t.co');
  const operator = await insertUser('operator_block_recon', 'opbr@t.co');
  await modules.portal.ensurePortalUserBinding(
    portalUser,
    createSuccessfulRemoteClient()
  );
  await seedAdjustmentLedgerRow({
    id: 'ledger_unresolved_recon',
    portalUserId: portalUser.id,
    operatorUserId: operator.id,
    status: 'reconciliation_required',
    remoteAttemptAt: new Date(),
  });

  const { client, getAdjustCalls } = createCountingRemoteClient();
  await assert.rejects(
    modules.portal.adjustPortalQuota({
      portalUser,
      operatorUserId: operator.id,
      amountUsd: 25,
      reason: 'second adjustment',
      idempotencyKey: 'portal-adjustment:fresh-key-after-recon',
      client,
    }),
    /unresolved/i
  );
  // 关键：远端一次都不能被碰到，否则就是第二张兑换码 / 第二次扣减
  assert.equal(getAdjustCalls(), 0);
});

test('the unresolved-adjustment error reaches the admin instead of being masked', async () => {
  const { isInternalPortalError, getPublicPortalErrorMessage } = await import(
    '@/features/api-console/lib/public-errors'
  );
  const error = new modules.portal.UnresolvedQuotaAdjustmentError('ledger_abc');

  // 带 code 字段或提到 New API 都会被整条替换成通用文案，管理员就看不到阻塞原因
  assert.equal(isInternalPortalError(error), false);
  assert.match(
    getPublicPortalErrorMessage(error, 'fallback'),
    /unresolved quota adjustment \(ledger_abc\)/i
  );
});

test('adjustPortalQuota refuses a new adjustment while an earlier remote attempt is unaccounted for', async () => {
  const portalUser = await insertUser('portal_user_block_attempt', 'blka@t.co');
  const operator = await insertUser('operator_block_attempt', 'opba@t.co');
  await modules.portal.ensurePortalUserBinding(
    portalUser,
    createSuccessfulRemoteClient()
  );
  // 进程死在「远端已尝试、本地未落 applied」之间留下的行，且已过 TTL
  await seedAdjustmentLedgerRow({
    id: 'ledger_pending_with_attempt',
    portalUserId: portalUser.id,
    operatorUserId: operator.id,
    status: 'pending',
    remoteAttemptAt: new Date(Date.now() - 60 * 60 * 1000),
    updatedAt: new Date(Date.now() - 60 * 60 * 1000),
  });

  const { client, getAdjustCalls } = createCountingRemoteClient();
  await assert.rejects(
    modules.portal.adjustPortalQuota({
      portalUser,
      operatorUserId: operator.id,
      amountUsd: 25,
      reason: 'retry after crash',
      idempotencyKey: 'portal-adjustment:fresh-key-after-crash',
      client,
    }),
    /unresolved/i
  );
  assert.equal(getAdjustCalls(), 0);
});

test('adjustPortalQuota refuses a new adjustment while another one is still in flight', async () => {
  const portalUser = await insertUser(
    'portal_user_block_inflight',
    'blki@t.co'
  );
  const operator = await insertUser('operator_block_inflight', 'opbi@t.co');
  await modules.portal.ensurePortalUserBinding(
    portalUser,
    createSuccessfulRemoteClient()
  );
  // 新鲜的 pending 行（另一个请求正在飞），即便还没落 remoteAttemptAt 也必须挡住
  await seedAdjustmentLedgerRow({
    id: 'ledger_pending_fresh',
    portalUserId: portalUser.id,
    operatorUserId: operator.id,
    status: 'pending',
    remoteAttemptAt: null,
  });

  const { client, getAdjustCalls } = createCountingRemoteClient();
  await assert.rejects(
    modules.portal.adjustPortalQuota({
      portalUser,
      operatorUserId: operator.id,
      amountUsd: 25,
      reason: 'concurrent submit',
      idempotencyKey: 'portal-adjustment:fresh-key-concurrent',
      client,
    }),
    /unresolved/i
  );
  assert.equal(getAdjustCalls(), 0);
});

test('adjustPortalQuota reclaims a stale pending row whose remote attempt never happened', async () => {
  const portalUser = await insertUser('portal_user_reclaim', 'rclm@t.co');
  const operator = await insertUser('operator_reclaim', 'oprc@t.co');
  await modules.portal.ensurePortalUserBinding(
    portalUser,
    createSuccessfulRemoteClient()
  );
  // remoteAttemptAt 为 null 才是「远端什么都没发生」的证据：可安全放行
  await seedAdjustmentLedgerRow({
    id: 'ledger_pending_stale_clean',
    portalUserId: portalUser.id,
    operatorUserId: operator.id,
    status: 'pending',
    remoteAttemptAt: null,
    updatedAt: new Date(Date.now() - 60 * 60 * 1000),
  });

  const { client, getAdjustCalls } = createCountingRemoteClient();
  const ledger = await modules.portal.adjustPortalQuota({
    portalUser,
    operatorUserId: operator.id,
    amountUsd: 25,
    reason: 'retry after clean abort',
    idempotencyKey: 'portal-adjustment:fresh-key-clean',
    client,
  });

  assert.equal(ledger.status, 'applied');
  assert.equal(getAdjustCalls(), 1);
  const { apipoolLedgerEntry } = await import('@/config/db/schema');
  const [stale] = await modules
    .db()
    .select()
    .from(apipoolLedgerEntry)
    .where(eq(apipoolLedgerEntry.id, 'ledger_pending_stale_clean'));
  assert.equal(stale.status, 'failed');
});

test('adjustPortalQuota escalates a dispatched negative quota write whose response is lost', async () => {
  const portalUser = await insertUser('portal_user_negative_lost', 'nlst@t.co');
  const operator = await insertUser('operator_negative_lost', 'opnl@t.co');
  await modules.portal.ensurePortalUserBinding(
    portalUser,
    createSuccessfulRemoteClient()
  );

  const fakeRemote = {
    provisionUser: async (input: { username: string }) => ({
      newapiUserId: `remote_${input.username}`,
      accessToken: 'test-access-token',
    }),
    adjustQuota: async (input: any) => {
      // PUT /api/user/ 已发出（远端可能已扣减），响应在途中丢失
      await input.onQuotaWriteDispatched?.();
      throw new Error('socket hang up');
    },
  } as any;

  const ledger = await modules.portal.adjustPortalQuota({
    portalUser,
    operatorUserId: operator.id,
    amountUsd: -25,
    reason: 'clawback',
    idempotencyKey: 'portal-adjustment:negative-lost',
    client: fakeRemote,
  });

  // 写已发出 ⇒ 结局未知，绝不能落终态 failed（重试会二次扣减）
  assert.equal(ledger.status, 'reconciliation_required');
});

test('the admin ledger view surfaces recharge entries next to manual adjustments', async () => {
  const portalUser = await insertUser('portal_user_ledger_mix', 'lmix@t.co');
  const operator = await insertUser('operator_ledger_mix', 'oplm@t.co');
  const { apipoolLedgerEntry } = await import('@/config/db/schema');

  await seedAdjustmentLedgerRow({
    id: 'ledger_mix_manual',
    portalUserId: portalUser.id,
    operatorUserId: operator.id,
    status: 'applied',
    remoteAttemptAt: new Date(),
  });
  // 用户投诉「付了钱没到账」时，管理员必须能在详情页看到这一行
  await modules.db().insert(apipoolLedgerEntry).values({
    id: 'ledger_mix_recharge',
    portalUserId: portalUser.id,
    operatorUserId: portalUser.id,
    newapiUserId: 'remote_seeded',
    orderNo: 'order_mix_1',
    idempotencyKey: null,
    amountUsd: 50,
    source: 'recharge',
    status: 'reconciliation_required',
    executor: 'internal_quota_executor',
    reason: 'recharge order order_mix_1',
  });

  const rows = await modules.portal.listAdjustmentLedgerByPortalUser(
    portalUser.id
  );
  const ids = rows.map((row: any) => row.id);
  assert.ok(ids.includes('ledger_mix_manual'));
  assert.ok(
    ids.includes('ledger_mix_recharge'),
    'recharge ledger rows must be visible to admins'
  );

  const recharge = rows.find((row: any) => row.id === 'ledger_mix_recharge');
  assert.equal(recharge.source, 'recharge');
  assert.equal(recharge.orderNo, 'order_mix_1');
});

test('resolveQuotaAdjustment confirms a stuck row and unblocks further adjustments', async () => {
  const portalUser = await insertUser('portal_user_resolve_ok', 'rslv@t.co');
  const operator = await insertUser('operator_resolve_ok', 'oprv@t.co');
  await modules.portal.ensurePortalUserBinding(
    portalUser,
    createSuccessfulRemoteClient()
  );
  await seedAdjustmentLedgerRow({
    id: 'ledger_resolve_confirm',
    portalUserId: portalUser.id,
    operatorUserId: operator.id,
    status: 'reconciliation_required',
    remoteAttemptAt: new Date(),
  });

  // 解封前：任何新调额都被守卫挡住
  const blocked = createCountingRemoteClient();
  await assert.rejects(
    modules.portal.adjustPortalQuota({
      portalUser,
      operatorUserId: operator.id,
      amountUsd: 5,
      reason: 'before resolve',
      idempotencyKey: 'portal-adjustment:before-resolve',
      client: blocked.client,
    }),
    /unresolved/i
  );
  assert.equal(blocked.getAdjustCalls(), 0);

  const resolved = await modules.portal.resolveQuotaAdjustment({
    ledgerId: 'ledger_resolve_confirm',
    operatorUserId: operator.id,
    resolution: 'confirm_applied',
    note: 'verified in New API: redemption redeemed, quota landed',
  });
  assert.equal(resolved.status, 'applied');

  // 解封后：新调额恢复可用
  const after = createCountingRemoteClient();
  const ledger = await modules.portal.adjustPortalQuota({
    portalUser,
    operatorUserId: operator.id,
    amountUsd: 5,
    reason: 'after resolve',
    idempotencyKey: 'portal-adjustment:after-resolve',
    client: after.client,
  });
  assert.equal(ledger.status, 'applied');
  assert.equal(after.getAdjustCalls(), 1);
});

test('resolveQuotaAdjustment can void a stuck row and records who decided it', async () => {
  const portalUser = await insertUser('portal_user_resolve_void', 'rsvd@t.co');
  const operator = await insertUser('operator_resolve_void', 'oprvd@t.co');
  await seedAdjustmentLedgerRow({
    id: 'ledger_resolve_void',
    portalUserId: portalUser.id,
    operatorUserId: operator.id,
    status: 'reconciliation_required',
    remoteAttemptAt: new Date(),
  });

  const resolved = await modules.portal.resolveQuotaAdjustment({
    ledgerId: 'ledger_resolve_void',
    operatorUserId: operator.id,
    resolution: 'mark_void',
    note: 'verified in New API: nothing landed',
  });
  assert.equal(resolved.status, 'failed');

  // 人工裁决必须留痕：谁、何时、依据什么、原状态是什么
  const audits = await modules
    .db()
    .select()
    .from(modules.newApiBridgeAuditLog)
    .where(
      eq(modules.newApiBridgeAuditLog.action, 'newapi.quota.adjust_resolve')
    );
  const audit = audits.find((row: any) =>
    String(row.requestBody).includes('ledger_resolve_void')
  );
  assert.ok(audit, 'resolution must be audited');
  assert.equal(audit.operatorUserId, operator.id);
  assert.match(String(audit.requestBody), /reconciliation_required/);
  assert.match(String(audit.requestBody), /nothing landed/);
});

test('resolveQuotaAdjustment refuses rows that are already settled', async () => {
  const portalUser = await insertUser('portal_user_resolve_done', 'rsdn@t.co');
  const operator = await insertUser('operator_resolve_done', 'oprdn@t.co');
  await seedAdjustmentLedgerRow({
    id: 'ledger_already_applied',
    portalUserId: portalUser.id,
    operatorUserId: operator.id,
    status: 'applied',
    remoteAttemptAt: new Date(),
  });

  await assert.rejects(
    modules.portal.resolveQuotaAdjustment({
      ledgerId: 'ledger_already_applied',
      operatorUserId: operator.id,
      resolution: 'mark_void',
      note: 'should not be possible',
    }),
    /not awaiting reconciliation/i
  );
});

test('resolveQuotaAdjustment requires an operator note as the reconciliation evidence', async () => {
  const portalUser = await insertUser('portal_user_resolve_note', 'rsnt@t.co');
  const operator = await insertUser('operator_resolve_note', 'oprnt@t.co');
  await seedAdjustmentLedgerRow({
    id: 'ledger_resolve_no_note',
    portalUserId: portalUser.id,
    operatorUserId: operator.id,
    status: 'reconciliation_required',
    remoteAttemptAt: new Date(),
  });

  await assert.rejects(
    modules.portal.resolveQuotaAdjustment({
      ledgerId: 'ledger_resolve_no_note',
      operatorUserId: operator.id,
      resolution: 'confirm_applied',
      note: '   ',
    }),
    /note is required/i
  );
});

test('adjustPortalQuota marks remote-applied confirmation failures for reconciliation', async () => {
  const portalUser = await insertUser(
    'portal_user_adjust_reconciliation',
    'adjr@t.co'
  );
  const operator = await insertUser(
    'operator_adjust_reconciliation',
    'ops5@t.co'
  );
  const fakeRemote = {
    provisionUser: async (input: { username: string }) => ({
      newapiUserId: `remote_${input.username}`,
      accessToken: 'test-access-token',
    }),
    adjustQuota: async () => {
      const error = new modules.NewApiBridgeError({
        code: 'timeout',
        message: 'quota confirmation timed out',
      }) as any;
      error.reconciliationRequired = true;
      error.changeId = 'portal-adjustment:reconciliation-change';
      throw error;
    },
  } as any;

  const ledger = await modules.portal.adjustPortalQuota({
    portalUser,
    operatorUserId: operator.id,
    amountUsd: -5,
    reason: 'Manual MVP decrease',
    client: fakeRemote,
  });

  assert.equal(ledger.status, 'reconciliation_required');
  assert.equal(
    ledger.newapiChangeId,
    'portal-adjustment:reconciliation-change'
  );
  assert.equal(ledger.rollbackStatus, 'not_required');
});

test('getPortalUsage snapshots repeated remote logs only once', async () => {
  const portalUser = await insertUser('portal_user_usage_sync', 'us1@t.co');
  const syncedLog = {
    id: 'remote_request_1',
    keyMasked: 'sk-...usage',
    modelId: 'gpt-4o-mini',
    status: 'success',
    inputTokens: 12,
    outputTokens: 8,
    cacheTokens: 4,
    cacheRatio: 0.25,
    cacheCreationTokens: 2,
    cacheCreationRatio: 1.25,
    cacheCreationTokens5m: 1,
    cacheCreationRatio5m: 1.1,
    cacheCreationTokens1h: 1,
    cacheCreationRatio1h: 1.5,
    usageSemantic: 'anthropic',
    spendUsd: 1,
    createdAt: '2026-05-24T10:00:00.000Z',
  };
  const fakeRemote = {
    provisionUser: async (input: { username: string }) => ({
      newapiUserId: `remote_${input.username}`,
      accessToken: 'test-access-token',
    }),
    getQuota: async () => ({ balanceUsd: 25, quotaRemaining: 25 }),
    getUsageSummary: async () => ({
      requestCount: 1,
      inputTokens: 12,
      outputTokens: 8,
      spendUsd: 1,
      byModel: [
        { modelId: 'gpt-4o-mini', requests: 1, tokens: 20, spendUsd: 1 },
      ],
    }),
    listUsageLogs: async () => [syncedLog],
  } as any;

  await modules.portal.ensurePortalUserBinding(portalUser, fakeRemote);
  const usage = await modules.portal.getPortalUsage(
    portalUser,
    '7d',
    fakeRemote
  );
  await modules.portal.getPortalUsage(portalUser, '7d', fakeRemote);

  assert.deepEqual(usage.summary.byModel, [
    { modelId: 'gpt-4o-mini', requests: 1, tokens: 20, spendUsd: 1 },
  ]);

  const rows = await modules
    .db()
    .select()
    .from(modules.usageLogSnapshot)
    .where(eq(modules.usageLogSnapshot.portalUserId, portalUser.id));

  assert.equal(rows.length, 1);
  assert.equal(rows[0].newapiRequestId, syncedLog.id);
  assert.equal(rows[0].cacheTokens, 4);
  assert.equal(rows[0].cacheRatio, 0.25);
  assert.equal(rows[0].cacheCreationTokens, 2);
  assert.equal(rows[0].cacheCreationRatio, 1.25);
  assert.equal(rows[0].cacheCreationTokens5m, 1);
  assert.equal(rows[0].cacheCreationRatio5m, 1.1);
  assert.equal(rows[0].cacheCreationTokens1h, 1);
  assert.equal(rows[0].cacheCreationRatio1h, 1.5);
  assert.equal(rows[0].usageSemantic, 'anthropic');
  assert.equal(usage.logs[0].cacheCreationTokens, 2);
  assert.equal(usage.logs[0].usageSemantic, 'anthropic');
});

test('getPortalUsage preserves duplicate request ids from a single sync response', async () => {
  const portalUser = await insertUser(
    'portal_user_usage_duplicate_ids',
    'us2@t.co'
  );
  const duplicateLogs = [
    {
      id: 'remote_request_duplicate_id',
      keyMasked: 'sk-...duplicate',
      modelId: 'gpt-4o-mini',
      status: 'success',
      inputTokens: 12,
      outputTokens: 8,
      spendUsd: 1,
      createdAt: '2026-05-24T10:00:00.000Z',
    },
    {
      id: 'remote_request_duplicate_id',
      keyMasked: 'sk-...duplicate',
      modelId: 'gpt-4o-mini',
      status: 'success',
      inputTokens: 4,
      outputTokens: 6,
      spendUsd: 0.5,
      createdAt: '2026-05-24T10:01:00.000Z',
    },
  ];
  const healthyRemote = {
    provisionUser: async (input: { username: string }) => ({
      newapiUserId: `remote_${input.username}`,
      accessToken: 'test-access-token',
    }),
    getQuota: async () => ({ balanceUsd: 25, quotaRemaining: 25 }),
    getUsageSummary: async () => ({
      requestCount: 2,
      inputTokens: 16,
      outputTokens: 14,
      spendUsd: 1.5,
      byModel: [
        { modelId: 'gpt-4o-mini', requests: 2, tokens: 30, spendUsd: 1.5 },
      ],
    }),
    listUsageLogs: async () => duplicateLogs,
  } as any;
  const failingRemote = {
    getQuota: async () => {
      throw new modules.NewApiBridgeError({
        code: 'timeout',
        message: 'usage sync timed out',
      });
    },
    getUsageSummary: async () => healthyRemote.getUsageSummary(),
    listUsageLogs: async () => duplicateLogs,
  } as any;

  await modules.portal.ensurePortalUserBinding(portalUser, healthyRemote);
  const freshUsage = await modules.portal.getPortalUsage(
    portalUser,
    '7d',
    healthyRemote
  );
  assert.equal(freshUsage.logs.length, 2);

  const rows = await modules
    .db()
    .select()
    .from(modules.usageLogSnapshot)
    .where(eq(modules.usageLogSnapshot.portalUserId, portalUser.id));
  assert.equal(rows.length, 2);
  assert.equal(new Set(rows.map((row: any) => row.newapiRequestId)).size, 2);

  const staleUsage = await modules.portal.getPortalUsage(
    portalUser,
    '7d',
    failingRemote
  );
  assert.equal(staleUsage.summary.status, 'stale');
  assert.equal(staleUsage.logs.length, 2);
  assert.deepEqual(
    staleUsage.logs.map((log: { id: string }) => log.id),
    duplicateLogs.map((log) => log.id)
  );
  assert.ok(
    staleUsage.logs.every(
      (log: { id: string }) => !log.id.includes('#apipool-duplicate-')
    )
  );
});

test('cached usage logs do not expose internal snapshot or New API request fields', async () => {
  const portalUser = await insertUser(
    'portal_user_cached_usage_dto',
    'us3@t.co'
  );
  const syncedLog = {
    id: 'remote_request_cached_1',
    keyMasked: 'sk-...cached',
    modelId: 'gpt-4o-mini',
    status: 'success',
    inputTokens: 21,
    outputTokens: 13,
    spendUsd: 2,
    createdAt: '2026-05-24T11:00:00.000Z',
  };
  const healthyRemote = {
    provisionUser: async (input: { username: string }) => ({
      newapiUserId: `remote_${input.username}`,
      accessToken: 'test-access-token',
    }),
    getQuota: async () => ({ balanceUsd: 30, quotaRemaining: 30 }),
    getUsageSummary: async () => ({
      requestCount: 1,
      inputTokens: 21,
      outputTokens: 13,
      spendUsd: 2,
      byModel: [
        { modelId: 'gpt-4o-mini', requests: 1, tokens: 34, spendUsd: 2 },
      ],
    }),
    listUsageLogs: async () => [syncedLog],
  } as any;
  const failingRemote = {
    getQuota: async () => {
      throw new modules.NewApiBridgeError({
        code: 'timeout',
        message: 'usage sync timed out',
      });
    },
    getUsageSummary: async () => healthyRemote.getUsageSummary(),
    listUsageLogs: async () => [syncedLog],
  } as any;

  await modules.portal.ensurePortalUserBinding(portalUser, healthyRemote);
  await modules.portal.getPortalUsage(portalUser, '7d', healthyRemote);
  const usage = await modules.portal.getPortalUsage(
    portalUser,
    '7d',
    failingRemote
  );

  assert.deepEqual(usage.summary.byModel, [
    { modelId: 'gpt-4o-mini', requests: 1, tokens: 34, spendUsd: 2 },
  ]);
  assert.equal(usage.logs.length, 1);
  assert.equal(usage.logs[0].id, syncedLog.id);
  assertNoFields(usage.logs[0], [
    'portalUserId',
    'newapiRequestId',
    'syncedAt',
  ]);
});

test('getPortalUsage returns stale when an old usable cache exists and sync fails', async () => {
  const portalUser = await insertUser(
    'portal_user_usage_old_cache',
    'us4@t.co'
  );
  const syncedLog = {
    id: 'remote_request_old_cache_1',
    keyMasked: 'sk-...old-cache',
    modelId: 'gpt-4o-mini',
    status: 'success',
    inputTokens: 8,
    outputTokens: 5,
    spendUsd: 0.75,
    createdAt: '2026-05-24T12:00:00.000Z',
  };
  const healthyRemote = {
    provisionUser: async (input: { username: string }) => ({
      newapiUserId: `remote_${input.username}`,
      accessToken: 'test-access-token',
    }),
    getQuota: async () => ({ balanceUsd: 10, quotaRemaining: 10 }),
    getUsageSummary: async () => ({
      requestCount: 1,
      inputTokens: 8,
      outputTokens: 5,
      spendUsd: 0.75,
      byModel: [
        {
          modelId: 'gpt-4o-mini',
          requests: 1,
          tokens: 13,
          spendUsd: 0.75,
        },
      ],
    }),
    listUsageLogs: async () => [syncedLog],
  } as any;
  const failingRemote = {
    getQuota: async () => {
      throw new modules.NewApiBridgeError({
        code: 'timeout',
        message: 'old cache usage sync timed out',
      });
    },
    getUsageSummary: async () => healthyRemote.getUsageSummary(),
    listUsageLogs: async () => [syncedLog],
  } as any;

  await modules.portal.ensurePortalUserBinding(portalUser, healthyRemote);
  await modules.portal.getPortalUsage(portalUser, '7d', healthyRemote);
  await modules
    .db()
    .update(modules.usageSnapshot)
    .set({ syncedAt: new Date('2026-05-24T12:00:00.000Z') })
    .where(eq(modules.usageSnapshot.portalUserId, portalUser.id));

  const usage = await modules.portal.getPortalUsage(
    portalUser,
    '7d',
    failingRemote
  );

  assert.equal(usage.summary.status, 'stale');
  assert.equal(usage.summary.requestCount, 1);
  assert.equal(usage.logs.length, 1);
  assert.equal(usage.summary.errorMessage, undefined);
});

test('getPortalUsage returns syncing snapshot without duplicate remote reads', async () => {
  const portalUser = await insertUser('portal_user_usage_syncing', 'us5@t.co');
  const healthyRemote = {
    provisionUser: async (input: { username: string }) => ({
      newapiUserId: `remote_${input.username}`,
      accessToken: 'test-access-token',
    }),
  } as any;

  await modules.portal.ensurePortalUserBinding(portalUser, healthyRemote);
  await modules
    .db()
    .insert(modules.usageSnapshot)
    .values({
      id: 'usage_snapshot_syncing',
      portalUserId: portalUser.id,
      newapiUserId: `remote_${portalUser.id}`,
      range: '7d',
      balanceUsd: 18,
      quotaRemaining: 18,
      requestCount: 2,
      inputTokens: 40,
      outputTokens: 20,
      spendUsd: 3,
      byModel: JSON.stringify([
        { modelId: 'gpt-4o-mini', requests: 2, tokens: 60, spendUsd: 3 },
      ]),
      status: 'syncing',
      syncedAt: new Date('2026-05-24T10:00:00.000Z'),
    });

  let remoteCalls = 0;
  const duplicateRemote = {
    getQuota: async () => {
      remoteCalls += 1;
      throw new Error('duplicate remote read');
    },
    getUsageSummary: async () => {
      remoteCalls += 1;
      throw new Error('duplicate remote read');
    },
    listUsageLogs: async () => {
      remoteCalls += 1;
      throw new Error('duplicate remote read');
    },
  } as any;

  const usage = await modules.portal.getPortalUsage(
    portalUser,
    '7d',
    duplicateRemote
  );

  assert.equal(remoteCalls, 0);
  assert.equal(usage.summary.status, 'syncing');
  assert.equal(usage.summary.requestCount, 2);
  assert.deepEqual(usage.summary.byModel, [
    { modelId: 'gpt-4o-mini', requests: 2, tokens: 60, spendUsd: 3 },
  ]);
});

test('getPortalUsage returns failed when initial usage sync has no cached data', async () => {
  const portalUser = await insertUser(
    'portal_user_usage_initial_failure',
    'us6@t.co'
  );
  const healthyRemote = {
    provisionUser: async (input: { username: string }) => ({
      newapiUserId: `remote_${input.username}`,
      accessToken: 'test-access-token',
    }),
  } as any;
  const failingRemote = {
    getQuota: async () => {
      throw new modules.NewApiBridgeError({
        code: 'timeout',
        message: 'initial usage sync timed out',
      });
    },
    getUsageSummary: async () => ({
      requestCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      byModel: [],
    }),
    listUsageLogs: async () => [],
  } as any;

  await modules.portal.ensurePortalUserBinding(portalUser, healthyRemote);
  const usage = await modules.portal.getPortalUsage(
    portalUser,
    '7d',
    failingRemote
  );

  assert.equal(usage.summary.status, 'failed');
  assert.equal(usage.summary.requestCount, 0);
  assert.equal(usage.summary.errorMessage, undefined);
  assert.deepEqual(usage.logs, []);
});
