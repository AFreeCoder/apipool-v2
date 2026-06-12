import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { createClient } from '@libsql/client';
import { eq } from 'drizzle-orm';

let modules: any;

async function setupDb() {
  const dbPath = join(process.cwd(), '.tmp', 'recharge.db');
  await mkdir(join(process.cwd(), '.tmp'), { recursive: true });
  await rm(dbPath, { force: true });

  process.env.DATABASE_PROVIDER = 'sqlite';
  process.env.DATABASE_URL = `file:${dbPath}`;
  process.env.DB_SCHEMA_FILE = './src/config/db/schema.sqlite.ts';
  process.env.DB_SINGLETON_ENABLED = 'false';
  process.env.APIPOOL_CREDENTIALS_SECRET = 'recharge-test-secret';
  // 桥接保持未配置：handleCheckoutSuccess 的默认 client 应失败为 pending，
  // 不阻塞 webhook；真实加额由测试注入的 fake client 验证
  process.env.NEWAPI_INTEGRATION_ENABLED = 'false';

  const client = createClient({ url: `file:${dbPath}` });
  const migrationsDir = join(process.cwd(), 'src/config/db/migrations_sqlite');
  for (const file of (await readdir(migrationsDir))
    .filter((name) => name.endsWith('.sql'))
    .sort()) {
    await client.executeMultiple(await readFile(join(migrationsDir, file), 'utf8'));
  }

  const schema = await import('@/config/db/schema');
  const { db } = await import('@/core/db');
  const recharge = await import('@/features/newapi-bridge/server/recharge');
  const payment = await import('@/shared/services/payment');
  const orderModel = await import('@/shared/models/order');
  const { NewApiBridgeError } = await import(
    '@/features/newapi-bridge/server/client'
  );

  modules = {
    db,
    schema,
    recharge,
    payment,
    orderModel,
    NewApiBridgeError,
  };
}

async function insertUser(id: string, email: string) {
  await modules.db().insert(modules.schema.user).values({ id, name: id, email });
  return { id, name: id, email };
}

function createWorkingRemoteClient() {
  let adjustCalls = 0;
  const client = {
    provisionUser: async (input: { username: string }) => ({
      newapiUserId: `remote_${input.username}`,
      accessToken: 'test-access-token',
    }),
    adjustQuota: async (input: { reference: string }) => {
      adjustCalls += 1;
      return { changeId: `code-${input.reference}`, balanceUsd: 5 };
    },
  } as any;
  return { client, getAdjustCalls: () => adjustCalls };
}

async function listLedgerByOrderNo(orderNo: string) {
  return modules
    .db()
    .select()
    .from(modules.schema.apipoolLedgerEntry)
    .where(eq(modules.schema.apipoolLedgerEntry.orderNo, orderNo));
}

test.before(setupDb);

test('recharge applies once and is idempotent on replay', async () => {
  const user = await insertUser('recharge_user_1', 'recharge1@example.com');
  const { client, getAdjustCalls } = createWorkingRemoteClient();
  const input = {
    orderNo: 'order_recharge_1',
    userId: user.id,
    userEmail: user.email,
    amount: 500,
    currency: 'USD',
  };

  const first = await modules.recharge.applyRechargeForOrder(input, client);
  assert.equal(first.outcome, 'applied');

  const rows = await listLedgerByOrderNo(input.orderNo);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'applied');
  assert.equal(rows[0].source, 'recharge');
  assert.equal(rows[0].amountUsd, 5);
  assert.match(rows[0].newapiChangeId, /^code-recharge:order_recharge_1$/);
  assert.match(rows[0].newapiUserId, /^remote_pu_/);

  // 重放 3 次只加额 1 次
  for (let i = 0; i < 3; i += 1) {
    const replay = await modules.recharge.applyRechargeForOrder(input, client);
    assert.equal(replay.outcome, 'already_applied');
  }
  assert.equal(getAdjustCalls(), 1);
  assert.equal((await listLedgerByOrderNo(input.orderNo)).length, 1);
});

test('recharge survives a New API outage and retries without double-charging', async () => {
  const user = await insertUser('recharge_user_2', 'recharge2@example.com');
  const input = {
    orderNo: 'order_recharge_2',
    userId: user.id,
    userEmail: user.email,
    amount: 1000,
    currency: 'usd',
  };

  const downClient = {
    provisionUser: async () => {
      throw new modules.NewApiBridgeError({
        code: 'timeout',
        message: 'New API is down',
      });
    },
  } as any;

  const failed = await modules.recharge.applyRechargeForOrder(input, downClient);
  assert.equal(failed.outcome, 'pending_retry');

  let rows = await listLedgerByOrderNo(input.orderNo);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'pending');

  // 恢复后重试：金额不重不漏
  const { client, getAdjustCalls } = createWorkingRemoteClient();
  const retried = await modules.recharge.applyRechargeForOrder(input, client);
  assert.equal(retried.outcome, 'applied');
  assert.equal(getAdjustCalls(), 1);

  rows = await listLedgerByOrderNo(input.orderNo);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'applied');
  assert.equal(rows[0].amountUsd, 10);
});

test('terminal bridge errors mark the ledger failed for operator follow-up', async () => {
  const user = await insertUser('recharge_user_3', 'recharge3@example.com');
  const forbiddenClient = {
    provisionUser: async () => {
      throw new modules.NewApiBridgeError({
        code: 'forbidden',
        message: 'admin token rejected',
      });
    },
  } as any;

  const result = await modules.recharge.applyRechargeForOrder(
    {
      orderNo: 'order_recharge_3',
      userId: user.id,
      userEmail: user.email,
      amount: 500,
      currency: 'USD',
    },
    forbiddenClient
  );

  assert.equal(result.outcome, 'failed');
  const rows = await listLedgerByOrderNo('order_recharge_3');
  assert.equal(rows[0].status, 'failed');
});

test('non-usd or zero-amount orders are skipped without ledger rows', async () => {
  const user = await insertUser('recharge_user_4', 'recharge4@example.com');
  const { client } = createWorkingRemoteClient();

  const eur = await modules.recharge.applyRechargeForOrder(
    {
      orderNo: 'order_recharge_eur',
      userId: user.id,
      userEmail: user.email,
      amount: 500,
      currency: 'EUR',
    },
    client
  );
  assert.equal(eur.outcome, 'skipped');

  const zero = await modules.recharge.applyRechargeForOrder(
    {
      orderNo: 'order_recharge_zero',
      userId: user.id,
      userEmail: user.email,
      amount: 0,
      currency: 'USD',
    },
    client
  );
  assert.equal(zero.outcome, 'skipped');

  assert.equal((await listLedgerByOrderNo('order_recharge_eur')).length, 0);
  assert.equal((await listLedgerByOrderNo('order_recharge_zero')).length, 0);
});

test('handleCheckoutSuccess grants credit once and leaves recharge retriable when bridge is down', async () => {
  const user = await insertUser('recharge_user_5', 'recharge5@example.com');
  const orderNo = 'order_checkout_e2e';

  await modules.orderModel.createOrder({
    id: 'order_row_e2e',
    orderNo,
    userId: user.id,
    userEmail: user.email,
    status: 'created',
    amount: 500,
    currency: 'USD',
    productId: 'topup_5',
    paymentType: 'one-time',
    paymentInterval: 'one-time',
    paymentProvider: 'stripe',
    checkoutInfo: '',
    createdAt: new Date(),
    productName: 'APIPool Credit $5',
    description: 'recharge order',
    callbackUrl: '',
    creditsAmount: 500,
    creditsValidDays: 0,
    planName: '',
    paymentProductId: '',
  });

  const session = {
    paymentStatus: 'paid',
    paymentResult: { id: 'evt_1' },
    paymentInfo: {
      paymentAmount: 500,
      paymentCurrency: 'USD',
      paidAt: new Date(),
    },
  } as any;

  // webhook 重放 3 次：credit 只入账一次，ledger 只有一行（桥接未配置 → pending）
  for (let i = 0; i < 3; i += 1) {
    const order = await modules.orderModel.findOrderByOrderNo(orderNo);
    await modules.payment.handleCheckoutSuccess({ order, session });
  }

  const [orderRow] = await modules
    .db()
    .select()
    .from(modules.schema.order)
    .where(eq(modules.schema.order.orderNo, orderNo));
  assert.equal(orderRow.status, 'paid');

  const credits = await modules
    .db()
    .select()
    .from(modules.schema.credit)
    .where(eq(modules.schema.credit.orderNo, orderNo));
  assert.equal(credits.length, 1);
  assert.equal(credits[0].credits, 500);

  let ledger = await listLedgerByOrderNo(orderNo);
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0].status, 'pending');

  // 桥接恢复后按订单重试 → applied；再重放 webhook 不再变化
  const { client, getAdjustCalls } = createWorkingRemoteClient();
  const retried = await modules.recharge.applyRechargeForOrder(
    {
      orderNo,
      userId: user.id,
      userEmail: user.email,
      amount: 500,
      currency: 'USD',
    },
    client
  );
  assert.equal(retried.outcome, 'applied');
  assert.equal(getAdjustCalls(), 1);

  const order = await modules.orderModel.findOrderByOrderNo(orderNo);
  await modules.payment.handleCheckoutSuccess({ order, session });

  ledger = await listLedgerByOrderNo(orderNo);
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0].status, 'applied');
});
