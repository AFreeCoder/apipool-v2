import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { createClient } from '@libsql/client';
import { eq } from 'drizzle-orm';

let modules: any;
let client: ReturnType<typeof createClient>;

async function setupDb() {
  const dbPath = join(process.cwd(), '.tmp', 'gateway-auth.db');
  await mkdir(join(process.cwd(), '.tmp'), { recursive: true });
  await rm(dbPath, { force: true });
  process.env.DATABASE_PROVIDER = 'sqlite';
  process.env.DATABASE_URL = `file:${dbPath}`;
  process.env.DB_SCHEMA_FILE = './src/config/db/schema.sqlite.ts';
  process.env.DB_SINGLETON_ENABLED = 'false';
  process.env.APIPOOL_CREDENTIALS_SECRET = 'gateway-auth-test-secret';

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
  const auth = await import('@/features/gateway/server/auth');
  const portal = await import('@/features/newapi-bridge/server/portal');
  modules = { auth, db, portal, schema };

  await modules.db().insert(schema.catalogGroup).values({
    id: 'gateway-auth-group',
    slug: 'gateway-auth',
    name: 'Gateway Auth',
    newapiGroup: 'official',
    allowCreateKey: true,
    status: 'active',
  });
}

async function insertUser(userId: string, balanceMicroUsd = 1_000_000) {
  await modules
    .db()
    .insert(modules.schema.user)
    .values({
      id: userId,
      name: userId,
      email: `${userId}@gateway-auth.test`,
    });
  await modules.db().insert(modules.schema.walletAccount).values({
    userId,
    balanceMicroUsd,
  });
}

async function insertKey(
  userId: string,
  plain: string,
  status = 'active',
  lastUsedAt?: Date
) {
  const [row] = await modules
    .db()
    .insert(modules.schema.portalApiKey)
    .values({
      id: `key-${userId}`,
      userId,
      groupId: 'gateway-auth-group',
      keyHash: modules.auth.hashPortalKey(plain),
      keyPrefix: `sk-ap-…${plain.slice(-4)}`,
      status,
      name: `Key ${userId}`,
      lastUsedAt,
    })
    .returning();
  return row;
}

async function responseCode(result: any) {
  assert.equal(result.ok, false);
  return (await result.response.json()).error.code;
}

test.before(setupDb);
test.after(() => client.close());

test('generatePortalKey 生成固定格式、可复算哈希且两次不同', () => {
  const first = modules.auth.generatePortalKey();
  const second = modules.auth.generatePortalKey();

  assert.match(first.plain, /^sk-ap-[A-Za-z0-9_-]{43}$/);
  assert.equal(first.hash, modules.auth.hashPortalKey(first.plain));
  assert.equal(first.prefix, `sk-ap-…${first.plain.slice(-4)}`);
  assert.notEqual(first.plain, second.plain);
});

test('extractPortalKey 优先 Authorization Bearer，并以 x-api-key 兜底', () => {
  assert.equal(
    modules.auth.extractPortalKey(
      new Headers({ authorization: 'Bearer bearer-key', 'x-api-key': 'x-key' })
    ),
    'bearer-key'
  );
  assert.equal(
    modules.auth.extractPortalKey(new Headers({ 'x-api-key': 'x-key' })),
    'x-key'
  );
  assert.equal(modules.auth.extractPortalKey(new Headers()), null);
});

test('鉴权链 401：不存在或 disabled 的门户 Key', async () => {
  const missing = await modules.auth.authenticateGatewayRequest(
    new Headers({ authorization: 'Bearer unknown' }),
    'openai',
    'preq-auth-missing'
  );
  assert.equal(await responseCode(missing), 'invalid_api_key');

  await insertUser('auth-disabled-key');
  await insertKey('auth-disabled-key', 'sk-ap-disabled', 'disabled');
  const disabled = await modules.auth.authenticateGatewayRequest(
    new Headers({ authorization: 'Bearer sk-ap-disabled' }),
    'openai',
    'preq-auth-disabled-key'
  );
  assert.equal(await responseCode(disabled), 'invalid_api_key');
});

test('鉴权链 403 account_disabled：绑定被禁用', async () => {
  await insertUser('auth-disabled-account');
  await insertKey('auth-disabled-account', 'sk-ap-disabled-account');
  await modules.db().insert(modules.schema.newApiUserBinding).values({
    id: 'binding-auth-disabled',
    portalUserId: 'auth-disabled-account',
    newapiUserId: 'newapi-auth-disabled',
    status: 'disabled',
  });

  const result = await modules.auth.authenticateGatewayRequest(
    new Headers({ authorization: 'Bearer sk-ap-disabled-account' }),
    'openai',
    'preq-auth-disabled-account'
  );
  assert.equal(await responseCode(result), 'account_disabled');
});

test('鉴权链 403 account_frozen：钱包冻结', async () => {
  await insertUser('auth-frozen');
  await insertKey('auth-frozen', 'sk-ap-frozen');
  await modules
    .db()
    .update(modules.schema.walletAccount)
    .set({ frozenAt: new Date(), freezeReason: 'risk' })
    .where(eq(modules.schema.walletAccount.userId, 'auth-frozen'));

  const result = await modules.auth.authenticateGatewayRequest(
    new Headers({ authorization: 'Bearer sk-ap-frozen' }),
    'openai',
    'preq-auth-frozen'
  );
  assert.equal(await responseCode(result), 'account_frozen');
});

test('鉴权链 429 insufficient_quota：余额为零', async () => {
  await insertUser('auth-zero', 0);
  await insertKey('auth-zero', 'sk-ap-zero');

  const result = await modules.auth.authenticateGatewayRequest(
    new Headers({ 'x-api-key': 'sk-ap-zero' }),
    'anthropic',
    'preq-auth-zero'
  );
  assert.equal(result.ok, false);
  assert.equal(result.response.status, 429);
  const body = await result.response.json();
  assert.equal(body.error.type, 'insufficient_quota');

  const taskQuery = await modules.auth.authenticateGatewayRequest(
    new Headers({ 'x-api-key': 'sk-ap-zero' }),
    'openai',
    'preq-auth-zero-task-query',
    { requireSpendableWallet: false }
  );
  assert.equal(taskQuery.ok, true, '余额归零后仍可查询已提交任务');
});

test('鉴权通过返回 key/wallet，并按 60 秒节流回写 last_used_at', async () => {
  await insertUser('auth-ok');
  const recent = new Date();
  await insertKey('auth-ok', 'sk-ap-ok', 'active', recent);

  const first = await modules.auth.authenticateGatewayRequest(
    new Headers({ authorization: 'Bearer sk-ap-ok' }),
    'openai',
    'preq-auth-ok-first'
  );
  assert.equal(first.ok, true);
  assert.equal(first.key.userId, 'auth-ok');
  assert.equal(first.wallet.balanceMicroUsd, 1_000_000);
  await new Promise((resolve) => setTimeout(resolve, 20));
  const [notWritten] = await modules
    .db()
    .select()
    .from(modules.schema.portalApiKey)
    .where(eq(modules.schema.portalApiKey.id, 'key-auth-ok'));
  assert.equal(notWritten.lastUsedAt.getTime(), recent.getTime());

  const old = new Date(Date.now() - 61_000);
  await modules
    .db()
    .update(modules.schema.portalApiKey)
    .set({ lastUsedAt: old })
    .where(eq(modules.schema.portalApiKey.id, 'key-auth-ok'));
  const second = await modules.auth.authenticateGatewayRequest(
    new Headers({ authorization: 'Bearer sk-ap-ok' }),
    'openai',
    'preq-auth-ok-second'
  );
  assert.equal(second.ok, true);
  await new Promise((resolve) => setTimeout(resolve, 20));
  const [written] = await modules
    .db()
    .select()
    .from(modules.schema.portalApiKey)
    .where(eq(modules.schema.portalApiKey.id, 'key-auth-ok'));
  assert.ok(written.lastUsedAt.getTime() > old.getTime());
});

test('门户 Key CRUD 纯本地、重名拒绝、删除后可重建且操作幂等', async () => {
  await insertUser('auth-local-crud');
  const remoteMustNotRun = new Proxy(
    {},
    {
      get() {
        throw new Error('门户 Key 本地 CRUD 不应访问 New API');
      },
    }
  );

  const created = await modules.portal.createPortalApiKey(
    { id: 'auth-local-crud', email: 'auth-local-crud@gateway-auth.test' },
    { name: 'local-key', groupSlug: 'gateway-auth' },
    remoteMustNotRun
  );
  assert.match(created.plainKey, /^sk-ap-[A-Za-z0-9_-]{43}$/);
  assert.equal(created.binding.keyMasked, created.binding.keyPrefix);
  assert.equal(
    created.binding.keyMasked,
    `sk-ap-…${created.plainKey.slice(-4)}`
  );
  await assert.rejects(
    modules.portal.createPortalApiKey(
      { id: 'auth-local-crud', email: 'auth-local-crud@gateway-auth.test' },
      { name: 'local-key', groupSlug: 'gateway-auth' },
      remoteMustNotRun
    ),
    /already exists/i
  );

  const disabled = await modules.portal.disablePortalApiKey(
    'auth-local-crud',
    created.binding.id,
    remoteMustNotRun
  );
  const disabledAgain = await modules.portal.disablePortalApiKey(
    'auth-local-crud',
    created.binding.id,
    remoteMustNotRun
  );
  assert.equal(disabled.status, 'disabled');
  assert.equal(disabledAgain.status, 'disabled');

  const deleted = await modules.portal.deletePortalApiKey(
    'auth-local-crud',
    created.binding.id,
    remoteMustNotRun
  );
  const deletedAgain = await modules.portal.deletePortalApiKey(
    'auth-local-crud',
    created.binding.id,
    remoteMustNotRun
  );
  assert.equal(deleted.status, 'deleted');
  assert.equal(deletedAgain.status, 'deleted');

  const recreated = await modules.portal.createPortalApiKey(
    { id: 'auth-local-crud', email: 'auth-local-crud@gateway-auth.test' },
    { name: 'local-key', groupSlug: 'gateway-auth' },
    remoteMustNotRun
  );
  assert.notEqual(recreated.binding.id, created.binding.id);
  const listed = await modules.portal.listPortalApiKeys(
    'auth-local-crud',
    remoteMustNotRun
  );
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, recreated.binding.id);
});
