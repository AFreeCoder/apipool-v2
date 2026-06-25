import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { createClient } from '@libsql/client';

let modules: any;

async function setupDb() {
  const dbPath = join(process.cwd(), '.tmp', 'billing-ledger.db');
  await mkdir(join(process.cwd(), '.tmp'), { recursive: true });
  await rm(dbPath, { force: true });

  process.env.DATABASE_PROVIDER = 'sqlite';
  process.env.DATABASE_URL = `file:${dbPath}`;
  process.env.DB_SCHEMA_FILE = './src/config/db/schema.sqlite.ts';
  process.env.DB_SINGLETON_ENABLED = 'false';
  process.env.APIPOOL_CREDENTIALS_SECRET = 'billing-ledger-test-secret';

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
  const money = await import('@/features/api-console/lib/money');

  modules = { db, money, portal, schema };
}

async function insertUser(id: string, email: string) {
  await modules.db().insert(modules.schema.user).values({
    id,
    name: id,
    email,
  });
  return { id, name: id, email };
}

async function insertOrder(input: {
  id: string;
  orderNo: string;
  userId: string;
  userEmail: string;
  status: string;
  amount: number;
  paymentProvider: string;
  paidAt?: Date | null;
}) {
  await modules
    .db()
    .insert(modules.schema.order)
    .values({
      id: input.id,
      orderNo: input.orderNo,
      userId: input.userId,
      userEmail: input.userEmail,
      status: input.status,
      amount: input.amount,
      currency: 'USD',
      paymentProvider: input.paymentProvider,
      checkoutInfo: '',
      paidAt: input.paidAt ?? null,
    });
}

async function insertLedger(input: {
  id: string;
  portalUserId: string;
  orderNo?: string | null;
  amountUsd: number;
  status: string;
  source?: string;
  createdAt?: Date;
}) {
  await modules
    .db()
    .insert(modules.schema.apipoolLedgerEntry)
    .values({
      id: input.id,
      portalUserId: input.portalUserId,
      operatorUserId: input.portalUserId,
      newapiUserId: `remote_${input.portalUserId}`,
      orderNo: input.orderNo ?? null,
      amountUsd: input.amountUsd,
      source: input.source ?? 'recharge',
      status: input.status,
      executor: 'newapi',
      reason: `ledger ${input.id}`,
      rollbackStatus: 'not_required',
      createdAt: input.createdAt,
    });
}

test.before(setupDb);

test('listBillingLedgerEntries joins order payment fields for recharge ledgers', async () => {
  assert.equal(typeof modules.portal.listBillingLedgerEntries, 'function');
  const user = await insertUser(
    'billing_join_user',
    'billing-join@example.com'
  );
  const orderNo = 'billing_order_paid';
  const paidAt = new Date('2026-06-24T10:20:30.000Z');
  const ledgerCreatedAt = new Date('2026-06-24T10:21:30.000Z');

  await insertOrder({
    id: 'order_billing_join',
    orderNo,
    userId: user.id,
    userEmail: user.email,
    status: 'paid',
    amount: 500,
    paymentProvider: 'stripe',
    paidAt,
  });
  await insertLedger({
    id: 'ledger_billing_join',
    portalUserId: user.id,
    orderNo,
    amountUsd: 5,
    status: 'applied',
    createdAt: ledgerCreatedAt,
  });

  const entries = await modules.portal.listBillingLedgerEntries(user.id);

  assert.deepEqual(entries, [
    {
      orderNo,
      amountUsd: 5,
      ledgerStatus: 'applied',
      orderStatus: 'paid',
      paymentProvider: 'stripe',
      paidAt: paidAt.getTime(),
      createdAt: ledgerCreatedAt.getTime(),
    },
  ]);
});

test('billing amounts format amountUsd as dollars without cent conversion', async () => {
  assert.equal(modules.money.formatUsdAmount(5), '$5.000000');
  assert.notEqual(modules.money.formatUsdAmount(5), '$500.000000');
});

test('listBillingLedgerEntries keeps ledger entries without orderNo with nullable order fields', async () => {
  assert.equal(typeof modules.portal.listBillingLedgerEntries, 'function');
  const user = await insertUser(
    'billing_manual_user',
    'billing-manual@example.com'
  );
  const ledgerCreatedAt = new Date('2026-06-24T11:00:00.000Z');

  await insertLedger({
    id: 'ledger_manual_no_order',
    portalUserId: user.id,
    orderNo: null,
    amountUsd: 12,
    status: 'pending',
    source: 'manual_adjustment',
    createdAt: ledgerCreatedAt,
  });

  const entries = await modules.portal.listBillingLedgerEntries(user.id);

  assert.equal(entries.length, 1);
  assert.equal(entries[0].orderNo, null);
  assert.equal(entries[0].orderStatus, null);
  assert.equal(entries[0].paymentProvider, null);
  assert.equal(entries[0].paidAt, null);
  assert.equal(entries[0].ledgerStatus, 'pending');
  assert.equal(entries[0].amountUsd, 12);
  assert.equal(entries[0].createdAt, ledgerCreatedAt.getTime());
});

test('billing status labels cover payment and ledger states', async () => {
  const billingPage = await import(
    '@/app/[locale]/(landing)/dashboard/billing/page'
  );

  assert.equal(typeof billingPage.mapPayStatus, 'function');
  assert.equal(typeof billingPage.mapApplyStatus, 'function');

  assert.equal(billingPage.mapPayStatus('paid'), 'Paid');
  assert.equal(billingPage.mapPayStatus('created'), 'Pending');
  assert.equal(billingPage.mapPayStatus('failed'), 'Failed');
  assert.equal(billingPage.mapPayStatus(null), '—');

  assert.equal(billingPage.mapApplyStatus('applied'), 'Credited');
  assert.equal(billingPage.mapApplyStatus('pending'), 'Processing');
  assert.equal(billingPage.mapApplyStatus('failed'), 'Failed');
});
