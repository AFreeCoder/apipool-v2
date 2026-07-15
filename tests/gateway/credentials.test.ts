import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { createClient } from '@libsql/client';
import { and, eq } from 'drizzle-orm';

let modules: any;
let client: ReturnType<typeof createClient>;

async function setupDb() {
  const dbPath = join(process.cwd(), '.tmp', 'gateway-credentials.db');
  await mkdir(join(process.cwd(), '.tmp'), { recursive: true });
  await rm(dbPath, { force: true });
  process.env.DATABASE_PROVIDER = 'sqlite';
  process.env.DATABASE_URL = `file:${dbPath}`;
  process.env.DB_SCHEMA_FILE = './src/config/db/schema.sqlite.ts';
  process.env.DB_SINGLETON_ENABLED = 'false';
  process.env.APIPOOL_CREDENTIALS_SECRET = 'gateway-credentials-test-secret';

  client = createClient({ url: `file:${dbPath}` });
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
  const credentials = await import('@/features/gateway/server/credentials');
  const crypto = await import('@/features/newapi-bridge/server/crypto');
  modules = { credentials, crypto, db, schema };
}

async function insertUser(userId: string) {
  await modules
    .db()
    .insert(modules.schema.user)
    .values({
      id: userId,
      name: userId,
      email: `${userId}@credentials.test`,
    });
}

async function insertBinding(userId: string, status = 'active') {
  await modules
    .db()
    .insert(modules.schema.newApiUserBinding)
    .values({
      id: `binding-${userId}`,
      portalUserId: userId,
      newapiUserId: `remote-${userId}`,
      status,
      newapiAccessTokenEnc: modules.crypto.encryptCredential(
        `access-${userId}`
      ),
    });
}

async function insertCredential(
  userId: string,
  group: string,
  values: Record<string, unknown> = {}
) {
  const [row] = await modules
    .db()
    .insert(modules.schema.runtimeCredential)
    .values({
      id: `credential-${userId}-${group}`,
      portalUserId: userId,
      newapiGroup: group,
      remoteName: modules.credentials.buildRuntimeCredentialName(userId, group),
      status: 'pending',
      ...values,
    })
    .returning();
  return row;
}

async function getCredential(userId: string, group: string) {
  const [row] = await modules
    .db()
    .select()
    .from(modules.schema.runtimeCredential)
    .where(
      and(
        eq(modules.schema.runtimeCredential.portalUserId, userId),
        eq(modules.schema.runtimeCredential.newapiGroup, group)
      )
    );
  return row;
}

function createWorkerHarness(initial: Record<string, any[]> = {}) {
  const tokens = new Map<string, any[]>(Object.entries(initial));
  const createCalls: any[] = [];
  const disableCalls: any[] = [];
  let sequence = 0;
  const workerClient = {
    findTokensByNameExact: async (_credentials: any, name: string) =>
      tokens.get(name) || [],
    createTokenRaw: async (_credentials: any, input: any) => {
      createCalls.push(input);
      sequence += 1;
      const next = {
        id: `new-token-${sequence}`,
        name: input.name,
        group: input.group,
        status: 1,
      };
      tokens.set(input.name, [...(tokens.get(input.name) || []), next]);
    },
    getTokenKey: async (_credentials: any, tokenId: string) =>
      `sk-runtime-${tokenId}`,
    disableKey: async (_credentials: any, tokenId: string) => {
      disableCalls.push(tokenId);
      return { id: tokenId, status: 'disabled' };
    },
    createKey: async () => {
      throw new Error('worker 禁止调用 client.createKey');
    },
  };
  const ensureBinding = async (user: any) => ({
    id: `binding-mock-${user.id}`,
    portalUserId: user.id,
    newapiUserId: `remote-${user.id}`,
    status: 'active',
    newapiAccessTokenEnc: modules.crypto.encryptCredential(`access-${user.id}`),
  });
  return {
    client: workerClient,
    ensureBinding,
    createCalls,
    disableCalls,
    tokens,
  };
}

test.before(setupDb);
test.after(() => client.close());

test('remoteName 确定性：同 scope 恒等、≤27 字符、rk_ 前缀', () => {
  const first = modules.credentials.buildRuntimeCredentialName(
    'user-a',
    'official'
  );
  const second = modules.credentials.buildRuntimeCredentialName(
    'user-a',
    'official'
  );
  assert.equal(first, second);
  assert.match(first, /^rk_[a-f0-9]{24}$/);
  assert.ok(first.length <= 27);
  assert.notEqual(
    first,
    modules.credentials.buildRuntimeCredentialName('user-a', 'other')
  );
});

test('热路径：无行并发 ensure 只插一行且都返回 pending', async () => {
  await insertUser('credential-hot-pending');
  const [first, second] = await Promise.all([
    modules.credentials.ensureRuntimeCredential(
      'credential-hot-pending',
      'official'
    ),
    modules.credentials.ensureRuntimeCredential(
      'credential-hot-pending',
      'official'
    ),
  ]);
  assert.equal(first.status, 'pending');
  assert.equal(second.status, 'pending');
  const rows = await modules
    .db()
    .select()
    .from(modules.schema.runtimeCredential)
    .where(
      eq(
        modules.schema.runtimeCredential.portalUserId,
        'credential-hot-pending'
      )
    );
  assert.equal(rows.length, 1);
  await modules
    .db()
    .delete(modules.schema.runtimeCredential)
    .where(
      eq(
        modules.schema.runtimeCredential.portalUserId,
        'credential-hot-pending'
      )
    );
});

test('worker 串行创建两个 pending scope，落 active 加密 token', async () => {
  await insertUser('credential-worker-a');
  await insertUser('credential-worker-b');
  await insertCredential('credential-worker-a', 'official');
  await insertCredential('credential-worker-b', 'premium');
  const harness = createWorkerHarness();

  const result = await modules.credentials.runCredentialWorkerOnce(harness);

  assert.equal(result.processed, 2);
  assert.equal(result.failed, 0);
  assert.equal(harness.createCalls.length, 2);
  for (const [userId, group] of [
    ['credential-worker-a', 'official'],
    ['credential-worker-b', 'premium'],
  ]) {
    const row = await getCredential(userId, group);
    assert.equal(row.status, 'active');
    assert.match(
      modules.crypto.decryptCredential(row.tokenEnc),
      /^sk-runtime-/
    );
  }
});

test('崩溃后收编：已有唯一启用同名 token 时零 POST', async () => {
  const userId = 'credential-adopt';
  const group = 'official';
  await insertUser(userId);
  const row = await insertCredential(userId, group);
  const harness = createWorkerHarness({
    [row.remoteName]: [
      { id: 'adopt-token', name: row.remoteName, group, status: 1 },
    ],
  });

  await modules.credentials.runCredentialWorkerOnce(harness);

  const adopted = await getCredential(userId, group);
  assert.equal(harness.createCalls.length, 0);
  assert.equal(adopted.newapiTokenId, 'adopt-token');
  assert.equal(adopted.status, 'active');
});

test('收编 group 不符时留 pending + adoption_mismatch，不创建不删除', async () => {
  const userId = 'credential-adopt-mismatch';
  const group = 'official';
  await insertUser(userId);
  const row = await insertCredential(userId, group);
  const harness = createWorkerHarness({
    [row.remoteName]: [
      {
        id: 'wrong-group-token',
        name: row.remoteName,
        group: 'other',
        status: 1,
      },
    ],
  });

  const result = await modules.credentials.runCredentialWorkerOnce(harness);

  const pending = await getCredential(userId, group);
  assert.equal(result.failed, 1);
  assert.equal(pending.status, 'pending');
  assert.match(pending.lastError, /^adoption_mismatch:/);
  assert.equal(harness.createCalls.length, 0);
  assert.equal(harness.disableCalls.length, 0);
  await modules
    .db()
    .delete(modules.schema.runtimeCredential)
    .where(eq(modules.schema.runtimeCredential.id, row.id));
});

test('禁用同名不收编：创建后锁定唯一启用新 token', async () => {
  const userId = 'credential-disabled-name';
  const group = 'official';
  await insertUser(userId);
  const row = await insertCredential(userId, group);
  const harness = createWorkerHarness({
    [row.remoteName]: [
      { id: 'disabled-token', name: row.remoteName, group, status: 2 },
    ],
  });

  await modules.credentials.runCredentialWorkerOnce(harness);

  const active = await getCredential(userId, group);
  assert.equal(harness.createCalls.length, 1);
  assert.equal(active.newapiTokenId, 'new-token-1');
});

test('用户禁用入 retirement、清 token；worker 随后远端禁用', async () => {
  const userId = 'credential-user-disable';
  await insertUser(userId);
  await insertBinding(userId, 'disabled');
  const row = await insertCredential(userId, 'official', {
    status: 'active',
    newapiUserId: `remote-${userId}`,
    newapiTokenId: 'disable-old-token',
    tokenEnc: modules.crypto.encryptCredential('sk-disable-old'),
  });

  await modules.credentials.disableRuntimeCredentialsForUser(
    userId,
    'user_disable'
  );
  const disabled = await getCredential(userId, 'official');
  assert.equal(disabled.status, 'disabled');
  assert.equal(disabled.tokenEnc, null);
  const harness = createWorkerHarness();
  await modules.credentials.runCredentialWorkerOnce(harness);
  assert.deepEqual(harness.disableCalls, ['disable-old-token']);
  const [retirement] = await modules
    .db()
    .select()
    .from(modules.schema.credentialRetirement)
    .where(eq(modules.schema.credentialRetirement.credentialId, row.id));
  assert.ok(retirement.disabledAt);
});

test('禁用后恢复：ensure 转 pending，旧 token 黑名单迫使新建', async () => {
  const userId = 'credential-restore';
  const group = 'official';
  await insertUser(userId);
  await insertBinding(userId, 'active');
  const row = await insertCredential(userId, group, { status: 'disabled' });
  await modules.db().insert(modules.schema.credentialRetirement).values({
    id: 'retirement-restore-old',
    credentialId: row.id,
    newapiTokenId: 'restore-old-token',
    reason: 'user_disable',
    disabledAt: new Date(),
  });
  const ensured = await modules.credentials.ensureRuntimeCredential(
    userId,
    group
  );
  assert.equal(ensured.status, 'pending');
  const harness = createWorkerHarness({
    [row.remoteName]: [
      { id: 'restore-old-token', name: row.remoteName, group, status: 1 },
    ],
  });
  await modules.credentials.runCredentialWorkerOnce(harness);
  const active = await getCredential(userId, group);
  assert.equal(active.newapiTokenId, 'new-token-1');
});

test('invalid 与 rotate 都把旧 token 列入黑名单并重建', async () => {
  for (const mode of ['invalid', 'rotate']) {
    const userId = `credential-${mode}-rebuild`;
    const group = 'official';
    await insertUser(userId);
    const oldTokenId = `${mode}-old-token`;
    const row = await insertCredential(userId, group, {
      status: 'active',
      newapiTokenId: oldTokenId,
      tokenEnc: modules.crypto.encryptCredential(`sk-${oldTokenId}`),
    });
    if (mode === 'invalid') {
      await modules.credentials.markCredentialInvalid(row.id, 'upstream 401');
    } else {
      await modules.credentials.rotateRuntimeCredential(row.id, 'operator-1');
    }
    const harness = createWorkerHarness({
      [row.remoteName]: [
        { id: oldTokenId, name: row.remoteName, group, status: 1 },
      ],
    });
    await modules.credentials.runCredentialWorkerOnce(harness);
    const active = await getCredential(userId, group);
    assert.equal(active.status, 'active');
    assert.notEqual(active.newapiTokenId, oldTokenId);
  }
});

test('keepAlive 第二次返回 false 时本轮只处理一条', async () => {
  await insertUser('credential-keepalive-a');
  await insertUser('credential-keepalive-b');
  await insertCredential('credential-keepalive-a', 'official');
  await insertCredential('credential-keepalive-b', 'official');
  const harness = createWorkerHarness();
  let calls = 0;

  const result = await modules.credentials.runCredentialWorkerOnce({
    ...harness,
    keepAlive: async () => {
      calls += 1;
      return calls === 1;
    },
  });

  assert.equal(result.processed, 1);
  assert.equal(harness.createCalls.length, 1);
});

test('LRU 10 分钟内复用，显式失效后读取新密文', async () => {
  const userId = 'credential-lru';
  const group = 'official';
  await insertUser(userId);
  const row = await insertCredential(userId, group, {
    status: 'active',
    newapiTokenId: 'lru-token',
    tokenEnc: modules.crypto.encryptCredential('sk-lru-old'),
  });
  const first = await modules.credentials.ensureRuntimeCredential(
    userId,
    group
  );
  assert.equal(first.runtimeKey, 'sk-lru-old');
  await modules
    .db()
    .update(modules.schema.runtimeCredential)
    .set({ tokenEnc: modules.crypto.encryptCredential('sk-lru-new') })
    .where(eq(modules.schema.runtimeCredential.id, row.id));
  const cached = await modules.credentials.ensureRuntimeCredential(
    userId,
    group
  );
  assert.equal(cached.runtimeKey, 'sk-lru-old');
  modules.credentials.invalidateCredentialCache(userId, group);
  const refreshed = await modules.credentials.ensureRuntimeCredential(
    userId,
    group
  );
  assert.equal(refreshed.runtimeKey, 'sk-lru-new');
});
