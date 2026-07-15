import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import type { UsageBuckets } from '@/features/gateway/lib/billing';
import { createClient } from '@libsql/client';
import { eq } from 'drizzle-orm';

let modules: any;

const NORMAL_USAGE: UsageBuckets = {
  uncachedInput: 1000,
  cachedRead: 0,
  cacheWrite5m: 0,
  cacheWrite1h: 0,
  output: 0,
  reasoning: 0,
};

async function setupDb() {
  const dbPath = join(process.cwd(), '.tmp', 'gateway-settlement.db');
  await mkdir(join(process.cwd(), '.tmp'), { recursive: true });
  await rm(dbPath, { force: true });
  process.env.DATABASE_PROVIDER = 'sqlite';
  process.env.DATABASE_URL = `file:${dbPath}`;
  process.env.DB_SCHEMA_FILE = './src/config/db/schema.sqlite.ts';
  process.env.DB_SINGLETON_ENABLED = 'false';
  process.env.APIPOOL_CREDENTIALS_SECRET = 'gateway-settlement-test-secret';
  process.env.GATEWAY_OVERDRAFT_FREEZE_MICRO_USD = '10000000';

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

  const schema = await import('@/config/db/schema');
  const { db } = await import('@/core/db');
  const settlement = await import('@/features/gateway/server/settlement');
  const wallet = await import('@/features/wallet/server/ledger');
  modules = { db, schema, settlement, wallet };
  await db().insert(schema.catalogGroup).values({
    id: 'settlement-group',
    slug: 'settlement-group',
    name: 'Settlement Group',
    userDescription: 'Settlement tests',
    newapiGroup: 'official',
  });
}

async function seedPrice(id: string, inputMicroUsdPerM = 2_500_000) {
  await modules.db().insert(modules.schema.modelPriceVersion).values({
    id,
    portalGroupId: 'settlement-group',
    portalModelId: id,
    version: 1,
    status: 'active',
    inputMicroUsdPerM,
    cachedInputMicroUsdPerM: 0,
    cacheWrite5mMicroUsdPerM: 0,
    cacheWrite1hMicroUsdPerM: 0,
    outputMicroUsdPerM: 0,
    publishedBy: 'operator',
  });
}

async function seedUser(userId: string, openingBalance = 0) {
  await modules
    .db()
    .insert(modules.schema.user)
    .values({
      id: userId,
      name: userId,
      email: `${userId}@settlement.test`,
    });
  await modules.wallet.ensureWalletAccount(userId);
  if (openingBalance > 0) {
    await modules.db().transaction((tx: any) =>
      modules.wallet.appendLedgerEntryInTx(tx, {
        userId,
        entryType: 'recharge',
        signedAmountMicroUsd: openingBalance,
        orderNo: `opening-${userId}`,
      })
    );
  }
}

async function seedRequest(input: {
  id: string;
  userId: string;
  priceVersionId: string;
  requestId?: string | null;
  status?: string;
}) {
  await modules
    .db()
    .insert(modules.schema.requestLedger)
    .values({
      id: input.id,
      newapiRequestId: input.requestId ?? null,
      userId: input.userId,
      portalKeyId: 'key',
      portalGroupId: 'settlement-group',
      portalModelId: input.priceVersionId,
      newapiGroup: 'official',
      newapiModelId: input.priceVersionId,
      credentialId: 'credential',
      routeVersion: 1,
      priceVersionId: input.priceVersionId,
      endpoint: 'chat_completions',
      isStream: false,
      status: input.status ?? 'open',
    });
}

async function settle(ledgerId: string, buckets = NORMAL_USAGE) {
  return modules.settlement.settleByLedgerId(ledgerId, {
    buckets,
    usageSource: 'response',
  });
}

test.before(setupDb);

test('正常结算：终态、桶、金额、扣费流水与物化余额原子落库', async () => {
  await seedPrice('price-normal');
  await seedUser('settle-normal', 5000);
  await seedRequest({
    id: 'preq-settle-normal',
    userId: 'settle-normal',
    priceVersionId: 'price-normal',
    requestId: 'rid-settle-normal',
  });
  assert.equal(await settle('preq-settle-normal'), 'settled');
  const [request] = await modules
    .db()
    .select()
    .from(modules.schema.requestLedger)
    .where(eq(modules.schema.requestLedger.id, 'preq-settle-normal'));
  assert.equal(request.status, 'settled');
  assert.equal(request.uncachedInputTokens, 1000);
  assert.equal(request.chargedMicroUsd, 2500);
  assert.ok(request.settledAt instanceof Date);
  const charges = await modules
    .db()
    .select()
    .from(modules.schema.walletLedger)
    .where(
      eq(modules.schema.walletLedger.requestLedgerId, 'preq-settle-normal')
    );
  assert.equal(charges.length, 1);
  assert.equal(charges[0].entryType, 'request_charge');
  assert.equal(charges[0].signedAmountMicroUsd, -2500);
  assert.equal(charges[0].balanceAfterMicroUsd, 2500);
  assert.equal(
    (await modules.wallet.getWalletAccount('settle-normal')).balanceMicroUsd,
    2500
  );
});

test('结算幂等：同 ledger 二次 settle 不重复写流水', async () => {
  assert.equal(await settle('preq-settle-normal'), 'already_finalized');
  const charges = await modules
    .db()
    .select()
    .from(modules.schema.walletLedger)
    .where(
      eq(modules.schema.walletLedger.requestLedgerId, 'preq-settle-normal')
    );
  assert.equal(charges.length, 1);
});

test('双路径幂等：ledger id 后按远端 request id 仍 already_finalized', async () => {
  assert.equal(
    await modules.settlement.settleByNewapiRequestId('rid-settle-normal', {
      buckets: NORMAL_USAGE,
      usageSource: 'log_backfill',
    }),
    'already_finalized'
  );
});

test('无 request id 结算被服务层前置拒绝', async () => {
  await seedPrice('price-no-request-id');
  await seedUser('settle-no-request-id');
  await seedRequest({
    id: 'preq-no-request-id',
    userId: 'settle-no-request-id',
    priceVersionId: 'price-no-request-id',
  });
  await assert.rejects(settle('preq-no-request-id'), /requires captured/);
});

test('负余额允许：余额 1 结算 2500 后为 -2499 且不冻结', async () => {
  await seedPrice('price-negative');
  await seedUser('settle-negative', 1);
  await seedRequest({
    id: 'preq-negative',
    userId: 'settle-negative',
    priceVersionId: 'price-negative',
    requestId: 'rid-negative',
  });
  assert.equal(await settle('preq-negative'), 'settled');
  const account = await modules.wallet.getWalletAccount('settle-negative');
  assert.equal(account.balanceMicroUsd, -2499);
  assert.equal(account.frozenAt, null);
});

test('越阈自动冻结：扣费后低于 -$10', async () => {
  await seedPrice('price-freeze', 10_000_001);
  await seedUser('settle-freeze');
  await seedRequest({
    id: 'preq-freeze',
    userId: 'settle-freeze',
    priceVersionId: 'price-freeze',
    requestId: 'rid-freeze',
  });
  const millionTokens = { ...NORMAL_USAGE, uncachedInput: 1_000_000 };
  assert.equal(await settle('preq-freeze', millionTokens), 'settled');
  const account = await modules.wallet.getWalletAccount('settle-freeze');
  assert.equal(account.balanceMicroUsd, -10_000_001);
  assert.ok(account.frozenAt instanceof Date);
  assert.equal(account.freezeReason, 'overdraft_auto');
  assert.equal(account.frozenBy, 'system');
});

test('failed_unbilled 终态不可结算', async () => {
  await seedPrice('price-failed');
  await seedUser('settle-failed');
  await seedRequest({
    id: 'preq-failed',
    userId: 'settle-failed',
    priceVersionId: 'price-failed',
    requestId: 'rid-failed',
    status: 'failed_unbilled',
  });
  assert.equal(await settle('preq-failed'), 'already_finalized');
});

test('余额闭合：每个 wallet_account.balance == 对应流水 signed_amount 之和', async () => {
  const accounts = await modules
    .db()
    .select()
    .from(modules.schema.walletAccount);
  const ledgers = await modules.db().select().from(modules.schema.walletLedger);
  for (const account of accounts) {
    const sum = ledgers
      .filter((row: any) => row.userId === account.userId)
      .reduce((total: number, row: any) => total + row.signedAmountMicroUsd, 0);
    assert.equal(account.balanceMicroUsd, sum, account.userId);
  }
});
