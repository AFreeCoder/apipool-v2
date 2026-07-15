import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { createClient } from '@libsql/client';

let modules: any;

async function setupDb() {
  const dbPath = join(process.cwd(), '.tmp', 'wallet-ledger.db');
  await mkdir(join(process.cwd(), '.tmp'), { recursive: true });
  await rm(dbPath, { force: true });
  process.env.DATABASE_PROVIDER = 'sqlite';
  process.env.DATABASE_URL = `file:${dbPath}`;
  process.env.DB_SCHEMA_FILE = './src/config/db/schema.sqlite.ts';
  process.env.DB_SINGLETON_ENABLED = 'false';
  process.env.APIPOOL_CREDENTIALS_SECRET = 'wallet-ledger-test-secret';

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
  const ledger = await import('@/features/wallet/server/ledger');
  const freeze = await import('@/features/wallet/server/freeze');
  modules = { db, freeze, ledger, schema };
}

async function createUser(userId: string) {
  await modules
    .db()
    .insert(modules.schema.user)
    .values({
      id: userId,
      name: userId,
      email: `${userId}@wallet.test`,
    });
  await modules.ledger.ensureWalletAccount(userId);
}

async function append(entry: Record<string, unknown>) {
  return modules
    .db()
    .transaction((tx: any) => modules.ledger.appendLedgerEntryInTx(tx, entry));
}

test.before(setupDb);

test('符号校验：recharge 必须为正、request_charge 必须为负、manual 非零', async () => {
  await createUser('wallet-sign');
  await assert.rejects(
    append({
      userId: 'wallet-sign',
      entryType: 'recharge',
      signedAmountMicroUsd: -1,
    }),
    /invalid sign/
  );
  await assert.rejects(
    append({
      userId: 'wallet-sign',
      entryType: 'request_charge',
      signedAmountMicroUsd: 1,
    }),
    /invalid sign/
  );
  await assert.rejects(
    append({
      userId: 'wallet-sign',
      entryType: 'manual_adjustment',
      signedAmountMicroUsd: 0,
      reason: 'zero',
      operatorUserId: 'operator',
    }),
    /invalid sign/
  );
});

test('manual_adjustment 缺 reason/operator 被拒', async () => {
  await createUser('wallet-manual-required');
  await assert.rejects(
    append({
      userId: 'wallet-manual-required',
      entryType: 'manual_adjustment',
      signedAmountMicroUsd: 1,
      operatorUserId: 'operator',
    }),
    /requires reason and operatorUserId/
  );
});

test('余额闭合：多笔后 balance == Σ signed_amount 且 balance_after 正确', async () => {
  const userId = 'wallet-balance';
  await createUser(userId);
  await append({
    userId,
    entryType: 'recharge',
    signedAmountMicroUsd: 5_000_000,
    orderNo: 'wallet-o1',
  });
  await append({
    userId,
    entryType: 'request_charge',
    signedAmountMicroUsd: -1_234_567,
    requestLedgerId: 'preq_wallet_a',
  });
  await append({
    userId,
    entryType: 'manual_adjustment',
    signedAmountMicroUsd: 234_567,
    reason: 'rounding correction',
    operatorUserId: 'operator',
  });

  const account = await modules.ledger.getWalletAccount(userId);
  assert.equal(account.balanceMicroUsd, 4_000_000);
  const rows = await modules
    .db()
    .select()
    .from(modules.schema.walletLedger)
    .where(
      (await import('drizzle-orm')).eq(
        modules.schema.walletLedger.userId,
        userId
      )
    );
  assert.deepEqual(
    rows.map((row: any) => row.balanceAfterMicroUsd),
    [5_000_000, 3_765_433, 4_000_000]
  );
  assert.equal(
    rows.reduce((sum: number, row: any) => sum + row.signedAmountMicroUsd, 0),
    account.balanceMicroUsd
  );
});

test('applyManualAdjustment 幂等：同键同载荷只写一行', async () => {
  const userId = 'wallet-idempotent';
  await createUser(userId);
  const input = {
    userId,
    signedAmountMicroUsd: 900,
    reason: 'manual credit',
    operatorUserId: 'operator',
    idempotencyKey: 'wallet-idem-1',
  };
  const first = await modules.ledger.applyManualAdjustment(input);
  const second = await modules.ledger.applyManualAdjustment(input);
  assert.equal(first.alreadyApplied, false);
  assert.equal(second.alreadyApplied, true);
  assert.equal(second.ledgerId, first.ledgerId);
  assert.equal(
    (await modules.ledger.getWalletAccount(userId)).balanceMicroUsd,
    900
  );
});

test('响应丢失重放：稳定幂等键让余额只变一次', async () => {
  const userId = 'wallet-lost-response';
  await createUser(userId);
  const input = {
    userId,
    signedAmountMicroUsd: 1234,
    reason: 'lost response retry',
    operatorUserId: 'operator',
    idempotencyKey: 'wallet-lost-response-key',
  };
  await modules.ledger.applyManualAdjustment(input);
  const retried = await modules.ledger.applyManualAdjustment(input);
  assert.equal(retried.alreadyApplied, true);
  assert.equal(
    (await modules.ledger.getWalletAccount(userId)).balanceMicroUsd,
    1234
  );
});

test('幂等冲突：同 key 不同载荷被拒且余额不变', async () => {
  await createUser('wallet-conflict-a');
  await createUser('wallet-conflict-b');
  const base = {
    userId: 'wallet-conflict-a',
    signedAmountMicroUsd: 100,
    reason: 'base',
    operatorUserId: 'operator',
    idempotencyKey: 'wallet-conflict-key',
  };
  await modules.ledger.applyManualAdjustment(base);
  for (const changed of [
    { ...base, userId: 'wallet-conflict-b' },
    { ...base, signedAmountMicroUsd: 101 },
    { ...base, reason: 'changed' },
  ]) {
    await assert.rejects(
      modules.ledger.applyManualAdjustment(changed),
      modules.ledger.IdempotencyConflictError
    );
  }
  assert.equal(
    (await modules.ledger.getWalletAccount('wallet-conflict-a'))
      .balanceMicroUsd,
    100
  );
  assert.equal(
    (await modules.ledger.getWalletAccount('wallet-conflict-b'))
      .balanceMicroUsd,
    0
  );
});

test('并发唯一冲突读回仍校验载荷', async () => {
  const userId = 'wallet-concurrent';
  await createUser(userId);
  const base = {
    userId,
    reason: 'concurrent',
    operatorUserId: 'operator',
    idempotencyKey: 'wallet-concurrent-key',
  };
  const results = await Promise.allSettled([
    modules.ledger.applyManualAdjustment({
      ...base,
      signedAmountMicroUsd: 200,
    }),
    modules.ledger.applyManualAdjustment({
      ...base,
      signedAmountMicroUsd: 300,
    }),
  ]);
  assert.equal(
    results.filter((result) => result.status === 'fulfilled').length,
    1
  );
  assert.equal(
    results.filter((result) => result.status === 'rejected').length,
    1
  );
  const rejected = results.find(
    (result) => result.status === 'rejected'
  ) as any;
  assert.ok(
    rejected.reason instanceof modules.ledger.IdempotencyConflictError,
    String(rejected.reason?.stack ?? rejected.reason)
  );
  assert.ok(
    [200, 300].includes(
      (await modules.ledger.getWalletAccount(userId)).balanceMicroUsd
    )
  );
});

test('审计与资金同事务：成功各一行，失败两者都不落', async () => {
  const userId = 'wallet-audit';
  await createUser(userId);
  await modules.ledger.applyManualAdjustment({
    userId,
    signedAmountMicroUsd: 500,
    reason: 'audited',
    operatorUserId: 'operator',
    idempotencyKey: 'wallet-audit-ok',
    audit: {
      action: 'wallet.adjust',
      targetType: 'wallet_account',
      targetId: userId,
      afterJson: { amount: 500 },
    },
  });
  const beforeAudits = await modules
    .db()
    .select()
    .from(modules.schema.portalAdminAuditLog);
  await assert.rejects(
    modules.ledger.applyManualAdjustment({
      userId,
      signedAmountMicroUsd: 0,
      reason: 'invalid',
      operatorUserId: 'operator',
      idempotencyKey: 'wallet-audit-fail',
      audit: {
        action: 'wallet.adjust',
        targetType: 'wallet_account',
      },
    }),
    /invalid sign/
  );
  const afterAudits = await modules
    .db()
    .select()
    .from(modules.schema.portalAdminAuditLog);
  assert.equal(afterAudits.length, beforeAudits.length);
  assert.equal(
    afterAudits.filter((row: any) => row.action === 'wallet.adjust').length,
    1
  );
  assert.equal(
    (await modules.ledger.getWalletAccount(userId)).balanceMicroUsd,
    500
  );
});

test('reverseRequestCharge：按原扣费绝对值冲正且幂等', async () => {
  const userId = 'wallet-reverse';
  await createUser(userId);
  const charged = await append({
    userId,
    entryType: 'request_charge',
    signedAmountMicroUsd: -777,
    requestLedgerId: 'preq-reverse',
  });
  const first = await modules.ledger.reverseRequestCharge({
    walletLedgerId: charged.ledgerId,
    operatorUserId: 'operator',
  });
  const second = await modules.ledger.reverseRequestCharge({
    walletLedgerId: charged.ledgerId,
    operatorUserId: 'operator',
  });
  assert.equal(first.alreadyApplied, false);
  assert.equal(second.alreadyApplied, true);
  assert.equal(
    (await modules.ledger.getWalletAccount(userId)).balanceMicroUsd,
    0
  );
});

test('同一 requestLedgerId 第二条 request_charge 被唯一索引拒绝', async () => {
  const userId = 'wallet-request-unique';
  await createUser(userId);
  await append({
    userId,
    entryType: 'request_charge',
    signedAmountMicroUsd: -10,
    requestLedgerId: 'preq-unique',
  });
  await assert.rejects(
    append({
      userId,
      entryType: 'request_charge',
      signedAmountMicroUsd: -20,
      requestLedgerId: 'preq-unique',
    }),
    /UNIQUE|constraint/i
  );
  assert.equal(
    (await modules.ledger.getWalletAccount(userId)).balanceMicroUsd,
    -10
  );
});

test('freeze/unfreeze：条件迁移幂等，解冻写审计', async () => {
  const userId = 'wallet-freeze';
  await createUser(userId);
  assert.equal(
    await modules.freeze.freezeWallet({
      userId,
      reason: 'manual',
      frozenBy: 'operator',
    }),
    true
  );
  assert.equal(
    await modules.freeze.freezeWallet({
      userId,
      reason: 'manual',
      frozenBy: 'operator',
    }),
    false
  );
  assert.equal(
    await modules.freeze.unfreezeWallet({
      userId,
      operatorUserId: 'operator',
      reason: 'reviewed',
    }),
    true
  );
  assert.equal(
    await modules.freeze.unfreezeWallet({
      userId,
      operatorUserId: 'operator',
      reason: 'reviewed',
    }),
    false
  );
  const audits = await modules
    .db()
    .select()
    .from(modules.schema.portalAdminAuditLog);
  assert.equal(
    audits.filter(
      (row: any) => row.action === 'wallet.unfreeze' && row.targetId === userId
    ).length,
    1
  );
});

test('append-only 代码守卫：src/ 中不存在 update(walletLedger)', () => {
  const hits = execSync(`grep -rn "update(walletLedger)" src/ || true`, {
    encoding: 'utf8',
  }).trim();
  assert.equal(hits, '');
});
