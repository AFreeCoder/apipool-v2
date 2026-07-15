import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { createClient } from '@libsql/client';
import { eq, like } from 'drizzle-orm';

test('smoke-recharge 在隔离 DB 闭合 PAID、钱包入账、重放与审计冲回', async () => {
  const dbPath = join(process.cwd(), '.tmp', 'smoke-recharge.db');
  await mkdir(join(process.cwd(), '.tmp'), { recursive: true });
  await rm(dbPath, { force: true });
  process.env.DATABASE_PROVIDER = 'sqlite';
  process.env.DATABASE_URL = `file:${dbPath}`;
  process.env.DB_SCHEMA_FILE = './src/config/db/schema.sqlite.ts';
  process.env.DB_SINGLETON_ENABLED = 'false';
  process.env.NEWAPI_INTEGRATION_ENABLED = 'false';
  process.env.WALLET_LEDGER_WRITE_ENABLED = 'true';
  process.env.APIPOOL_SMOKE_PORTAL_USER_ID = 'smoke-recharge-user';

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
  await db().insert(schema.user).values({
    id: 'smoke-recharge-user',
    email: 'smoke-recharge-user@apipool.local',
    name: 'Smoke Recharge User',
  });
  const { main } = await import('../../scripts/smoke-recharge');
  await main();

  const [smokeOrder] = await db()
    .select()
    .from(schema.order)
    .where(like(schema.order.orderNo, 'cutover-recharge-%'));
  assert.equal(smokeOrder.status, 'paid');
  assert.equal(
    (
      await db()
        .select()
        .from(schema.credit)
        .where(eq(schema.credit.orderNo, smokeOrder.orderNo))
    ).length,
    0
  );
  const entries = await db()
    .select()
    .from(schema.walletLedger)
    .where(eq(schema.walletLedger.userId, 'smoke-recharge-user'));
  assert.deepEqual(
    entries.map((entry: any) => entry.entryType).sort(),
    ['manual_adjustment', 'recharge']
  );
  assert.equal(
    entries.reduce(
      (sum: number, entry: any) => sum + entry.signedAmountMicroUsd,
      0
    ),
    0
  );
  const [account] = await db()
    .select()
    .from(schema.walletAccount)
    .where(eq(schema.walletAccount.userId, 'smoke-recharge-user'));
  assert.equal(account.balanceMicroUsd, 0);

  delete process.env.WALLET_LEDGER_WRITE_ENABLED;
  delete process.env.APIPOOL_SMOKE_PORTAL_USER_ID;
});
