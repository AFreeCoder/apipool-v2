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
  process.env.NEWAPI_DEFAULT_TOKEN_GROUP = 'auto';
  process.env.NEWAPI_TOKEN_CROSS_GROUP_RETRY = 'true';

  const client = createClient({ url: `file:${dbPath}` });
  const migrationsDir = join(process.cwd(), 'src/config/db/migrations_sqlite');
  for (const file of (await readdir(migrationsDir)).filter((name) => name.endsWith('.sql')).sort()) {
    await client.executeMultiple(await readFile(join(migrationsDir, file), 'utf8'));
  }

  const { user } = await import('@/config/db/schema');
  const { newApiBridgeAuditLog, newApiKeyBinding, usageLogSnapshot, usageSnapshot } =
    await import('@/config/db/schema');
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
    usageLogSnapshot,
    usageSnapshot,
    user,
  };
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

test('createPortalApiKey defaults to one auto-group key for all models', async () => {
  const portalUser = await insertUser(
    'portal_user_auto_all_models',
    'auto-all-models@example.com'
  );
  let createInput: any;
  const fakeRemote = {
    provisionUser: async (input: { username: string }) => ({
      newapiUserId: `remote_${input.username}`,
      accessToken: 'test-access-token',
    }),
    createKey: async (input: any) => {
      createInput = input;
      return {
        id: 'remote_auto_all_models',
        key: 'sk-auto-all-models',
        maskedKey: 'sk-...auto',
        status: 'active',
      };
    },
  } as any;

  const created = await modules.portal.createPortalApiKey(
    portalUser,
    { name: 'One key' },
    fakeRemote
  );

  assert.deepEqual(createInput.allowedModels, []);
  assert.equal(createInput.group, 'auto');
  assert.equal(createInput.crossGroupRetry, true);
  assert.deepEqual(created.binding.allowedModels, []);

  const [row] = await modules
    .db()
    .select()
    .from(modules.newApiKeyBinding)
    .where(eq(modules.newApiKeyBinding.id, created.binding.id));
  assert.equal(row.allowedModels, '[]');
});

test('createPortalApiKey keeps a retriable local key row when remote creation fails', async () => {
  const portalUser = await insertUser(
    'portal_user_create_failure',
    'create-failure@example.com'
  );

  const fakeRemote = {
    provisionUser: async () => ({ newapiUserId: 'remote_user_1', accessToken: 'test-access-token' }),
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
        { name: 'Default key', allowedModels: ['gpt-4o-mini'] },
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
    provisionUser: async () => ({ newapiUserId: 'remote_user_disabled_key', accessToken: 'test-access-token' }),
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
        { name: 'Disabled remote key', allowedModels: ['gpt-4o-mini'] },
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
  const existingOwner = await insertUser(
    'portal_user_create_binding_failure',
    'create-binding-failure@example.com'
  );
  const portalUser = await insertUser(
    'portal_user_create_binding_failure_target',
    'create-binding-failure-target@example.com'
  );
  const remote = createSuccessfulRemoteClient() as any;
  const existing = await modules.portal.createPortalApiKey(
    existingOwner,
    { name: 'Existing remote key', allowedModels: ['gpt-4o-mini'] },
    remote
  );
  const [existingRow] = await modules
    .db()
    .select()
    .from(modules.newApiKeyBinding)
    .where(eq(modules.newApiKeyBinding.id, existing.binding.id));
  const conflictingRemoteId = existingRow.newapiKeyId;

  const failingRemote = {
    provisionUser: async (input: { username: string }) => ({
      newapiUserId: `remote_${input.username}`,
      accessToken: 'test-access-token',
    }),
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
        { name: 'Binding failure key', allowedModels: ['gpt-4o-mini'] },
        failingRemote
      ),
    /Failed query|UNIQUE|unique|constraint/i
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
    { name: 'Owner key', allowedModels: ['gpt-4o-mini'] },
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

test('createPortalApiKey allows only one customer key per user', async () => {
  const portalUser = await insertUser(
    'portal_user_single_key',
    'single-key@example.com'
  );
  const remote = createSuccessfulRemoteClient() as any;
  await modules.portal.createPortalApiKey(
    portalUser,
    { name: 'Primary key', allowedModels: ['gpt-4o-mini'] },
    remote
  );

  let remoteCreateCalls = 0;
  const blockedRemote = {
    ...remote,
    createKey: async () => {
      remoteCreateCalls += 1;
      throw new Error('duplicate remote create should not be called');
    },
  } as any;

  await assert.rejects(
    () =>
      modules.portal.createPortalApiKey(
        portalUser,
        { name: 'Duplicate key', allowedModels: ['gpt-4o-mini'] },
        blockedRemote
      ),
    /only one API key/
  );

  const rows = await modules
    .db()
    .select()
    .from(modules.newApiKeyBinding)
    .where(eq(modules.newApiKeyBinding.portalUserId, portalUser.id));

  assert.equal(rows.length, 1);
  assert.equal(remoteCreateCalls, 0);
});

test('createPortalApiKey allows retry after a pending remote failure', async () => {
  const portalUser = await insertUser(
    'portal_user_single_key_retry',
    'single-key-retry@example.com'
  );
  let shouldFail = true;
  const remote = {
    provisionUser: async (input: { username: string }) => ({
      newapiUserId: `remote_${input.username}`,
      accessToken: 'test-access-token',
    }),
    createKey: async () => {
      if (shouldFail) {
        shouldFail = false;
        throw new modules.NewApiBridgeError({
          code: 'timeout',
          message: 'remote create timed out',
        });
      }
      return {
        id: 'remote_retry_success',
        key: 'sk-retry-success',
        maskedKey: 'sk-...retry',
        status: 'active',
      };
    },
  } as any;

  await assert.rejects(
    () =>
      modules.portal.createPortalApiKey(
        portalUser,
        { name: 'Retry key', allowedModels: ['gpt-4o-mini'] },
        remote
      ),
    /remote create timed out/
  );

  const created = await modules.portal.createPortalApiKey(
    portalUser,
    { name: 'Retry key 2', allowedModels: ['gpt-4o-mini'] },
    remote
  );

  assert.equal(created.binding.status, 'active');
});

test('portal key DTOs expose only MVP customer key fields', async () => {
  const portalUser = await insertUser(
    'portal_user_safe_key_dto',
    'safe-key-dto@example.com'
  );
  const remote = createSuccessfulRemoteClient();
  const created = await modules.portal.createPortalApiKey(
    portalUser,
    { name: 'Safe key DTO', allowedModels: ['gpt-4o-mini'] },
    remote as any
  );

  const forbiddenFields = [
    'newapiUserId',
    'newapiKeyId',
    'idempotencyKey',
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

test('listPortalApiKeys syncs remote key status without exposing remote ids', async () => {
  const portalUser = await insertUser(
    'portal_user_key_list_sync',
    'key-list-sync@example.com'
  );
  const remote = createSuccessfulRemoteClient() as any;
  const created = await modules.portal.createPortalApiKey(
    portalUser,
    { name: 'List sync key', allowedModels: ['gpt-4o-mini'] },
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
  assertNoFields(listed[0], [
    'newapiUserId',
    'newapiKeyId',
    'idempotencyKey',
  ]);

  const rows = await modules
    .db()
    .select()
    .from(modules.newApiKeyBinding)
    .where(eq(modules.newApiKeyBinding.id, created.binding.id));
  assert.equal(rows[0].status, 'disabled');
  assert.equal(rows[0].keyMasked, 'sk-...remote-disabled');
});

test('listPortalApiKeys removes delete-pending bindings after remote revocation is visible', async () => {
  const portalUser = await insertUser(
    'portal_user_key_delete_pending_sync',
    'key-delete-pending-sync@example.com'
  );
  const remote = createSuccessfulRemoteClient() as any;
  const created = await modules.portal.createPortalApiKey(
    portalUser,
    { name: 'Delete pending key', allowedModels: ['gpt-4o-mini'] },
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
  assert.equal(listedAfterRevocation.length, 0);

  const rows = await modules
    .db()
    .select()
    .from(modules.newApiKeyBinding)
    .where(eq(modules.newApiKeyBinding.id, created.binding.id));
  assert.equal(rows.length, 0);
});

test('listPortalApiKeys removes legacy soft-deleted key bindings', async () => {
  const portalUser = await insertUser(
    'portal_user_legacy_soft_deleted_key',
    'legacy-soft-deleted-key@example.com'
  );
  const remote = createSuccessfulRemoteClient() as any;
  const created = await modules.portal.createPortalApiKey(
    portalUser,
    { name: 'Legacy deleted key', allowedModels: ['gpt-4o-mini'] },
    remote
  );

  await modules
    .db()
    .update(modules.newApiKeyBinding)
    .set({ status: 'deleted', deletedAt: new Date() })
    .where(eq(modules.newApiKeyBinding.id, created.binding.id));

  const listed = await modules.portal.listPortalApiKeys(portalUser.id, remote);
  assert.equal(listed.length, 0);

  const rows = await modules
    .db()
    .select()
    .from(modules.newApiKeyBinding)
    .where(eq(modules.newApiKeyBinding.id, created.binding.id));
  assert.equal(rows.length, 0);
});

test('disablePortalApiKey and deletePortalApiKey complete only after remote confirmation', async () => {
  const portalUser = await insertUser(
    'portal_user_key_lifecycle',
    'key-lifecycle@example.com'
  );
  const remote = createSuccessfulRemoteClient();
  const result = await modules.portal.createPortalApiKey(
    portalUser,
    { name: 'Lifecycle key', allowedModels: ['gpt-4o-mini'] },
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

  const rows = await modules
    .db()
    .select()
    .from(modules.newApiKeyBinding)
    .where(eq(modules.newApiKeyBinding.id, result.binding.id));
  assert.equal(rows.length, 0);
});

test('disablePortalApiKey keeps retriable failure when remote does not confirm disabled', async () => {
  const portalUser = await insertUser(
    'portal_user_disable_unconfirmed',
    'disable-unconfirmed@example.com'
  );
  const remote = createSuccessfulRemoteClient();
  const result = await modules.portal.createPortalApiKey(
    portalUser,
    { name: 'Unconfirmed disable key', allowedModels: ['gpt-4o-mini'] },
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
    { name: 'Wrong remote delete confirmation', allowedModels: ['gpt-4o-mini'] },
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

test('key lifecycle mutations reject non-actionable statuses before remote calls', async () => {
  const portalUser = await insertUser(
    'portal_user_key_action_guard',
    'key-action-guard@example.com'
  );
  const remote = createSuccessfulRemoteClient();
  const result = await modules.portal.createPortalApiKey(
    portalUser,
    { name: 'Guarded key', allowedModels: ['gpt-4o-mini'] },
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
    /not found/
  );
  assert.equal(remoteCalls, 0);
});

test('key lifecycle terminal remote errors persist failed_terminal', async () => {
  const disableUser = await insertUser(
    'portal_user_key_terminal_disable',
    'key-terminal-disable@example.com'
  );
  const deleteUser = await insertUser(
    'portal_user_key_terminal_delete',
    'key-terminal-delete@example.com'
  );
  const remote = createSuccessfulRemoteClient();
  const disableResult = await modules.portal.createPortalApiKey(
    disableUser,
    { name: 'Terminal disable key', allowedModels: ['gpt-4o-mini'] },
    remote as any
  );
  const deleteResult = await modules.portal.createPortalApiKey(
    deleteUser,
    { name: 'Terminal delete key', allowedModels: ['gpt-4o-mini'] },
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

  const rows = await modules
    .db()
    .select()
    .from(modules.newApiKeyBinding)
    .where(eq(modules.newApiKeyBinding.status, 'failed_terminal'));
  const disableRow = rows.find((row: any) => row.id === disableResult.binding.id);
  const deleteRow = rows.find((row: any) => row.id === deleteResult.binding.id);

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
    { name: 'Audited key', allowedModels: ['gpt-4o-mini'] },
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
  await modules.db().insert(modules.usageSnapshot).values({
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
