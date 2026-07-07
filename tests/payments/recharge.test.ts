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
    await client.executeMultiple(
      await readFile(join(migrationsDir, file), 'utf8')
    );
  }

  const schema = await import('@/config/db/schema');
  const { db } = await import('@/core/db');
  const recharge = await import('@/features/newapi-bridge/server/recharge');
  const crypto = await import('@/features/newapi-bridge/server/crypto');
  const payment = await import('@/shared/services/payment');
  const orderModel = await import('@/shared/models/order');
  const { NewApiBridgeError } = await import(
    '@/features/newapi-bridge/server/client'
  );

  modules = {
    db,
    rawClient: client,
    schema,
    recharge,
    crypto,
    payment,
    orderModel,
    NewApiBridgeError,
  };
}

async function insertUser(id: string, email: string) {
  await modules
    .db()
    .insert(modules.schema.user)
    .values({ id, name: id, email });
  return { id, name: id, email };
}

function createWorkingRemoteClient() {
  let adjustCalls = 0;
  const adjustInputs: Array<{ amountUsd: number; reference: string }> = [];
  const client = {
    provisionUser: async (input: { username: string }) => ({
      newapiUserId: `remote_${input.username}`,
      accessToken: 'test-access-token',
    }),
    adjustQuota: async (input: { amountUsd: number; reference: string }) => {
      adjustCalls += 1;
      adjustInputs.push(input);
      return { changeId: `code-${input.reference}`, balanceUsd: 5 };
    },
  } as any;
  return {
    client,
    getAdjustCalls: () => adjustCalls,
    getAdjustInputs: () => adjustInputs,
  };
}

function createBlockingRemoteClient() {
  let adjustCalls = 0;
  let released = false;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = () => {
      released = true;
      resolve();
    };
  });
  const client = {
    provisionUser: async (input: { username: string }) => ({
      newapiUserId: `remote_${input.username}`,
      accessToken: 'test-access-token',
    }),
    adjustQuota: async (input: { reference: string }) => {
      adjustCalls += 1;
      await gate;
      return {
        changeId: `code-${input.reference}-${adjustCalls}`,
        balanceUsd: 5,
      };
    },
  } as any;
  return {
    client,
    release,
    getAdjustCalls: () => adjustCalls,
    isReleased: () => released,
  };
}

async function insertActiveBinding(user: { id: string; email: string }) {
  await modules
    .db()
    .insert(modules.schema.newApiUserBinding)
    .values({
      id: `binding_${user.id}`,
      portalUserId: user.id,
      newapiUserId: `remote_${user.email}`,
      status: 'active',
      newapiUsername: user.email,
      targetNewapiUsername: user.email,
      newapiAccessTokenEnc:
        modules.crypto.encryptCredential('test-access-token'),
    });
}

async function insertRechargeLedger(input: {
  id: string;
  userId: string;
  orderNo: string;
  amountUsd: number;
  status?: string;
}) {
  await modules
    .db()
    .insert(modules.schema.apipoolLedgerEntry)
    .values({
      id: input.id,
      portalUserId: input.userId,
      operatorUserId: input.userId,
      newapiUserId: `remote_${input.userId}`,
      orderNo: input.orderNo,
      amountUsd: input.amountUsd,
      source: 'recharge',
      status: input.status ?? 'pending',
      executor: 'newapi',
      reason: `recharge order ${input.orderNo}`,
      rollbackStatus: 'not_required',
    });
}

async function listLedgerByOrderNo(orderNo: string) {
  return modules
    .db()
    .select()
    .from(modules.schema.apipoolLedgerEntry)
    .where(eq(modules.schema.apipoolLedgerEntry.orderNo, orderNo));
}

async function executeRaw(sql: string) {
  await modules.rawClient.execute(sql);
}

test.before(setupDb);

test('recharge applies once and is idempotent on replay', async () => {
  const user = await insertUser('recharge_user_1', 'r1@b.co');
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
  assert.equal(rows[0].newapiUserId, 'remote_r1@b.co');
  assert.equal(rows[0].newapiUserId.includes('pu_'), false);

  // 重放 3 次只加额 1 次
  for (let i = 0; i < 3; i += 1) {
    const replay = await modules.recharge.applyRechargeForOrder(input, client);
    assert.equal(replay.outcome, 'already_applied');
  }
  assert.equal(getAdjustCalls(), 1);
  assert.equal((await listLedgerByOrderNo(input.orderNo)).length, 1);
});

test('recharge remains applied when success audit logging fails after remote quota adjustment', async () => {
  const user = await insertUser('recharge_user_audit_failure', 'ra1@b.co');
  const { client, getAdjustCalls } = createWorkingRemoteClient();
  const input = {
    orderNo: 'order_recharge_audit_failure',
    userId: user.id,
    userEmail: user.email,
    amount: 500,
    currency: 'USD',
  };

  await executeRaw(`
    CREATE TRIGGER fail_recharge_apply_audit
    BEFORE INSERT ON newapi_bridge_audit_log
    WHEN NEW.action = 'newapi.recharge.apply'
    BEGIN
      SELECT RAISE(FAIL, 'simulate audit write failure');
    END;
  `);

  try {
    const result = await modules.recharge.applyRechargeForOrder(input, client);
    assert.equal(result.outcome, 'applied');
  } finally {
    await executeRaw('DROP TRIGGER IF EXISTS fail_recharge_apply_audit');
  }

  const rows = await listLedgerByOrderNo(input.orderNo);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'applied');
  assert.match(
    rows[0].newapiChangeId,
    /^code-recharge:order_recharge_audit_failure$/
  );
  assert.equal(getAdjustCalls(), 1);

  const replay = await modules.recharge.applyRechargeForOrder(input, client);
  assert.equal(replay.outcome, 'already_applied');
  assert.equal(getAdjustCalls(), 1);
});

test('recharge claims a pending ledger before remote quota adjustment', async () => {
  const user = await insertUser('recharge_user_concurrent_pending', 'rcp@b.co');
  await insertActiveBinding(user);
  await insertRechargeLedger({
    id: 'ledger_concurrent_pending',
    userId: user.id,
    orderNo: 'order_recharge_concurrent_pending',
    amountUsd: 5,
  });
  const { client, getAdjustCalls, isReleased, release } =
    createBlockingRemoteClient();
  const input = {
    orderNo: 'order_recharge_concurrent_pending',
    userId: user.id,
    userEmail: user.email,
    amount: 500,
    currency: 'USD',
  };

  const first = modules.recharge.applyRechargeForOrder(input, client);
  const second = modules.recharge.applyRechargeForOrder(input, client);

  try {
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(getAdjustCalls(), 1);
  } finally {
    if (!isReleased()) release();
  }

  const results = await Promise.all([first, second]);
  assert.equal(getAdjustCalls(), 1);
  assert.deepEqual(results.map((result: any) => result.outcome).sort(), [
    'applied',
    'pending_retry',
  ]);
});

test('recharge requires reconciliation instead of retrying after remote success and applied update failure', async () => {
  const user = await insertUser('recharge_user_apply_failure', 'raf@b.co');
  await insertActiveBinding(user);
  await insertRechargeLedger({
    id: 'ledger_apply_failure',
    userId: user.id,
    orderNo: 'order_recharge_apply_failure',
    amountUsd: 5,
  });
  const { client, getAdjustCalls } = createWorkingRemoteClient();
  const input = {
    orderNo: 'order_recharge_apply_failure',
    userId: user.id,
    userEmail: user.email,
    amount: 500,
    currency: 'USD',
  };

  await executeRaw(`
    CREATE TRIGGER fail_recharge_applied_update
    BEFORE UPDATE OF status ON apipool_ledger_entry
    WHEN NEW.status = 'applied' AND OLD.order_no = 'order_recharge_apply_failure'
    BEGIN
      SELECT RAISE(FAIL, 'simulate applied ledger update failure');
    END;
  `);

  try {
    const result = await modules.recharge.applyRechargeForOrder(input, client);
    assert.equal(result.outcome, 'failed');
  } finally {
    await executeRaw('DROP TRIGGER IF EXISTS fail_recharge_applied_update');
  }

  let rows = await listLedgerByOrderNo(input.orderNo);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'reconciliation_required');
  assert.equal(getAdjustCalls(), 1);

  const replay = await modules.recharge.applyRechargeForOrder(input, client);
  assert.equal(replay.outcome, 'failed');
  assert.equal(getAdjustCalls(), 1);

  rows = await listLedgerByOrderNo(input.orderNo);
  assert.equal(rows[0].status, 'reconciliation_required');
});

test('recharge survives a New API outage and retries without double-charging', async () => {
  const user = await insertUser('recharge_user_2', 'r2@b.co');
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

  const failed = await modules.recharge.applyRechargeForOrder(
    input,
    downClient
  );
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
  const user = await insertUser('recharge_user_3', 'r3@b.co');
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
  const user = await insertUser('recharge_user_4', 'r4@b.co');
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
  const user = await insertUser('recharge_user_5', 'r5@b.co');
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

test('custom checkout success keeps cents credits and New API dollars aligned', async () => {
  const user = await insertUser('recharge_user_custom_1000', 'rc1000@b.co');
  const orderNo = 'order_checkout_custom_1000';

  await modules.orderModel.createOrder({
    id: 'order_row_custom_1000',
    orderNo,
    userId: user.id,
    userEmail: user.email,
    status: 'created',
    amount: 100000,
    currency: 'USD',
    productId: 'topup_custom',
    paymentType: 'one-time',
    paymentInterval: 'one-time',
    paymentProvider: 'stripe',
    checkoutInfo: '',
    createdAt: new Date(),
    productName: 'APIPool Credit USD $1000',
    description: 'custom recharge order',
    callbackUrl: '',
    creditsAmount: 100000,
    creditsValidDays: 0,
    planName: '',
    paymentProductId: '',
  });

  const session = {
    paymentStatus: 'paid',
    paymentResult: { id: 'evt_custom_1000' },
    paymentInfo: {
      paymentAmount: 100000,
      paymentCurrency: 'USD',
      paidAt: new Date(),
    },
  } as any;

  const order = await modules.orderModel.findOrderByOrderNo(orderNo);
  await modules.payment.handleCheckoutSuccess({ order, session });

  const credits = await modules
    .db()
    .select()
    .from(modules.schema.credit)
    .where(eq(modules.schema.credit.orderNo, orderNo));
  assert.equal(credits.length, 1);
  assert.equal(credits[0].credits, 100000);
  assert.equal(credits[0].remainingCredits, 100000);

  let ledger = await listLedgerByOrderNo(orderNo);
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0].status, 'pending');
  assert.equal(ledger[0].amountUsd, 1000);

  const { client, getAdjustCalls, getAdjustInputs } =
    createWorkingRemoteClient();
  const retried = await modules.recharge.applyRechargeForOrder(
    {
      orderNo,
      userId: user.id,
      userEmail: user.email,
      amount: 100000,
      currency: 'USD',
    },
    client
  );

  assert.equal(retried.outcome, 'applied');
  assert.equal(getAdjustCalls(), 1);
  assert.equal(getAdjustInputs()[0].amountUsd, 1000);
  assert.equal(getAdjustInputs()[0].reference, `recharge:${orderNo}`);

  ledger = await listLedgerByOrderNo(orderNo);
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0].status, 'applied');
  assert.equal(ledger[0].amountUsd, 1000);
});

test('handleCheckoutSuccess self-heals missing recharge ledger on paid webhook replay', async () => {
  const user = await insertUser(
    'recharge_user_paid_replay_missing_ledger',
    'rpr@b.co'
  );
  const orderNo = 'order_checkout_paid_replay_missing_ledger';

  await modules.orderModel.createOrder({
    id: 'order_row_paid_replay_missing_ledger',
    orderNo,
    userId: user.id,
    userEmail: user.email,
    status: 'paid',
    amount: 500,
    currency: 'USD',
    productId: 'topup_5',
    paymentType: 'one-time',
    paymentInterval: 'one-time',
    paymentProvider: 'stripe',
    checkoutInfo: '',
    createdAt: new Date(),
    productName: 'APIPool Credit $5',
    description: 'paid replay missing ledger',
    callbackUrl: '',
    creditsAmount: 500,
    creditsValidDays: 0,
    planName: '',
    paymentProductId: '',
  });

  const paidOrder = await modules.orderModel.findOrderByOrderNo(orderNo);
  const session = {
    paymentStatus: 'paid',
    paymentResult: { id: 'evt_paid_replay_missing_ledger' },
    paymentInfo: {
      paymentAmount: 500,
      paymentCurrency: 'USD',
      paidAt: new Date(),
    },
  } as any;

  await modules.payment.handleCheckoutSuccess({ order: paidOrder, session });

  const ledger = await listLedgerByOrderNo(orderNo);
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0].status, 'pending');
  assert.equal(ledger[0].source, 'recharge');
  assert.equal(ledger[0].amountUsd, 5);
});

test('handleCheckoutSuccess does not start recharge when the paid transition is not won', async () => {
  const user = await insertUser('recharge_user_lost_transition', 'rlt@b.co');
  const orderNo = 'order_checkout_lost_transition';

  await modules.orderModel.createOrder({
    id: 'order_row_lost_transition',
    orderNo,
    userId: user.id,
    userEmail: user.email,
    status: 'paid',
    amount: 500,
    currency: 'USD',
    productId: 'topup_5',
    paymentType: 'one-time',
    paymentInterval: 'one-time',
    paymentProvider: 'stripe',
    checkoutInfo: '',
    createdAt: new Date(),
    productName: 'APIPool Credit $5',
    description: 'stale paid order',
    callbackUrl: '',
    creditsAmount: 500,
    creditsValidDays: 0,
    planName: '',
    paymentProductId: '',
  });

  const paidOrder = await modules.orderModel.findOrderByOrderNo(orderNo);
  const staleOrder = { ...paidOrder, status: 'created' };
  const session = {
    paymentStatus: 'paid',
    paymentResult: { id: 'evt_lost_transition' },
    paymentInfo: {
      paymentAmount: 500,
      paymentCurrency: 'USD',
      paidAt: new Date(),
    },
  } as any;

  await modules.payment.handleCheckoutSuccess({ order: staleOrder, session });

  const credits = await modules
    .db()
    .select()
    .from(modules.schema.credit)
    .where(eq(modules.schema.credit.orderNo, orderNo));
  assert.equal(credits.length, 0);

  const ledger = await listLedgerByOrderNo(orderNo);
  assert.equal(ledger.length, 0);
});

test('order transaction does not grant credit when paid-order optimistic lock is not won', async () => {
  const user = await insertUser('recharge_user_stale_order', 'rso@b.co');
  const orderNo = 'order_checkout_stale_paid';

  await modules.orderModel.createOrder({
    id: 'order_row_stale_paid',
    orderNo,
    userId: user.id,
    userEmail: user.email,
    status: 'paid',
    amount: 500,
    currency: 'USD',
    productId: 'topup_5',
    paymentType: 'one-time',
    paymentInterval: 'one-time',
    paymentProvider: 'stripe',
    checkoutInfo: '',
    createdAt: new Date(),
    productName: 'APIPool Credit $5',
    description: 'stale paid order',
    callbackUrl: '',
    creditsAmount: 500,
    creditsValidDays: 0,
    planName: '',
    paymentProductId: '',
  });

  const result = await modules.orderModel.updateOrderInTransaction({
    orderNo,
    updateOrder: { status: 'paid' },
    newCredit: {
      id: 'credit_should_not_be_inserted',
      userId: user.id,
      userEmail: user.email,
      orderNo,
      transactionNo: 'txn_should_not_be_inserted',
      transactionType: 'grant',
      transactionScene: 'payment',
      credits: 500,
      remainingCredits: 500,
      description: 'Grant credit',
      status: 'active',
    },
  });

  assert.equal(result.order ?? null, null);
  assert.equal(result.credit ?? null, null);

  const credits = await modules
    .db()
    .select()
    .from(modules.schema.credit)
    .where(eq(modules.schema.credit.orderNo, orderNo));
  assert.equal(credits.length, 0);
});
