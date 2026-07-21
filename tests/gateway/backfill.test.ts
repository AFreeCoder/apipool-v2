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
  await modules
    .db()
    .insert(modules.schema.user)
    .values({
      id: userId,
      name: suffix,
      email: `${suffix}@backfill.test`,
    });
  await modules.db().insert(modules.schema.walletAccount).values({
    userId,
    balanceMicroUsd: balance,
  });
  await modules
    .db()
    .insert(modules.schema.newApiUserBinding)
    .values({
      id: `backfill-binding-${suffix}`,
      portalUserId: userId,
      newapiUserId: `remote-${suffix}`,
      status: 'active',
      newapiAccessTokenEnc: modules.crypto.encryptCredential(
        `access-${suffix}`
      ),
    });
  const priceVersionId = `backfill-price-${suffix}`;
  await modules
    .db()
    .insert(modules.schema.modelPriceVersion)
    .values({
      id: priceVersionId,
      portalGroupId: 'backfill-group',
      portalModelId: `model-${suffix}`,
      version: 1,
      ratesJson: JSON.stringify({
        input: 1_000_000,
        cached_input: 500_000,
        cache_write_5m: 1_250_000,
        cache_write_1h: 2_000_000,
        output: 2_000_000,
      }),
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
  await modules
    .db()
    .insert(modules.schema.requestLedger)
    .values({
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

test('历史 pending_backfill 直接免单收束，不再查日志或扣费', async () => {
  const user = await seedUser('legacy-pending');
  const id = await seedRequest('legacy-pending', user);
  const result = await modules.backfill.runUsageWorkerOnce();
  assert.deepEqual(result, { backfilled: 0, swept: 1, exhausted: 0 });

  const ledger = await row(id);
  assert.equal(ledger.status, 'failed_unbilled');
  assert.equal(ledger.errorCode, 'legacy_pending_retired');
  assert.deepEqual(JSON.parse(ledger.billingFlagsJson), [
    'usage_missing_waived',
  ]);
  assert.equal(ledger.backfillAttempts, 0);
  const charges = await modules
    .db()
    .select()
    .from(modules.schema.walletLedger)
    .where(eq(modules.schema.walletLedger.requestLedgerId, id));
  assert.equal(charges.length, 0);
});

test('重复回填幂等：已 settled 行再跑 worker 零变化', async () => {
  const user = await seedUser('settled');
  const id = await seedRequest('settled', {
    ...user,
    status: 'settled',
    nextAt: new Date(Date.now() - 1000),
  });
  const result = await modules.backfill.runUsageWorkerOnce();
  assert.deepEqual(result, { backfilled: 0, swept: 0, exhausted: 0 });
  assert.equal((await row(id)).status, 'settled');
});

test('sweeper：超时 open 无论有无 request id 都直接免单', async () => {
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
  const result = await modules.backfill.runUsageWorkerOnce();
  assert.equal(result.swept, 2);
  assert.equal((await row(noId)).status, 'failed_unbilled');
  assert.equal((await row(noId)).errorCode, 'open_timeout');
  assert.equal((await row(withId)).status, 'failed_unbilled');
  assert.equal((await row(withId)).errorCode, 'open_timeout');
});

test('keepAlive 丢锁时立即停止本轮，不处理后续条目', async () => {
  const user = await seedUser('lost-lock');
  const first = await seedRequest('lost-lock-a', user);
  const second = await seedRequest('lost-lock-b', user);
  let keepAliveCalls = 0;
  await modules.backfill.runUsageWorkerOnce({
    keepAlive: async () => {
      keepAliveCalls += 1;
      return keepAliveCalls === 1;
    },
  });
  assert.equal((await row(first)).status, 'failed_unbilled');
  assert.equal((await row(second)).status, 'pending_backfill');
});
