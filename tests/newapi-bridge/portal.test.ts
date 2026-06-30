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
  delete process.env.APIPOOL_LOCAL_KEY_FALLBACK_ENABLED;
  delete process.env.NEWAPI_BASE_URL;

  const client = createClient({ url: `file:${dbPath}` });
  const migrationsDir = join(process.cwd(), 'src/config/db/migrations_sqlite');
  for (const file of (await readdir(migrationsDir))
    .filter((name) => name.endsWith('.sql'))
    .sort()) {
    await client.executeMultiple(
      await readFile(join(migrationsDir, file), 'utf8')
    );
  }
  client.close();

  const { user } = await import('@/config/db/schema');
  const {
    catalogGroup,
    newApiBridgeAuditLog,
    newApiKeyBinding,
    usageLogSnapshot,
    usageSnapshot,
  } = await import('@/config/db/schema');
  const { db } = await import('@/core/db');
  const { NewApiBridgeError } = await import(
    '@/features/newapi-bridge/server/client'
  );
  const portal = await import('@/features/newapi-bridge/server/portal');

  modules = {
    db,
    newApiBridgeAuditLog,
    newApiKeyBinding,
    NewApiBridgeError,
    portal,
    catalogGroup,
    usageLogSnapshot,
    usageSnapshot,
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

test('createPortalApiKey keeps a retriable local key row when remote creation fails', async () => {
  const portalUser = await insertUser(
    'portal_user_create_failure',
    'create-failure@example.com'
  );

  const fakeRemote = {
    provisionUser: async () => ({
      newapiUserId: 'remote_user_1',
      accessToken: 'test-access-token',
    }),
    createKey: async () => {
      throw new modules.NewApiBridgeError({
        code: 'timeout',
        message: 'remote create timed out',
      });
    },
  } as any;

  await assert.rejects(
    () =>
      modules.portal.createPortalApiKey(
        portalUser,
        portalKeyInput('Default key'),
        fakeRemote
      ),
    /remote create timed out/
  );

  const keys = await modules
    .db()
    .select()
    .from(modules.newApiKeyBinding)
    .where(eq(modules.newApiKeyBinding.portalUserId, portalUser.id));
  assert.equal(keys.length, 1);
  assert.equal(keys[0].status, 'failed_retriable');
  assert.match(
    keys[0].idempotencyKey,
    /^portal-key:portal_user_create_failure:/
  );
  assert.equal(keys[0].newapiKeyId.startsWith('pending:'), true);
});

test('createPortalApiKey rejects remote-created keys that are not active', async () => {
  const portalUser = await insertUser(
    'portal_user_create_disabled',
    'create-disabled@example.com'
  );

  const fakeRemote = {
    provisionUser: async () => ({
      newapiUserId: 'remote_user_disabled_key',
      accessToken: 'test-access-token',
    }),
    createKey: async () => ({
      id: 'remote_key_disabled_on_create',
      key: 'sk-disabled-on-create',
      maskedKey: 'sk-...disabled',
      status: 'disabled',
    }),
  } as any;

  await assert.rejects(
    () =>
      modules.portal.createPortalApiKey(
        portalUser,
        portalKeyInput('Disabled remote key'),
        fakeRemote
      ),
    /did not return active/
  );

  const keys = await modules
    .db()
    .select()
    .from(modules.newApiKeyBinding)
    .where(eq(modules.newApiKeyBinding.portalUserId, portalUser.id));

  assert.equal(keys.length, 1);
  assert.equal(keys[0].newapiKeyId, 'remote_key_disabled_on_create');
  assert.equal(keys[0].status, 'failed_retriable');
  assert.equal(keys[0].keyMasked, 'sk-...disabled');
});

test('createPortalApiKey preserves remote-created evidence when local binding fails', async () => {
  const portalUser = await insertUser(
    'portal_user_create_binding_failure',
    'create-binding-failure@example.com'
  );
  const remote = createSuccessfulRemoteClient() as any;
  const existing = await modules.portal.createPortalApiKey(
    portalUser,
    portalKeyInput('Existing remote key'),
    remote
  );
  const [existingRow] = await modules
    .db()
    .select()
    .from(modules.newApiKeyBinding)
    .where(eq(modules.newApiKeyBinding.id, existing.binding.id));
  const conflictingRemoteId = existingRow.newapiKeyId;
  await modules
    .db()
    .update(modules.newApiKeyBinding)
    .set({ status: 'deleted', deletedAt: new Date() })
    .where(eq(modules.newApiKeyBinding.id, existing.binding.id));

  const failingRemote = {
    provisionUser: async (input: { username: string }) => ({
      newapiUserId: `remote_${input.username}`,
      accessToken: 'test-access-token',
    }),
    ensureUserGroup: async () => {},
    createKey: async () => ({
      id: conflictingRemoteId,
      key: 'sk-local-binding-failure',
      maskedKey: 'sk-...local-binding-failure',
      status: 'active',
    }),
  } as any;

  await assert.rejects(
    () =>
      modules.portal.createPortalApiKey(
        portalUser,
        portalKeyInput('Binding failure key'),
        failingRemote
      ),
    (error: any) => {
      assert.ok(error instanceof modules.NewApiBridgeError);
      assert.doesNotMatch(error.message, /Failed query|UNIQUE|constraint/i);
      assert.match(error.message, /local key binding failed/i);
      return true;
    }
  );

  const rows = await modules
    .db()
    .select()
    .from(modules.newApiKeyBinding)
    .where(eq(modules.newApiKeyBinding.portalUserId, portalUser.id));
  const failedRow = rows.find(
    (row: any) => row.displayName === 'Binding failure key'
  );

  assert.equal(failedRow.status, 'remote_created_binding_failed');
  assert.equal(failedRow.keyMasked, 'sk-...local-binding-failure');
  assert.match(failedRow.lastRemoteError, /constraint|local binding/i);

  const audits = await modules
    .db()
    .select()
    .from(modules.newApiBridgeAuditLog)
    .where(eq(modules.newApiBridgeAuditLog.portalUserId, portalUser.id));
  const failedAudit = audits.find(
    (row: any) =>
      row.action === 'newapi.key.create' &&
      row.status === 'failed' &&
      row.targetId === conflictingRemoteId
  );

  assert.ok(failedAudit, 'failed local binding should be audited');
  assert.match(failedAudit.responseBody, /\[redacted\]/);
});

test('portal users cannot disable or delete another user key', async () => {
  const owner = await insertUser('portal_user_owner', 'owner@example.com');
  const outsider = await insertUser(
    'portal_user_outsider',
    'outsider@example.com'
  );
  const result = await modules.portal.createPortalApiKey(
    owner,
    portalKeyInput('Owner key'),
    createSuccessfulRemoteClient() as any
  );
  let remoteCalls = 0;
  const forbiddenRemote = {
    disableKey: async () => {
      remoteCalls += 1;
      throw new Error('remote should not be called');
    },
    deleteKey: async () => {
      remoteCalls += 1;
      throw new Error('remote should not be called');
    },
  };

  await assert.rejects(
    () =>
      modules.portal.disablePortalApiKey(
        outsider.id,
        result.binding.id,
        forbiddenRemote as any
      ),
    /API key not found/
  );
  await assert.rejects(
    () =>
      modules.portal.deletePortalApiKey(
        outsider.id,
        result.binding.id,
        forbiddenRemote as any
      ),
    /API key not found/
  );

  const keys = await modules.portal.listPortalApiKeys(owner.id);
  assert.equal(keys[0].status, 'active');
  assert.equal(remoteCalls, 0);
});

test('database rejects duplicate undeleted key display names per portal user', async () => {
  const portalUser = await insertUser(
    'portal_user_duplicate_name_index',
    'duplicate-name-index@example.com'
  );

  await modules.db().insert(modules.newApiKeyBinding).values({
    id: 'duplicate_name_key_1',
    portalUserId: portalUser.id,
    newapiUserId: 'remote_duplicate_name',
    newapiKeyId: 'remote_duplicate_name_1',
    keyMasked: 'sk-...duplicate-1',
    displayName: 'Duplicate display name',
    status: 'active',
    allowedModels: '[]',
    groupId: 'catalog_group_portal_test',
    newapiGroup: 'ng-portal-test',
    ipAllowlist: '[]',
    idempotencyKey: 'portal-key:duplicate-name-index:1',
  });

  await assert.rejects(() =>
    modules.db().insert(modules.newApiKeyBinding).values({
      id: 'duplicate_name_key_2',
      portalUserId: portalUser.id,
      newapiUserId: 'remote_duplicate_name',
      newapiKeyId: 'remote_duplicate_name_2',
      keyMasked: 'sk-...duplicate-2',
      displayName: 'Duplicate display name',
      status: 'creating_remote',
      allowedModels: '[]',
      groupId: 'catalog_group_portal_test',
      newapiGroup: 'ng-portal-test',
      ipAllowlist: '[]',
      idempotencyKey: 'portal-key:duplicate-name-index:2',
    })
  );

  await modules
    .db()
    .update(modules.newApiKeyBinding)
    .set({ status: 'deleted', deletedAt: new Date() })
    .where(eq(modules.newApiKeyBinding.id, 'duplicate_name_key_1'));

  await modules.db().insert(modules.newApiKeyBinding).values({
    id: 'duplicate_name_key_3',
    portalUserId: portalUser.id,
    newapiUserId: 'remote_duplicate_name',
    newapiKeyId: 'remote_duplicate_name_3',
    keyMasked: 'sk-...duplicate-3',
    displayName: 'Duplicate display name',
    status: 'active',
    allowedModels: '[]',
    groupId: 'catalog_group_portal_test',
    newapiGroup: 'ng-portal-test',
    ipAllowlist: '[]',
    idempotencyKey: 'portal-key:duplicate-name-index:3',
  });
});

test('portal key DTOs expose only MVP customer key fields', async () => {
  const portalUser = await insertUser(
    'portal_user_safe_key_dto',
    'safe-key-dto@example.com'
  );
  const remote = createSuccessfulRemoteClient();
  const created = await modules.portal.createPortalApiKey(
    portalUser,
    portalKeyInput('Safe key DTO'),
    remote as any
  );

  const forbiddenFields = [
    'newapiUserId',
    'newapiKeyId',
    'idempotencyKey',
    'groupId',
    'newapiGroup',
    'quotaLimit',
    'ipAllowlist',
  ];
  assertNoFields(created.binding, forbiddenFields);

  const listed = await modules.portal.listPortalApiKeys(portalUser.id);
  assertNoFields(listed[0], forbiddenFields);

  const disabled = await modules.portal.disablePortalApiKey(
    portalUser.id,
    created.binding.id,
    remote as any
  );
  assertNoFields(disabled, forbiddenFields);

  const deleted = await modules.portal.deletePortalApiKey(
    portalUser.id,
    created.binding.id,
    remote as any
  );
  assertNoFields(deleted, forbiddenFields);
});

test('listPortalApiKeys returns the portal group name and public slug without leaking internal group fields', async () => {
  const portalUser = await insertUser(
    'portal_user_key_group_name',
    'key-group-name@example.com'
  );
  const remote = createSuccessfulRemoteClient();
  const created = await modules.portal.createPortalApiKey(
    portalUser,
    portalKeyInput('Grouped list key'),
    remote as any
  );

  const listed = await modules.portal.listPortalApiKeys(portalUser.id);
  const listedKey = listed.find((key: any) => key.id === created.binding.id);

  assert.ok(listedKey);
  assert.equal(listedKey.groupName, 'Portal Test');
  assert.equal(listedKey.groupSlug, 'portal-test');
  assertNoFields(listedKey, ['groupId', 'newapiGroup']);

  const serialized = JSON.stringify(listedKey);
  assert.equal(serialized.includes('catalog_group_portal_test'), false);
  assert.equal(serialized.includes('ng-portal-test'), false);
  assert.equal(serialized.includes('newapiGroup'), false);
  assert.equal(serialized.includes('groupId'), false);
});

test('listPortalApiKeys syncs remote key status without exposing remote ids', async () => {
  const portalUser = await insertUser(
    'portal_user_key_list_sync',
    'key-list-sync@example.com'
  );
  const remote = createSuccessfulRemoteClient() as any;
  const created = await modules.portal.createPortalApiKey(
    portalUser,
    portalKeyInput('List sync key'),
    remote
  );
  remote.listKeys = async () => [
    {
      id: `remote_key_${remoteKeySeq}`,
      maskedKey: 'sk-...remote-disabled',
      status: 'disabled',
    },
  ];

  const listed = await modules.portal.listPortalApiKeys(portalUser.id, remote);

  assert.equal(listed[0].id, created.binding.id);
  assert.equal(listed[0].status, 'disabled');
  assert.equal(listed[0].keyMasked, 'sk-...remote-disabled');
  assertNoFields(listed[0], ['newapiUserId', 'newapiKeyId', 'idempotencyKey']);

  const rows = await modules
    .db()
    .select()
    .from(modules.newApiKeyBinding)
    .where(eq(modules.newApiKeyBinding.id, created.binding.id));
  assert.equal(rows[0].status, 'disabled');
  assert.equal(rows[0].keyMasked, 'sk-...remote-disabled');
});

test('listPortalApiKeys heals a retriable create state when the remote key is active', async () => {
  const portalUser = await insertUser(
    'portal_user_key_retriable_heal',
    'key-retriable-heal@example.com'
  );
  const remote = createSuccessfulRemoteClient() as any;
  const created = await modules.portal.createPortalApiKey(
    portalUser,
    portalKeyInput('Retriable heal key'),
    remote
  );

  await modules
    .db()
    .update(modules.newApiKeyBinding)
    .set({
      status: 'failed_retriable',
      lastRemoteError: 'temporary list failure',
    })
    .where(eq(modules.newApiKeyBinding.id, created.binding.id));

  remote.listKeys = async () => [
    {
      id: `remote_key_${remoteKeySeq}`,
      maskedKey: 'sk-...remote-active',
      status: 'active',
    },
  ];

  const listed = await modules.portal.listPortalApiKeys(portalUser.id, remote);

  assert.equal(listed[0].id, created.binding.id);
  assert.equal(listed[0].status, 'active');
  assert.equal(listed[0].keyMasked, 'sk-...remote-active');

  const [row] = await modules
    .db()
    .select()
    .from(modules.newApiKeyBinding)
    .where(eq(modules.newApiKeyBinding.id, created.binding.id));
  assert.equal(row.status, 'active');
  assert.equal(row.lastRemoteError, null);
});

test('listPortalApiKeys keeps delete pending until remote revocation is visible', async () => {
  const portalUser = await insertUser(
    'portal_user_key_delete_pending_sync',
    'key-delete-pending-sync@example.com'
  );
  const remote = createSuccessfulRemoteClient() as any;
  const created = await modules.portal.createPortalApiKey(
    portalUser,
    portalKeyInput('Delete pending key'),
    remote
  );

  await modules
    .db()
    .update(modules.newApiKeyBinding)
    .set({ status: 'delete_pending' })
    .where(eq(modules.newApiKeyBinding.id, created.binding.id));

  remote.listKeys = async () => [
    {
      id: `remote_key_${remoteKeySeq}`,
      maskedKey: 'sk-...remote-disabled',
      status: 'disabled',
    },
  ];

  const listedWhileDisabled = await modules.portal.listPortalApiKeys(
    portalUser.id,
    remote
  );
  assert.equal(listedWhileDisabled[0].status, 'delete_pending');

  remote.listKeys = async () => [
    {
      id: `remote_key_${remoteKeySeq}`,
      maskedKey: 'sk-...remote-revoked',
      status: 'revoked',
    },
  ];

  const listedAfterRevocation = await modules.portal.listPortalApiKeys(
    portalUser.id,
    remote
  );
  assert.equal(
    listedAfterRevocation.some((key: any) => key.id === created.binding.id),
    false,
    'revoked keys should be persisted as deleted but filtered from user lists'
  );

  const [row] = await modules
    .db()
    .select()
    .from(modules.newApiKeyBinding)
    .where(eq(modules.newApiKeyBinding.id, created.binding.id));
  assert.equal(row.status, 'deleted');
  assert.ok(row.deletedAt instanceof Date);
});

test('disablePortalApiKey and deletePortalApiKey complete only after remote confirmation', async () => {
  const portalUser = await insertUser(
    'portal_user_key_lifecycle',
    'key-lifecycle@example.com'
  );
  const remote = createSuccessfulRemoteClient();
  const result = await modules.portal.createPortalApiKey(
    portalUser,
    portalKeyInput('Lifecycle key'),
    remote as any
  );

  const disabled = await modules.portal.disablePortalApiKey(
    portalUser.id,
    result.binding.id,
    remote as any
  );
  assert.equal(disabled.status, 'disabled');

  const deleted = await modules.portal.deletePortalApiKey(
    portalUser.id,
    result.binding.id,
    remote as any
  );
  assert.equal(deleted.status, 'deleted');
  assert.ok(deleted.deletedAt instanceof Date);
});

test('disablePortalApiKey keeps retriable failure when remote does not confirm disabled', async () => {
  const portalUser = await insertUser(
    'portal_user_disable_unconfirmed',
    'disable-unconfirmed@example.com'
  );
  const remote = createSuccessfulRemoteClient();
  const result = await modules.portal.createPortalApiKey(
    portalUser,
    portalKeyInput('Unconfirmed disable key'),
    remote as any
  );

  const unconfirmedRemote = {
    ...remote,
    disableKey: async (_user: any, newapiKeyId: string) => ({
      id: newapiKeyId,
      maskedKey: 'sk-...still-active',
      status: 'active',
    }),
  };

  await assert.rejects(
    () =>
      modules.portal.disablePortalApiKey(
        portalUser.id,
        result.binding.id,
        unconfirmedRemote as any
      ),
    /did not confirm disabled/
  );

  const [row] = await modules
    .db()
    .select()
    .from(modules.newApiKeyBinding)
    .where(eq(modules.newApiKeyBinding.id, result.binding.id));

  assert.equal(row.status, 'failed_retriable');
});

test('deletePortalApiKey keeps retriable failure when remote confirms a different key id', async () => {
  const portalUser = await insertUser(
    'portal_user_delete_wrong_remote_id',
    'delete-wrong-remote-id@example.com'
  );
  const remote = createSuccessfulRemoteClient();
  const result = await modules.portal.createPortalApiKey(
    portalUser,
    portalKeyInput('Wrong remote delete confirmation'),
    remote as any
  );

  const wrongRemote = {
    ...remote,
    deleteKey: async () => ({
      id: 'different_remote_key',
      deleted: true,
    }),
  };

  await assert.rejects(
    () =>
      modules.portal.deletePortalApiKey(
        portalUser.id,
        result.binding.id,
        wrongRemote as any
      ),
    /did not confirm deleted key/
  );

  const [row] = await modules
    .db()
    .select()
    .from(modules.newApiKeyBinding)
    .where(eq(modules.newApiKeyBinding.id, result.binding.id));

  assert.equal(row.status, 'failed_retriable');
  assert.equal(row.deletedAt, null);
});

test('deletePortalApiKey cleans up Task 4 cleanable statuses with real remote-id shapes', async () => {
  const portalUser = await insertUser(
    'portal_user_cleanup_cleanable_statuses',
    'cleanup-cleanable-statuses@example.com'
  );
  const remote = createSuccessfulRemoteClient();

  const creating = await modules.portal.createPortalApiKey(
    portalUser,
    portalKeyInput('Cleanup creating_remote'),
    remote as any
  );
  await modules
    .db()
    .update(modules.newApiKeyBinding)
    .set({
      status: 'failed_terminal',
      newapiKeyId: 'pending:cleanup-creating',
    })
    .where(eq(modules.newApiKeyBinding.id, creating.binding.id));

  const terminal = await modules.portal.createPortalApiKey(
    portalUser,
    portalKeyInput('Cleanup failed_terminal'),
    remote as any
  );
  await modules
    .db()
    .update(modules.newApiKeyBinding)
    .set({ status: 'failed_terminal' })
    .where(eq(modules.newApiKeyBinding.id, terminal.binding.id));

  const retriableRemote = {
    ...remote,
    createKey: async () => ({
      id: 'remote_cleanup_retriable',
      key: 'sk-cleanup-retriable',
      maskedKey: 'sk-...cleanup-retriable',
      status: 'disabled',
    }),
  };
  await assert.rejects(
    () =>
      modules.portal.createPortalApiKey(
        portalUser,
        portalKeyInput('Cleanup failed_retriable'),
        retriableRemote as any
    ),
    /did not return active/
  );
  const [retriableRow] = await modules
    .db()
    .select()
    .from(modules.newApiKeyBinding)
    .where(eq(modules.newApiKeyBinding.newapiKeyId, 'remote_cleanup_retriable'));
  await modules
    .db()
    .update(modules.newApiKeyBinding)
    .set({ status: 'failed_terminal' })
    .where(eq(modules.newApiKeyBinding.id, retriableRow.id));

  const conflictSeed = await modules.portal.createPortalApiKey(
    portalUser,
    portalKeyInput('Cleanup conflict seed'),
    remote as any
  );
  const [conflictRow] = await modules
    .db()
    .select()
    .from(modules.newApiKeyBinding)
    .where(eq(modules.newApiKeyBinding.id, conflictSeed.binding.id));
  await modules
    .db()
    .update(modules.newApiKeyBinding)
    .set({ status: 'deleted', deletedAt: new Date() })
    .where(eq(modules.newApiKeyBinding.id, conflictSeed.binding.id));

  const bindingFailureRemote = {
    ...remote,
    createKey: async () => ({
      id: conflictRow.newapiKeyId,
      key: 'sk-cleanup-binding-failed',
      maskedKey: 'sk-...cleanup-binding-failed',
      status: 'active',
    }),
  };
  await assert.rejects(
    () =>
      modules.portal.createPortalApiKey(
        portalUser,
        portalKeyInput('Cleanup remote_created_binding_failed'),
        bindingFailureRemote as any
      ),
    /local key binding failed/i
  );
  await modules
    .db()
    .update(modules.newApiKeyBinding)
    .set({
      status: 'creating_remote',
      newapiKeyId: 'pending:cleanup-creating',
      deletedAt: null,
    })
    .where(eq(modules.newApiKeyBinding.id, creating.binding.id));
  await modules
    .db()
    .update(modules.newApiKeyBinding)
    .set({ status: 'failed_retriable', deletedAt: null })
    .where(eq(modules.newApiKeyBinding.id, retriableRow.id));

  let remoteDeleteAttempts = 0;
  const cleanupRemote = {
    deleteKey: async () => {
      remoteDeleteAttempts += 1;
      throw new Error('remote residue delete failed');
    },
  };

  const rowsBeforeCleanup = await modules
    .db()
    .select()
    .from(modules.newApiKeyBinding)
    .where(eq(modules.newApiKeyBinding.portalUserId, portalUser.id));
  const cleanupTargets = [
    {
      id: creating.binding.id,
      expectedStatus: 'creating_remote',
      expectRemoteDelete: false,
    },
    {
      id: terminal.binding.id,
      expectedStatus: 'failed_terminal',
      expectRemoteDelete: true,
    },
    {
      id: rowsBeforeCleanup.find(
        (row: any) => row.newapiKeyId === 'remote_cleanup_retriable'
      )?.id,
      expectedStatus: 'failed_retriable',
      expectRemoteDelete: true,
    },
    {
      id: rowsBeforeCleanup.find(
        (row: any) =>
          row.displayName === 'Cleanup remote_created_binding_failed'
      )?.id,
      expectedStatus: 'remote_created_binding_failed',
      expectRemoteDelete: false,
    },
  ];

  for (const target of cleanupTargets) {
    assert.ok(target.id, `${target.expectedStatus} fixture should exist`);
    const before = rowsBeforeCleanup.find((row: any) => row.id === target.id);
    assert.equal(before.status, target.expectedStatus);

    const attemptsBefore = remoteDeleteAttempts;
    const deleted = await modules.portal.deletePortalApiKey(
      portalUser.id,
      target.id,
      cleanupRemote as any
    );

    assert.equal(deleted.status, 'deleted');
    assert.ok(deleted.deletedAt instanceof Date);
    assert.equal(
      remoteDeleteAttempts - attemptsBefore,
      target.expectRemoteDelete ? 1 : 0
    );
  }

  const rows = await modules
    .db()
    .select()
    .from(modules.newApiKeyBinding)
    .where(eq(modules.newApiKeyBinding.portalUserId, portalUser.id));

  assert.deepEqual(
    cleanupTargets.map(
      (target) => rows.find((row: any) => row.id === target.id)?.status
    ),
    ['deleted', 'deleted', 'deleted', 'deleted']
  );
});

test('key lifecycle mutations reject non-actionable statuses before remote calls', async () => {
  const portalUser = await insertUser(
    'portal_user_key_action_guard',
    'key-action-guard@example.com'
  );
  const remote = createSuccessfulRemoteClient();
  const result = await modules.portal.createPortalApiKey(
    portalUser,
    portalKeyInput('Guarded key'),
    remote as any
  );

  const disabled = await modules.portal.disablePortalApiKey(
    portalUser.id,
    result.binding.id,
    remote as any
  );
  assert.equal(disabled.status, 'disabled');

  let remoteCalls = 0;
  const forbiddenRemote = {
    disableKey: async () => {
      remoteCalls += 1;
      throw new Error('remote disable should not be called');
    },
    deleteKey: async () => {
      remoteCalls += 1;
      throw new Error('remote delete should not be called');
    },
  };

  await assert.rejects(
    () =>
      modules.portal.disablePortalApiKey(
        portalUser.id,
        result.binding.id,
        forbiddenRemote as any
      ),
    /not in active state/
  );
  assert.equal(remoteCalls, 0);

  const deleted = await modules.portal.deletePortalApiKey(
    portalUser.id,
    result.binding.id,
    remote as any
  );
  assert.equal(deleted.status, 'deleted');

  await assert.rejects(
    () =>
      modules.portal.deletePortalApiKey(
        portalUser.id,
        result.binding.id,
        forbiddenRemote as any
      ),
    /not in deletable state/
  );
  assert.equal(remoteCalls, 0);
});

test('key lifecycle terminal remote errors persist failed_terminal', async () => {
  const disableUser = await insertUser(
    'portal_user_key_terminal_disable_failure',
    'key-terminal-disable-failure@example.com'
  );
  const deleteUser = await insertUser(
    'portal_user_key_terminal_delete_failure',
    'key-terminal-delete-failure@example.com'
  );
  const remote = createSuccessfulRemoteClient();
  const disableResult = await modules.portal.createPortalApiKey(
    disableUser,
    portalKeyInput('Terminal disable key'),
    remote as any
  );
  const deleteResult = await modules.portal.createPortalApiKey(
    deleteUser,
    portalKeyInput('Terminal delete key'),
    remote as any
  );
  const terminalRemote = {
    disableKey: async () => {
      throw new modules.NewApiBridgeError({
        code: 'forbidden',
        message: 'remote disable forbidden',
      });
    },
    deleteKey: async () => {
      throw new modules.NewApiBridgeError({
        code: 'malformed_response',
        message: 'remote delete response malformed',
      });
    },
  };

  await assert.rejects(
    () =>
      modules.portal.disablePortalApiKey(
        disableUser.id,
        disableResult.binding.id,
        terminalRemote as any
      ),
    /remote disable forbidden/
  );
  await assert.rejects(
    () =>
      modules.portal.deletePortalApiKey(
        deleteUser.id,
        deleteResult.binding.id,
        terminalRemote as any
      ),
    /remote delete response malformed/
  );

  const [disableRow] = await modules
    .db()
    .select()
    .from(modules.newApiKeyBinding)
    .where(eq(modules.newApiKeyBinding.id, disableResult.binding.id));
  const [deleteRow] = await modules
    .db()
    .select()
    .from(modules.newApiKeyBinding)
    .where(eq(modules.newApiKeyBinding.id, deleteResult.binding.id));

  assert.equal(disableRow.status, 'failed_terminal');
  assert.equal(deleteRow.status, 'failed_terminal');
});

test('key disable and delete audits include operation idempotency keys', async () => {
  const portalUser = await insertUser(
    'portal_user_key_mutation_audit',
    'key-mutation-audit@example.com'
  );
  const remote = createSuccessfulRemoteClient();
  const result = await modules.portal.createPortalApiKey(
    portalUser,
    portalKeyInput('Audited key'),
    remote as any
  );

  await modules.portal.disablePortalApiKey(
    portalUser.id,
    result.binding.id,
    remote as any
  );
  await modules.portal.deletePortalApiKey(
    portalUser.id,
    result.binding.id,
    remote as any
  );

  const audits = await modules
    .db()
    .select()
    .from(modules.newApiBridgeAuditLog)
    .where(eq(modules.newApiBridgeAuditLog.portalUserId, portalUser.id));

  const disableAudit = audits.find(
    (row: any) => row.action === 'newapi.key.disable'
  );
  const deleteAudit = audits.find(
    (row: any) => row.action === 'newapi.key.delete'
  );

  assert.match(
    disableAudit.idempotencyKey,
    /^portal-key-disable:portal_user_key_mutation_audit:/
  );
  assert.match(
    deleteAudit.idempotencyKey,
    /^portal-key-delete:portal_user_key_mutation_audit:/
  );
});

test('adjustPortalQuota applies ledger only after New API returns a change id', async () => {
  const portalUser = await insertUser(
    'portal_user_adjust_success',
    'adjust-success@example.com'
  );
  const operator = await insertUser(
    'operator_adjust_success',
    'ops-success@example.com'
  );
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
    'adjust-idempotent@example.com'
  );
  const operator = await insertUser(
    'operator_adjust_idempotent',
    'ops-idempotent@example.com'
  );
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
    'safe-ledger-dto@example.com'
  );
  const operator = await insertUser(
    'operator_safe_ledger_dto',
    'safe-ledger-ops@example.com'
  );
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
    'adjust-failure@example.com'
  );
  const operator = await insertUser(
    'operator_adjust_failure',
    'ops@example.com'
  );
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

test('adjustPortalQuota marks remote-applied confirmation failures for reconciliation', async () => {
  const portalUser = await insertUser(
    'portal_user_adjust_reconciliation',
    'adjust-reconciliation@example.com'
  );
  const operator = await insertUser(
    'operator_adjust_reconciliation',
    'ops-reconciliation@example.com'
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
  const portalUser = await insertUser(
    'portal_user_usage_sync',
    'usage-sync@example.com'
  );
  const syncedLog = {
    id: 'remote_request_1',
    keyMasked: 'sk-...usage',
    modelId: 'gpt-4o-mini',
    status: 'success',
    inputTokens: 12,
    outputTokens: 8,
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
});

test('getPortalUsage maps internal remote token names to portal key masks', async () => {
  const portalUser = await insertUser(
    'portal_user_usage_key_mask',
    'usage-key-mask@example.com'
  );
  let remoteTokenName = '';
  const fakeRemote = {
    ...createSuccessfulRemoteClient(),
    getQuota: async () => ({ balanceUsd: 25, quotaRemaining: 25 }),
    getUsageSummary: async () => ({
      requestCount: 1,
      inputTokens: 8,
      outputTokens: 1,
      spendUsd: 0.000002,
      byModel: [
        {
          modelId: 'gpt-4o-mini',
          requests: 1,
          tokens: 9,
          spendUsd: 0.000002,
        },
      ],
    }),
    listUsageLogs: async () => [
      {
        id: 'remote_request_internal_token_name',
        keyMasked: remoteTokenName,
        modelId: 'gpt-4o-mini',
        status: 'success',
        inputTokens: 8,
        outputTokens: 1,
        spendUsd: 0.000002,
        createdAt: '2026-05-24T10:00:00.000Z',
      },
    ],
  } as any;

  const created = await modules.portal.createPortalApiKey(
    portalUser,
    portalKeyInput('Usage key mask'),
    fakeRemote
  );
  const [keyRow] = await modules
    .db()
    .select()
    .from(modules.newApiKeyBinding)
    .where(eq(modules.newApiKeyBinding.portalUserId, portalUser.id));
  remoteTokenName = `pk_${keyRow.id.replace(/-/g, '').slice(0, 24)}`;

  const usage = await modules.portal.getPortalUsage(
    portalUser,
    '7d',
    fakeRemote
  );

  assert.equal(usage.logs[0].keyMasked, created.binding.keyMasked);
  assert.doesNotMatch(usage.logs[0].keyMasked, /^pk_/);

  const rows = await modules
    .db()
    .select()
    .from(modules.usageLogSnapshot)
    .where(eq(modules.usageLogSnapshot.portalUserId, portalUser.id));

  assert.equal(rows[0].keyMasked, created.binding.keyMasked);
  assert.doesNotMatch(rows[0].keyMasked, /^pk_/);
});

test('getPortalUsage preserves duplicate request ids from a single sync response', async () => {
  const portalUser = await insertUser(
    'portal_user_usage_duplicate_ids',
    'usage-duplicate-ids@example.com'
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
    'cached-usage-dto@example.com'
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
    'usage-old-cache@example.com'
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
  assert.match(usage.summary.errorMessage || '', /temporarily unavailable/);
});

test('getPortalUsage returns syncing snapshot without duplicate remote reads', async () => {
  const portalUser = await insertUser(
    'portal_user_usage_syncing',
    'usage-syncing@example.com'
  );
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
    'usage-initial-failure@example.com'
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
  assert.match(usage.summary.errorMessage || '', /temporarily unavailable/);
  assert.deepEqual(usage.logs, []);
});
