import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { createClient } from '@libsql/client';
import { eq } from 'drizzle-orm';

let modules: any;

async function setupDb() {
  const dbPath = join(process.cwd(), '.tmp', 'wallet-recharge.db');
  await mkdir(join(process.cwd(), '.tmp'), { recursive: true });
  await rm(dbPath, { force: true });
  process.env.DATABASE_PROVIDER = 'sqlite';
  process.env.DATABASE_URL = `file:${dbPath}`;
  process.env.DB_SCHEMA_FILE = './src/config/db/schema.sqlite.ts';
  process.env.DB_SINGLETON_ENABLED = 'false';
  process.env.APIPOOL_CREDENTIALS_SECRET = 'wallet-recharge-test-secret';
  process.env.NEWAPI_INTEGRATION_ENABLED = 'false';

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
  const payment = await import('@/shared/services/payment');
  const orderModel = await import('@/shared/models/order');
  const checkout = await import('@/app/api/payment/checkout/checkout-handler');
  const config = await import('@/features/gateway/lib/config');
  modules = { checkout, config, db, orderModel, payment, schema };
}

async function insertUser(userId: string) {
  await modules
    .db()
    .insert(modules.schema.user)
    .values({
      id: userId,
      name: userId,
      email: `${userId}@wallet-recharge.test`,
    });
}

async function insertOrder(
  userId: string,
  orderNo: string,
  status = 'created'
) {
  await modules.orderModel.createOrder({
    id: `row-${orderNo}`,
    orderNo,
    userId,
    userEmail: `${userId}@wallet-recharge.test`,
    status,
    amount: 500,
    currency: 'USD',
    productId: 'topup_5',
    paymentType: 'one-time',
    paymentInterval: 'one-time',
    paymentProvider: 'stripe',
    checkoutInfo: '',
    createdAt: new Date(),
    productName: 'APIPool Credit $5',
    description: 'wallet recharge test',
    callbackUrl: '',
    creditsAmount: 500,
    creditsValidDays: 0,
    planName: '',
    paymentProductId: '',
  });
  return modules.orderModel.findOrderByOrderNo(orderNo);
}

function successSession() {
  return {
    paymentStatus: 'paid',
    paymentResult: { id: 'evt-wallet-recharge' },
    paymentInfo: {
      paymentAmount: 500,
      paymentCurrency: 'USD',
      paidAt: new Date(),
    },
  } as any;
}

async function walletRows(orderNo: string) {
  return modules
    .db()
    .select()
    .from(modules.schema.walletLedger)
    .where(eq(modules.schema.walletLedger.orderNo, orderNo));
}

async function creditRows(orderNo: string) {
  return modules
    .db()
    .select()
    .from(modules.schema.credit)
    .where(eq(modules.schema.credit.orderNo, orderNo));
}

test.before(setupDb);
test.after(() => {
  delete process.env.WALLET_LEDGER_WRITE_ENABLED;
  delete process.env.APIPOOL_CHECKOUT_ENABLED;
});

test('开关 off：走现状 credit 入账且零 wallet 流水', async () => {
  delete process.env.WALLET_LEDGER_WRITE_ENABLED;
  await insertUser('wallet-recharge-off');
  const order = await insertOrder('wallet-recharge-off', 'wallet-order-off');
  await modules.payment.handleCheckoutSuccess({
    order,
    session: successSession(),
  });
  assert.equal((await creditRows('wallet-order-off')).length, 1);
  assert.equal((await walletRows('wallet-order-off')).length, 0);
});

test('开关 on：PAID 事务写 recharge 流水并停写 credit', async () => {
  process.env.WALLET_LEDGER_WRITE_ENABLED = 'true';
  await insertUser('wallet-recharge-on');
  const order = await insertOrder('wallet-recharge-on', 'wallet-order-on');
  await modules.payment.handleCheckoutSuccess({
    order,
    session: successSession(),
  });
  assert.equal((await creditRows('wallet-order-on')).length, 0);
  const rows = await walletRows('wallet-order-on');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].entryType, 'recharge');
  assert.equal(rows[0].signedAmountMicroUsd, 5_000_000);
  assert.equal(rows[0].balanceAfterMicroUsd, 5_000_000);
});

test('wallet-only 事务路径：无 credit/subscription 仍把订单与钱包一起落库', async () => {
  await insertUser('wallet-recharge-only');
  await insertOrder('wallet-recharge-only', 'wallet-order-only');
  const result = await modules.orderModel.updateOrderInTransaction({
    orderNo: 'wallet-order-only',
    updateOrder: { status: 'paid' },
    newWalletRecharge: {
      userId: 'wallet-recharge-only',
      amountMicroUsd: 5_000_000,
    },
  });
  assert.equal(result.order.status, 'paid');
  assert.ok(result.walletLedgerId);
  assert.equal((await walletRows('wallet-order-only')).length, 1);
});

test('webhook 重放幂等：二次 handleCheckoutSuccess 仍只有一条 recharge', async () => {
  process.env.WALLET_LEDGER_WRITE_ENABLED = 'true';
  await insertUser('wallet-recharge-replay');
  const order = await insertOrder(
    'wallet-recharge-replay',
    'wallet-order-replay'
  );
  await modules.payment.handleCheckoutSuccess({
    order,
    session: successSession(),
  });
  await modules.payment.handleCheckoutSuccess({
    order,
    session: successSession(),
  });
  assert.equal((await walletRows('wallet-order-replay')).length, 1);
});

test('注册 after 钩子建 wallet_account，初始余额为 0', async () => {
  const userId = 'wallet-signup-hook';
  await insertUser(userId);
  const { getAuthOptions } = await import('@/core/auth/config');
  const options: any = await getAuthOptions({
    email_verification_enabled: 'false',
    email_auth_enabled: 'true',
  });
  await options.databaseHooks.user.create.after({
    id: userId,
    name: userId,
    email: `${userId}@wallet-recharge.test`,
  });
  const [account] = await modules
    .db()
    .select()
    .from(modules.schema.walletAccount)
    .where(eq(modules.schema.walletAccount.userId, userId));
  assert.ok(account);
  assert.equal(account.balanceMicroUsd, 0);
});

test('checkout 创建门控 fail-closed：缺失/false/非法均拒绝', async () => {
  for (const value of [undefined, 'false', 'yes']) {
    if (value === undefined) delete process.env.APIPOOL_CHECKOUT_ENABLED;
    else process.env.APIPOOL_CHECKOUT_ENABLED = value;
    const response = await modules.checkout.createTopUpCheckoutResponse({
      body: { custom_amount_usd: 10, currency: 'USD' },
      pricingItems: [],
    });
    const payload = await response.json();
    assert.equal(payload.code, -1);
    assert.match(payload.message, /temporarily disabled/i);
  }
});

test('结算不受 checkout 门控：冻结创建期仍写 wallet recharge', async () => {
  process.env.WALLET_LEDGER_WRITE_ENABLED = 'true';
  process.env.APIPOOL_CHECKOUT_ENABLED = 'false';
  assert.equal(modules.config.checkoutEnabled(), false);
  await insertUser('wallet-recharge-frozen-checkout');
  const order = await insertOrder(
    'wallet-recharge-frozen-checkout',
    'wallet-order-frozen-checkout'
  );
  await modules.payment.handleCheckoutSuccess({
    order,
    session: successSession(),
  });
  assert.equal((await walletRows('wallet-order-frozen-checkout')).length, 1);
});
