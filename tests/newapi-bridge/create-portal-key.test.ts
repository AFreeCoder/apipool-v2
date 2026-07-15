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

  await modules
    .db()
    .insert(modules.schema.catalogGroup)
    .values([
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

function createForbiddenRemoteClient() {
  let calls = 0;
  const client = new Proxy(
    {},
    {
      get() {
        calls += 1;
        throw new Error('门户 Key 本地生命周期不得调用 New API');
      },
    }
  );
  return { client, getCalls: () => calls };
}

async function getLocalKey(id: string) {
  const [row] = await modules
    .db()
    .select()
    .from(modules.schema.portalApiKey)
    .where(eq(modules.schema.portalApiKey.id, id));
  return row;
}

test.before(setupDb);

test('createPortalApiKey 对长短邮箱均只建本地 Key，不再创建远端用户或 token', async () => {
  for (const [id, email] of [
    ['create_key_long_email_user', 'very-long-user@example.com'],
    ['create_key_short_email_user', ' A@B.CO '],
  ]) {
    const portalUser = await insertUser(id, email);
    const remote = createForbiddenRemoteClient();

    const result = await modules.portal.createPortalApiKey(
      portalUser,
      { name: `Local key ${id}`, groupSlug: 'official' },
      remote.client as any
    );

    assert.match(result.plainKey, /^sk-ap-[A-Za-z0-9_-]{43}$/);
    assert.equal(result.binding.keyMasked, result.binding.keyPrefix);
    assert.equal(remote.getCalls(), 0);
    const bindings = await modules
      .db()
      .select()
      .from(modules.schema.newApiUserBinding)
      .where(eq(modules.schema.newApiUserBinding.portalUserId, id));
    assert.equal(bindings.length, 0);
  }
});

test('createPortalApiKey 只持久化本地 groupId、哈希和前缀，不泄漏内部字段', async () => {
  const portalUser = await insertUser('create_key_group_user', 'keyg1@t.co');
  const remote = createForbiddenRemoteClient();

  const result = await modules.portal.createPortalApiKey(
    portalUser,
    { name: 'Official key', groupSlug: 'official' },
    remote.client as any
  );
  const row = await getLocalKey(result.binding.id);

  assert.equal(row.groupId, groupIds.official);
  assert.equal(row.name, 'Official key');
  assert.equal(row.status, 'active');
  assert.match(row.keyHash, /^[a-f0-9]{64}$/);
  assert.notEqual(row.keyHash, result.plainKey);
  assert.equal(row.keyPrefix, result.binding.keyPrefix);
  assert.equal(remote.getCalls(), 0);

  const serialized = JSON.stringify(result);
  assert.equal(serialized.includes('newapiGroup'), false);
  assert.equal(serialized.includes('ng-official'), false);
  assert.equal(serialized.includes(groupIds.official), false);
  assert.equal(serialized.includes(row.keyHash), false);
  assert.equal(Object.hasOwn(result.binding, 'groupId'), false);
  assert.equal(Object.hasOwn(result.binding, 'newapiGroup'), false);
  assert.equal(Object.hasOwn(result.binding, 'keyHash'), false);
});

test('createPortalApiKey 拒绝未映射、禁用、锁定和不存在的分组且零远端调用', async () => {
  for (const groupSlug of ['unmapped', 'disabled', 'locked', 'missing']) {
    const portalUser = await insertUser(
      `create_key_reject_${groupSlug}`,
      `rej-${groupSlug}@t.co`
    );
    const remote = createForbiddenRemoteClient();

    await assert.rejects(
      modules.portal.createPortalApiKey(
        portalUser,
        { name: `Rejected ${groupSlug}`, groupSlug },
        remote.client as any
      ),
      /group not available/
    );
    assert.equal(remote.getCalls(), 0);
  }
});

test('createPortalApiKey 本地拒绝同名，删除后可复用名称', async () => {
  const portalUser = await insertUser('create_key_dup_user', 'keydup@t.co');
  const remote = createForbiddenRemoteClient();

  const first = await modules.portal.createPortalApiKey(
    portalUser,
    { name: 'My duplicate key', groupSlug: 'official' },
    remote.client as any
  );
  await assert.rejects(
    modules.portal.createPortalApiKey(
      portalUser,
      { name: 'My duplicate key', groupSlug: 'official' },
      remote.client as any
    ),
    /already exists/
  );
  assert.equal(remote.getCalls(), 0);

  await modules.portal.deletePortalApiKey(
    portalUser.id,
    first.binding.id,
    remote.client as any
  );
  const recreated = await modules.portal.createPortalApiKey(
    portalUser,
    { name: 'My duplicate key', groupSlug: 'official' },
    remote.client as any
  );
  assert.notEqual(recreated.binding.id, first.binding.id);
  assert.equal(remote.getCalls(), 0);
});

test('createPortalApiKey 自动补建零余额 wallet_account', async () => {
  const portalUser = await insertUser('create_key_wallet_user', 'wallet@t.co');

  await modules.portal.createPortalApiKey(portalUser, {
    name: 'Wallet key',
    groupSlug: 'official',
  });

  const [wallet] = await modules
    .db()
    .select()
    .from(modules.schema.walletAccount)
    .where(eq(modules.schema.walletAccount.userId, portalUser.id));
  assert.ok(wallet);
  assert.equal(wallet.balanceMicroUsd, 0);
});
