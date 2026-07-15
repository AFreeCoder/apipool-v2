import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { createClient } from '@libsql/client';
import { eq } from 'drizzle-orm';

let modules: any;
let client: ReturnType<typeof createClient>;

async function setupDb() {
  const dbPath = join(process.cwd(), '.tmp', 'gateway-backfill.db');
  await mkdir(join(process.cwd(), '.tmp'), { recursive: true });
  await rm(dbPath, { force: true });
  process.env.DATABASE_PROVIDER = 'sqlite';
  process.env.DATABASE_URL = `file:${dbPath}`;
  process.env.DB_SCHEMA_FILE = './src/config/db/schema.sqlite.ts';
  process.env.DB_SINGLETON_ENABLED = 'false';
  process.env.APIPOOL_CREDENTIALS_SECRET = 'gateway-backfill-test-secret';
  process.env.GATEWAY_HARD_TIMEOUT_MS = '1000';

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
  const crypto = await import('@/features/newapi-bridge/server/crypto');
  const backfill = await import('@/features/gateway/server/backfill');
  modules = { backfill, crypto, db, schema };

  await db().insert(schema.catalogGroup).values({
    id: 'backfill-group',
    slug: 'backfill-group',
    name: 'Backfill Group',
    newapiGroup: 'official',
  });
}

async function seedUser(suffix: string, balance = 1_000_000) {
  const userId = `backfill-user-${suffix}`;
  await modules.db().insert(modules.schema.user).values({
    id: userId,
    name: suffix,
    email: `${suffix}@backfill.test`,
  });
  await modules.db().insert(modules.schema.walletAccount).values({
    userId,
    balanceMicroUsd: balance,
  });
  await modules.db().insert(modules.schema.newApiUserBinding).values({
    id: `backfill-binding-${suffix}`,
    portalUserId: userId,
    newapiUserId: `remote-${suffix}`,
    status: 'active',
    newapiAccessTokenEnc: modules.crypto.encryptCredential(`access-${suffix}`),
  });
  const priceVersionId = `backfill-price-${suffix}`;
  await modules.db().insert(modules.schema.modelPriceVersion).values({
    id: priceVersionId,
    portalGroupId: 'backfill-group',
    portalModelId: `model-${suffix}`,
    version: 1,
    inputMicroUsdPerM: 1_000_000,
    cachedInputMicroUsdPerM: 500_000,
    cacheWrite5mMicroUsdPerM: 1_250_000,
    cacheWrite1hMicroUsdPerM: 2_000_000,
    outputMicroUsdPerM: 2_000_000,
    publishedBy: 'backfill-test',
  });
  return { priceVersionId, userId };
}

async function seedRequest(
  suffix: string,
  input: {
    userId: string;
    priceVersionId: string;
    status?: string;
    requestId?: string | null;
    attempts?: number;
    nextAt?: Date | null;
    createdAt?: Date;
  }
) {
  const id = `preq-backfill-${suffix}`;
  await modules.db().insert(modules.schema.requestLedger).values({
    id,
    newapiRequestId:
      input.requestId === undefined ? `rid-${suffix}` : input.requestId,
    userId: input.userId,
    portalKeyId: 'key',
    portalGroupId: 'backfill-group',
    portalModelId: `model-${suffix}`,
    newapiGroup: 'official',
    newapiModelId: `model-${suffix}`,
    credentialId: 'credential',
    routeVersion: 1,
    priceVersionId: input.priceVersionId,
    endpoint: 'chat_completions',
    isStream: false,
    status: input.status ?? 'pending_backfill',
    chargedMicroUsd: input.status === 'settled' ? 1 : undefined,
    backfillAttempts: input.attempts ?? 0,
    nextBackfillAt:
      input.nextAt === undefined ? new Date(Date.now() - 1000) : input.nextAt,
    createdAt: input.createdAt,
  });
  return id;
}

async function row(id: string) {
  const [value] = await modules
    .db()
    .select()
    .from(modules.schema.requestLedger)
    .where(eq(modules.schema.requestLedger.id, id));
  return value;
}

test.before(setupDb);
test.after(() => client.close());

test('定点回填命中：日志字段落库、log_backfill 结算并扣费', async () => {
  const user = await seedUser('hit');
  const id = await seedRequest('hit', {
    ...user,
    requestId: 'rid-hit',
  });
  const result = await modules.backfill.runUsageWorkerOnce({
    client: {
      getUsageLogByRequestId: async () => ({
        requestId: 'rid-hit',
        keyMasked: 'rk_hit',
        modelId: 'model-hit',
        inputTokens: 10,
        outputTokens: 4,
        cacheTokens: 2,
        cacheCreationTokens5m: 3,
        spendUsd: 2,
      }),
    },
  });
  assert.deepEqual(result, { backfilled: 1, swept: 0, exhausted: 0 });
  const ledger = await row(id);
  assert.equal(ledger.status, 'settled');
  assert.equal(ledger.usageSource, 'log_backfill');
  assert.equal(ledger.newapiQuota, 1_000_000);
  assert.equal(ledger.newapiPromptTokens, 10);
  assert.equal(ledger.newapiCompletionTokens, 4);
  assert.equal(ledger.newapiTokenName, 'rk_hit');
  const charges = await modules
    .db()
    .select()
    .from(modules.schema.walletLedger)
    .where(eq(modules.schema.walletLedger.requestLedgerId, id));
  assert.equal(charges.length, 1);
});

test('日志显式 quota=0 → failed_unbilled 且不扣费', async () => {
  const user = await seedUser('zero');
  const id = await seedRequest('zero', { ...user, requestId: 'rid-zero' });
  const result = await modules.backfill.runUsageWorkerOnce({
    client: {
      getUsageLogByRequestId: async () => ({
        requestId: 'rid-zero',
        keyMasked: 'rk_zero',
        inputTokens: 0,
        outputTokens: 0,
        spendUsd: 0,
      }),
    },
  });
  assert.equal(result.backfilled, 0);
  const ledger = await row(id);
  assert.equal(ledger.status, 'failed_unbilled');
  assert.equal(ledger.errorCode, 'backfill_zero_quota');
  assert.equal(ledger.newapiQuota, 0);
});

test('未命中按退避推进，第 6 次后 next=null 且仍占风险槽', async () => {
  const user = await seedUser('miss');
  const id = await seedRequest('miss', { ...user, requestId: 'rid-miss' });
  for (let attempt = 1; attempt <= 6; attempt += 1) {
    const before = Date.now();
    const result = await modules.backfill.runUsageWorkerOnce({
      client: { getUsageLogByRequestId: async () => null },
    });
    const ledger = await row(id);
    assert.equal(ledger.backfillAttempts, attempt);
    if (attempt < 6) {
      assert.ok(ledger.nextBackfillAt instanceof Date);
      assert.ok(ledger.nextBackfillAt.getTime() >= before);
      await modules
        .db()
        .update(modules.schema.requestLedger)
        .set({ nextBackfillAt: new Date(Date.now() - 1) })
        .where(eq(modules.schema.requestLedger.id, id));
    } else {
      assert.equal(ledger.nextBackfillAt, null);
      assert.equal(result.exhausted, 1);
    }
    assert.equal(ledger.status, 'pending_backfill');
  }
});

test('重复回填幂等：已 settled 行再跑 worker 零变化', async () => {
  const user = await seedUser('settled');
  const id = await seedRequest('settled', {
    ...user,
    status: 'settled',
    nextAt: new Date(Date.now() - 1000),
  });
  let calls = 0;
  const result = await modules.backfill.runUsageWorkerOnce({
    client: {
      getUsageLogByRequestId: async () => {
        calls += 1;
        return null;
      },
    },
  });
  assert.deepEqual(result, { backfilled: 0, swept: 0, exhausted: 0 });
  assert.equal(calls, 0);
  assert.equal((await row(id)).status, 'settled');
});

test('sweeper：无 id 超时 open 免单，有 id 超时 open 转 pending_backfill', async () => {
  const user = await seedUser('sweeper');
  const stale = new Date(Date.now() - 11 * 60_000);
  const noId = await seedRequest('sweep-no-id', {
    ...user,
    status: 'open',
    requestId: null,
    nextAt: null,
    createdAt: stale,
  });
  const withId = await seedRequest('sweep-with-id', {
    ...user,
    status: 'open',
    requestId: 'rid-sweep-with-id',
    nextAt: null,
    createdAt: stale,
  });
  const result = await modules.backfill.runUsageWorkerOnce({
    client: { getUsageLogByRequestId: async () => null },
  });
  assert.equal(result.swept, 2);
  assert.equal((await row(noId)).status, 'failed_unbilled');
  const pending = await row(withId);
  assert.equal(pending.status, 'pending_backfill');
  assert.ok(pending.nextBackfillAt instanceof Date);
});

test('keepAlive 丢锁时立即停止本轮，不处理后续条目', async () => {
  const user = await seedUser('lost-lock');
  const first = await seedRequest('lost-lock-a', user);
  const second = await seedRequest('lost-lock-b', user);
  let keepAliveCalls = 0;
  let logCalls = 0;
  await modules.backfill.runUsageWorkerOnce({
    client: {
      getUsageLogByRequestId: async () => {
        logCalls += 1;
        return null;
      },
    },
    keepAlive: async () => {
      keepAliveCalls += 1;
      return keepAliveCalls === 1;
    },
  });
  assert.equal(logCalls, 1);
  assert.equal((await row(first)).backfillAttempts, 1);
  assert.equal((await row(second)).backfillAttempts, 0);
});
