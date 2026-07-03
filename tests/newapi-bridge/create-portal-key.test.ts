import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { createClient } from '@libsql/client';
import { eq } from 'drizzle-orm';

let modules: any;
let groupIds: Record<string, string>;

async function setupDb() {
  const dbPath = join(process.cwd(), '.tmp', 'create-portal-key.db');
  await mkdir(join(process.cwd(), '.tmp'), { recursive: true });
  await rm(dbPath, { force: true });

  process.env.DATABASE_PROVIDER = 'sqlite';
  process.env.DATABASE_URL = `file:${dbPath}`;
  process.env.DB_SCHEMA_FILE = './src/config/db/schema.sqlite.ts';
  process.env.DB_SINGLETON_ENABLED = 'false';
  process.env.APIPOOL_CREDENTIALS_SECRET = 'create-portal-key-test-secret';

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

  modules = { db, portal, schema };

  await modules
    .db()
    .update(modules.schema.catalogGroup)
    .set({
      name: 'Official',
      userDescription: 'Official route',
      newapiGroup: 'ng-official',
      allowCreateKey: true,
      sortOrder: 1,
      status: 'active',
    })
    .where(eq(modules.schema.catalogGroup.slug, 'official'));

  await modules.db().insert(modules.schema.catalogGroup).values([
    {
      id: 'catalog_group_internal_disabled',
      slug: 'disabled',
      name: 'Disabled',
      userDescription: 'Disabled route',
      newapiGroup: 'ng-disabled',
      allowCreateKey: true,
      sortOrder: 2,
      status: 'disabled',
    },
    {
      id: 'catalog_group_internal_locked',
      slug: 'locked',
      name: 'Locked',
      userDescription: 'Locked route',
      newapiGroup: 'ng-locked',
      allowCreateKey: false,
      sortOrder: 3,
      status: 'active',
    },
    {
      id: 'catalog_group_internal_unmapped',
      slug: 'unmapped',
      name: 'Unmapped',
      userDescription: 'Missing remote route',
      newapiGroup: '',
      allowCreateKey: true,
      sortOrder: 4,
      status: 'active',
    },
  ]);

  groupIds = {
    official: 'seed_group_official',
    disabled: 'catalog_group_internal_disabled',
    locked: 'catalog_group_internal_locked',
    unmapped: 'catalog_group_internal_unmapped',
  };
}

async function insertUser(id: string, email: string) {
  await modules.db().insert(modules.schema.user).values({
    id,
    name: id,
    email,
    emailVerified: false,
  });
  return { id, name: id, email, emailVerified: false };
}

function createRecordingRemoteClient() {
  const createKeyInputs: any[] = [];
  const provisionUserInputs: any[] = [];
  const ensureUserGroupInputs: any[] = [];
  const client = {
    provisionUser: async (input: { username: string }) => {
      provisionUserInputs.push(input);
      return {
        newapiUserId: `remote_${input.username}`,
        accessToken: 'test-access-token',
      };
    },
    ensureUserGroup: async (input: any) => {
      ensureUserGroupInputs.push(input);
    },
    createKey: async (input: any) => {
      createKeyInputs.push(input);
      return {
        id: input.remoteName,
        key: `sk-test-${createKeyInputs.length}`,
        maskedKey: `sk-...${createKeyInputs.length}`,
        status: 'active',
      };
    },
  } as any;

  return {
    client,
    getCreateKeyInputs: () => createKeyInputs,
    getProvisionUserInputs: () => provisionUserInputs,
    getEnsureUserGroupInputs: () => ensureUserGroupInputs,
  };
}

async function getKeyBinding(id: string) {
  const [row] = await modules
    .db()
    .select()
    .from(modules.schema.newApiKeyBinding)
    .where(eq(modules.schema.newApiKeyBinding.id, id));
  return row;
}

test.before(setupDb);

test('createPortalApiKey blocks Phase A long emails before remote key creation', async () => {
  const portalUser = await insertUser(
    'create_key_long_email_user',
    'very-long-user@example.com'
  );
  const remote = createRecordingRemoteClient();

  await assert.rejects(
    modules.portal.createPortalApiKey(
      portalUser,
      { name: 'Long email key', groupSlug: 'official' },
      remote.client
    ),
    /Phase A limit/
  );

  assert.equal(remote.getProvisionUserInputs().length, 0);
  assert.equal(remote.getCreateKeyInputs().length, 0);
});

test('createPortalApiKey uses normalized email username for first-time short-email users', async () => {
  const portalUser = await insertUser(
    'create_key_short_email_user',
    ' A@B.CO '
  );
  const remote = createRecordingRemoteClient();

  await modules.portal.createPortalApiKey(
    portalUser,
    { name: 'Short email key', groupSlug: 'official' },
    remote.client
  );

  assert.equal(remote.getProvisionUserInputs()[0].username, 'a@b.co');
  assert.equal(/^pu_/.test(remote.getProvisionUserInputs()[0].username), false);
});

test('createPortalApiKey resolves groupSlug server-side and stores only internal group fields locally', async () => {
  const portalUser = await insertUser(
    'create_key_group_user',
    'keyg1@t.co'
  );
  const remote = createRecordingRemoteClient();

  const result = await modules.portal.createPortalApiKey(
    portalUser,
    { name: 'Official key', groupSlug: 'official' },
    remote.client
  );

  const [createKeyInput] = remote.getCreateKeyInputs();
  const [provisionUserInput] = remote.getProvisionUserInputs();
  assert.equal(provisionUserInput.group, 'ng-official');
  assert.equal(createKeyInput.group, 'ng-official');
  assert.notEqual(createKeyInput.group, 'official');
  assert.notEqual(createKeyInput.group, groupIds.official);
  assert.equal(Object.hasOwn(createKeyInput, 'allowedModels'), false);

  const row = await getKeyBinding(result.binding.id);
  assert.equal(row.groupId, groupIds.official);
  assert.equal(row.newapiGroup, 'ng-official');
  assert.equal(row.allowedModels, '[]');

  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes('newapiGroup'), false);
  assert.equal(serialized.includes('ng-official'), false);
  assert.equal(serialized.includes(groupIds.official), false);
  assert.equal(Object.hasOwn(result.binding, 'groupId'), false);
  assert.equal(Object.hasOwn(result.binding, 'newapiGroup'), false);
});

test('createPortalApiKey ensures an existing New API user can access the target group', async () => {
  const portalUser = await insertUser(
    'create_key_existing_group_user',
    'keyg2@t.co'
  );
  const remote = createRecordingRemoteClient();

  await modules.portal.createPortalApiKey(
    portalUser,
    { name: 'First official key', groupSlug: 'official' },
    remote.client
  );
  await modules.portal.createPortalApiKey(
    portalUser,
    { name: 'Second official key', groupSlug: 'official' },
    remote.client
  );

  const [provisionInput] = remote.getProvisionUserInputs();
  assert.equal(remote.getProvisionUserInputs().length, 1);
  assert.deepEqual(remote.getEnsureUserGroupInputs(), [
    {
      newapiUserId: `remote_${provisionInput.username}`,
      username: provisionInput.username,
      group: 'ng-official',
    },
  ]);
  assert.equal(remote.getCreateKeyInputs()[1].group, 'ng-official');
});

test('createPortalApiKey rejects key-capable groups without explicit New API mapping before calling remote', async () => {
  const portalUser = await insertUser(
    'create_key_unmapped_user',
    'unmap@t.co'
  );
  const remote = createRecordingRemoteClient();

  await assert.rejects(
    () =>
      modules.portal.createPortalApiKey(
        portalUser,
        { name: 'Unmapped key', groupSlug: 'unmapped' },
        remote.client
      ),
    /group not available/
  );
  assert.equal(remote.getCreateKeyInputs().length, 0);
});

test('createPortalApiKey rejects unavailable groups before calling the remote client', async () => {
  for (const [groupSlug, expectedMessage] of [
    ['disabled', /group not available/],
    ['locked', /group not available/],
    ['missing', /group not available/],
  ] as const) {
    const portalUser = await insertUser(
      `create_key_reject_${groupSlug}`,
      `rej-${groupSlug}@t.co`
    );
    const remote = createRecordingRemoteClient();

    await assert.rejects(
      () =>
        modules.portal.createPortalApiKey(
          portalUser,
          { name: `Rejected ${groupSlug}`, groupSlug },
          remote.client
        ),
      expectedMessage
    );
    assert.equal(remote.getCreateKeyInputs().length, 0);
  }
});

test('createPortalApiKey rejects duplicate key names before calling the remote client', async () => {
  const portalUser = await insertUser(
    'create_key_dup_user',
    'keydup@t.co'
  );
  // 用唯一 remote key id，避免与其它用例共享 db 时撞 newapi_key_id 的 UNIQUE 约束
  const createKeyInputs: any[] = [];
  const dupClient = {
    provisionUser: async (input: { username: string }) => ({
      newapiUserId: `remote_dup_${input.username}`,
      accessToken: 'test-access-token',
    }),
    createKey: async (input: any) => {
      createKeyInputs.push(input);
      return {
        id: `dup_key_${createKeyInputs.length}`,
        key: `sk-dup-${createKeyInputs.length}`,
        maskedKey: `sk-...dup${createKeyInputs.length}`,
        status: 'active',
      };
    },
  } as any;

  await modules.portal.createPortalApiKey(
    portalUser,
    { name: 'My duplicate key', groupSlug: 'official' },
    dupClient
  );
  assert.equal(createKeyInputs.length, 1);

  // 同名再建 → 拒绝，且不再触达远端
  await assert.rejects(
    () =>
      modules.portal.createPortalApiKey(
        portalUser,
        { name: 'My duplicate key', groupSlug: 'official' },
        dupClient
      ),
    /already exists/
  );
  assert.equal(createKeyInputs.length, 1);
});

test('deletePortalApiKey cleans up failed/stuck keys locally without requiring remote', async () => {
  const portalUser = await insertUser(
    'cleanup_failed_user',
    'clean@t.co'
  );
  const failingClient = {
    provisionUser: async (input: { username: string }) => ({
      newapiUserId: `remote_${input.username}`,
      accessToken: 'test-access-token',
    }),
    createKey: async () => {
      throw new Error('remote create failed');
    },
    deleteKey: async () => {
      throw new Error('deleteKey must not be called for never-created keys');
    },
  } as any;

  // 建 Key 失败 → 抛错但留 failed_retriable 死记录（newapiKeyId 仍为 pending:）
  await assert.rejects(
    () =>
      modules.portal.createPortalApiKey(
        portalUser,
        { name: 'Doomed key', groupSlug: 'official' },
        failingClient
      ),
    /remote create failed/
  );
  const rows = await modules
    .db()
    .select()
    .from(modules.schema.newApiKeyBinding)
    .where(eq(modules.schema.newApiKeyBinding.portalUserId, portalUser.id));
  const failed = rows.find((r: any) => r.status === 'failed_retriable');
  assert.ok(failed, 'failed key binding should remain after remote failure');

  // 清理删除：远端从未建成（pending:），跳过远端删除、本地落 deleted
  const result = await modules.portal.deletePortalApiKey(
    portalUser.id,
    failed.id,
    failingClient
  );
  assert.equal(result.status, 'deleted');
  const after = await getKeyBinding(failed.id);
  assert.equal(after.status, 'deleted');
});
