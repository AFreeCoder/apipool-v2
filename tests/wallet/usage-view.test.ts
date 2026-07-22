import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { createClient } from '@libsql/client';

let modules: any;
let client: ReturnType<typeof createClient>;
const NOW = new Date();

async function setupDb() {
  const dbPath = join(process.cwd(), '.tmp', 'wallet-usage-view.db');
  await mkdir(join(process.cwd(), '.tmp'), { recursive: true });
  await rm(dbPath, { force: true });
  process.env.DATABASE_PROVIDER = 'sqlite';
  process.env.DATABASE_URL = `file:${dbPath}`;
  process.env.DB_SCHEMA_FILE = './src/config/db/schema.sqlite.ts';
  process.env.DB_SINGLETON_ENABLED = 'false';

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
  const usageView = await import('@/features/wallet/server/usage-view');
  modules = { db, schema, usageView };

  await db().insert(schema.user).values({
    id: 'usage-view-user',
    name: 'Usage View User',
    email: 'usage-view@test.local',
  });
  await db().insert(schema.catalogGroup).values({
    id: 'usage-group',
    slug: 'usage-group',
    name: 'Usage Group',
    newapiGroup: 'official',
  });
  await db().insert(schema.portalApiKey).values({
    id: 'usage-key',
    userId: 'usage-view-user',
    groupId: 'usage-group',
    keyHash: 'usage-key-hash',
    keyPrefix: 'sk-ap-…test',
    name: 'Usage Key',
  });
  await db()
    .insert(schema.walletAccount)
    .values({
      userId: 'usage-view-user',
      balanceMicroUsd: 2_500_000,
      frozenAt: new Date(NOW.getTime() - 1_000),
      freezeReason: 'manual',
    });
  await db()
    .insert(schema.walletLedger)
    .values([
      {
        id: 'wallet-entry-old',
        userId: 'usage-view-user',
        entryType: 'recharge',
        signedAmountMicroUsd: 3_500_000,
        balanceAfterMicroUsd: 3_500_000,
        orderNo: 'order-usage-view',
        createdAt: new Date(NOW.getTime() - 2 * 60 * 60 * 1_000),
      },
      {
        id: 'wallet-entry-new',
        userId: 'usage-view-user',
        entryType: 'request_charge',
        signedAmountMicroUsd: -1_000_000,
        balanceAfterMicroUsd: 2_500_000,
        requestLedgerId: 'usage-settled-a',
        reason: 'usage',
        createdAt: new Date(NOW.getTime() - 60 * 60 * 1_000),
      },
    ]);
  await db()
    .insert(schema.requestLedger)
    .values([
      requestRow({
        id: 'usage-settled-a',
        modelId: 'model-a',
        status: 'settled',
        chargedMicroUsd: 1_000_000,
        uncachedInputTokens: 100,
        cachedReadTokens: 20,
        cacheWriteTokens: 3,
        cacheWrite5mTokens: 5,
        imageInputTokens: 7,
        cachedImageInputTokens: 2,
        outputTokens: 30,
        imageOutputTokens: 11,
        createdAt: new Date(NOW.getTime() - 24 * 60 * 60 * 1_000),
      }),
      requestRow({
        id: 'usage-pending-a',
        modelId: 'model-a',
        status: 'pending_backfill',
        createdAt: new Date(NOW.getTime() - 12 * 60 * 60 * 1_000),
      }),
      requestRow({
        id: 'usage-failed-b',
        modelId: 'model-b',
        status: 'failed_unbilled',
        uncachedInputTokens: 50,
        outputTokens: 10,
        createdAt: new Date(NOW.getTime() - 6 * 60 * 60 * 1_000),
      }),
      requestRow({
        id: 'usage-old-b',
        modelId: 'model-b',
        status: 'settled',
        chargedMicroUsd: 2_000_000,
        uncachedInputTokens: 200,
        outputTokens: 40,
        createdAt: new Date(NOW.getTime() - 8 * 24 * 60 * 60 * 1_000),
      }),
    ]);
}

function requestRow(input: {
  id: string;
  modelId: string;
  status: string;
  chargedMicroUsd?: number;
  uncachedInputTokens?: number;
  cachedReadTokens?: number;
  cacheWriteTokens?: number;
  cacheWrite5mTokens?: number;
  imageInputTokens?: number;
  cachedImageInputTokens?: number;
  outputTokens?: number;
  imageOutputTokens?: number;
  createdAt: Date;
}) {
  return {
    id: input.id,
    newapiRequestId: input.status === 'settled' ? `newapi-${input.id}` : null,
    userId: 'usage-view-user',
    portalKeyId: 'usage-key',
    portalGroupId: 'usage-group',
    portalModelId: input.modelId,
    newapiGroup: 'official',
    newapiModelId: input.modelId,
    credentialId: 'usage-credential',
    routeVersion: 1,
    priceVersionId: 'usage-price',
    endpoint: 'chat_completions',
    status: input.status,
    chargedMicroUsd: input.chargedMicroUsd,
    uncachedInputTokens: input.uncachedInputTokens,
    cachedReadTokens: input.cachedReadTokens,
    cacheWriteTokens: input.cacheWriteTokens,
    cacheWrite5mTokens: input.cacheWrite5mTokens,
    imageInputTokens: input.imageInputTokens,
    cachedImageInputTokens: input.cachedImageInputTokens,
    outputTokens: input.outputTokens,
    imageOutputTokens: input.imageOutputTokens,
    createdAt: input.createdAt,
  };
}

test.before(setupDb);
test.after(() => client.close());

test('usage 聚合：spend 只含 settled，请求数含全部状态并按模型分组', async () => {
  const view = await modules.usageView.getWalletUsageView(
    'usage-view-user',
    '7d'
  );
  assert.equal(view.summary.balanceUsd, 2.5);
  assert.equal(view.summary.requestCount, 3);
  assert.equal(view.summary.inputTokens, 187);
  assert.equal(view.summary.outputTokens, 51);
  assert.equal(view.summary.spendUsd, 1);
  assert.deepEqual(view.summary.byModel, [
    { modelId: 'model-a', requestCount: 2, tokenCount: 178, spendUsd: 1 },
    { modelId: 'model-b', requestCount: 1, tokenCount: 60, spendUsd: 0 },
  ]);
});

test('logs 状态映射：open/pending 为 billing，失败免单，settled 带金额', async () => {
  const view = await modules.usageView.getWalletUsageView(
    'usage-view-user',
    '7d'
  );
  const byId = new Map<string, any>(view.logs.map((row: any) => [row.id, row]));
  assert.equal(byId.get('usage-pending-a').status, 'billing');
  assert.equal(byId.get('usage-failed-b').status, 'failed_unbilled');
  assert.equal(byId.get('usage-settled-a').status, 'settled');
  assert.equal(byId.get('usage-settled-a').chargedUsd, 1);
  assert.equal(byId.get('usage-settled-a').keyMasked, 'sk-ap-…test');
  assert.equal(byId.get('usage-settled-a').inputTokens, 137);
  assert.equal(byId.get('usage-settled-a').outputTokens, 41);
  assert.equal(byId.get('usage-pending-a').chargedUsd, null);
});

test('billing 视图：余额换算、流水倒序与冻结标记', async () => {
  const view = await modules.usageView.getWalletBillingView('usage-view-user');
  assert.deepEqual(view.balance, { balanceUsd: 2.5, frozen: true });
  assert.deepEqual(
    view.ledger.map((row: any) => row.id),
    ['wallet-entry-new', 'wallet-entry-old']
  );
  assert.equal(view.ledger[0].signedAmountUsd, -1);
  assert.equal(view.ledger[0].balanceAfterUsd, 2.5);
});

test('range 过滤：7d 排除窗口外请求，30d 包含', async () => {
  const seven = await modules.usageView.getWalletUsageView(
    'usage-view-user',
    '7d'
  );
  const thirty = await modules.usageView.getWalletUsageView(
    'usage-view-user',
    '30d'
  );
  assert.equal(
    seven.logs.some((row: any) => row.id === 'usage-old-b'),
    false
  );
  assert.equal(
    thirty.logs.some((row: any) => row.id === 'usage-old-b'),
    true
  );
  assert.equal(thirty.summary.spendUsd, 3);
});

test('all 范围包含完整请求账单历史', async () => {
  const all = await modules.usageView.getWalletUsageView(
    'usage-view-user',
    'all'
  );
  assert.equal(all.logs.length, 4);
  assert.equal(all.summary.spendUsd, 3);
});
