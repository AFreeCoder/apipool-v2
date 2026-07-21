import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { createClient } from '@libsql/client';
import { eq } from 'drizzle-orm';

let modules: any;
let client: ReturnType<typeof createClient>;
const BASE_NOW = Date.parse('2026-07-15T12:00:00.000Z');

async function setupDb() {
  const dbPath = join(process.cwd(), '.tmp', 'gateway-reconcile.db');
  await mkdir(join(process.cwd(), '.tmp'), { recursive: true });
  await rm(dbPath, { force: true });
  process.env.DATABASE_PROVIDER = 'sqlite';
  process.env.DATABASE_URL = `file:${dbPath}`;
  process.env.DB_SCHEMA_FILE = './src/config/db/schema.sqlite.ts';
  process.env.DB_SINGLETON_ENABLED = 'false';
  process.env.APIPOOL_CREDENTIALS_SECRET = 'gateway-reconcile-test-secret';

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
  const reconcile = await import('@/features/gateway/server/reconcile');
  const settlement = await import('@/features/gateway/server/settlement');
  modules = { crypto, db, reconcile, schema, settlement };
  await db().insert(schema.catalogGroup).values({
    id: 'reconcile-group',
    slug: 'reconcile-group',
    name: 'Reconcile Group',
    newapiGroup: 'official',
  });
}

async function setWatermark(value: Date | null) {
  await modules
    .db()
    .update(modules.schema.gatewayJobLock)
    .set({ reconcileWatermarkAt: value })
    .where(eq(modules.schema.gatewayJobLock.id, 'singleton'));
}

async function watermark() {
  const [row] = await modules
    .db()
    .select()
    .from(modules.schema.gatewayJobLock)
    .where(eq(modules.schema.gatewayJobLock.id, 'singleton'));
  return row.reconcileWatermarkAt as Date | null;
}

async function seedUser(suffix: string, balance = 1_000_000) {
  const userId = `reconcile-user-${suffix}`;
  await modules
    .db()
    .insert(modules.schema.user)
    .values({
      id: userId,
      name: suffix,
      email: `${suffix}@reconcile.test`,
    });
  await modules.db().insert(modules.schema.walletAccount).values({
    userId,
    balanceMicroUsd: balance,
  });
  await modules
    .db()
    .insert(modules.schema.newApiUserBinding)
    .values({
      id: `reconcile-binding-${suffix}`,
      portalUserId: userId,
      newapiUserId: `remote-${suffix}`,
      status: 'active',
      newapiAccessTokenEnc: modules.crypto.encryptCredential(
        `access-${suffix}`
      ),
    });
  return userId;
}

async function seedPrice(
  suffix: string,
  overrides: Record<string, number | null> = {}
) {
  const id = `reconcile-price-${suffix}`;
  await modules
    .db()
    .insert(modules.schema.modelPriceVersion)
    .values({
      id,
      portalGroupId: 'reconcile-group',
      portalModelId: `model-${suffix}`,
      version: 1,
      ratesJson: JSON.stringify({
        input: 1_000_000,
        cached_input: 500_000,
        cache_write_5m: 1_250_000,
        cache_write_1h: 2_000_000,
        output: 2_000_000,
      }),
      newapiRefInputMicroUsdPerM: 1_000_000,
      newapiRefCachedInputMicroUsdPerM: 500_000,
      newapiRefCacheWrite5mMicroUsdPerM: 1_250_000,
      newapiRefCacheWrite1hMicroUsdPerM: 2_000_000,
      newapiRefOutputMicroUsdPerM: 2_000_000,
      refNewapiGroup: 'official',
      publishedBy: 'reconcile-test',
      ...overrides,
    });
  return id;
}

async function seedLedger(
  suffix: string,
  options: {
    userId?: string;
    status?: string;
    buckets?: Partial<{
      uncachedInput: number;
      cachedRead: number;
      cacheWrite5m: number;
      cacheWrite1h: number;
      output: number;
      reasoning: number;
    }>;
    priceOverrides?: Record<string, number | null>;
    modelId?: string;
  } = {}
) {
  const userId = options.userId ?? (await seedUser(suffix));
  const priceVersionId = await seedPrice(suffix, options.priceOverrides);
  const id = `preq-reconcile-${suffix}`;
  const requestId = `rid-reconcile-${suffix}`;
  const modelId = options.modelId ?? `model-${suffix}`;
  await modules
    .db()
    .insert(modules.schema.requestLedger)
    .values({
      id,
      newapiRequestId: requestId,
      userId,
      portalKeyId: 'key',
      portalGroupId: 'reconcile-group',
      portalModelId: `model-${suffix}`,
      newapiGroup: 'official',
      newapiModelId: modelId,
      credentialId: 'credential',
      routeVersion: 1,
      priceVersionId,
      endpoint: 'chat_completions',
      isStream: false,
      status: 'open',
    });
  const buckets = {
    uncachedInput: 10,
    cachedRead: 0,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    output: 4,
    reasoning: 0,
    ...options.buckets,
  };
  if (options.status === 'settled') {
    await modules.settlement.settleByLedgerId(id, {
      buckets,
      usageSource: 'response',
    });
  } else if (options.status === 'failed_unbilled') {
    await modules
      .db()
      .update(modules.schema.requestLedger)
      .set({ status: 'failed_unbilled' })
      .where(eq(modules.schema.requestLedger.id, id));
  }
  return { buckets, id, modelId, priceVersionId, requestId, userId };
}

function logFor(
  ledger: { requestId: string; modelId: string },
  overrides: Record<string, unknown> = {}
) {
  return {
    id: `log-${ledger.requestId}`,
    requestId: ledger.requestId,
    keyMasked: 'rk_reconcile_known',
    modelId: ledger.modelId,
    inputTokens: 10,
    outputTokens: 4,
    quota: 9,
    spendUsd: 18 / 1_000_000,
    createdAt: new Date(BASE_NOW - 1000).toISOString(),
    ...overrides,
  };
}

function pageClient(
  logs: any[],
  options: { adminFails?: boolean; onAdmin?: (params: any) => void } = {}
) {
  const select = (params: any) => {
    const start = params.startTimestamp * 1000;
    const end = params.endTimestamp * 1000;
    const matching = logs.filter((item) => {
      const at = Date.parse(item.createdAt);
      return at >= start && at <= end;
    });
    const page = matching.slice((params.page - 1) * 100, params.page * 100);
    return { logs: page, full: page.length === 100 };
  };
  return {
    listAdminUsageLogsPage: async (params: any) => {
      options.onAdmin?.(params);
      if (options.adminFails) throw new Error('admin logs unavailable');
      return select(params);
    },
    listUserUsageLogsPage: async (_credentials: any, params: any) =>
      select(params),
  };
}

async function run(logs: any[], options: Record<string, unknown> = {}) {
  await setWatermark(new Date(BASE_NOW));
  return modules.reconcile.runReconcileSyncOnce({
    client: pageClient(logs),
    now: () => BASE_NOW,
    ...options,
  });
}

async function ledgerRow(id: string) {
  const [row] = await modules
    .db()
    .select()
    .from(modules.schema.requestLedger)
    .where(eq(modules.schema.requestLedger.id, id));
  return row;
}

test.before(setupDb);
test.after(() => client.close());

test('settled 命中：对账字段回填并 matched', async () => {
  const ledger = await seedLedger('matched', { status: 'settled' });
  const result = await run([logFor(ledger)]);
  assert.deepEqual(result, {
    scanned: 1,
    settledByLog: 0,
    orphans: 0,
    truncated: false,
  });
  const row = await ledgerRow(ledger.id);
  assert.equal(row.reconcileStatus, 'matched');
  assert.equal(row.newapiQuota, 9);
  assert.equal(row.newapiPromptTokens, 10);
  assert.ok(row.reconciledAt instanceof Date);
});

test('用量层不一致 → token_mismatch', async () => {
  const ledger = await seedLedger('token-mismatch', { status: 'settled' });
  await run([logFor(ledger, { inputTokens: 11 })]);
  assert.equal((await ledgerRow(ledger.id)).reconcileStatus, 'token_mismatch');
});

test('金额外部超差为 amount_mismatch，±10 micro 容差内 matched', async () => {
  const mismatch = await seedLedger('amount-mismatch', { status: 'settled' });
  const tolerance = await seedLedger('amount-tolerance', { status: 'settled' });
  await run([
    logFor(mismatch, { quota: 50, spendUsd: 100 / 1_000_000 }),
    logFor(tolerance, { quota: 12, spendUsd: 23 / 1_000_000 }),
  ]);
  assert.equal(
    (await ledgerRow(mismatch.id)).reconcileStatus,
    'amount_mismatch'
  );
  assert.equal((await ledgerRow(tolerance.id)).reconcileStatus, 'matched');
});

test('原始 quota 优先于 spendUsd 反算，避免浮点精度损失', async () => {
  const ledger = await seedLedger('raw-quota', { status: 'settled' });
  await run([logFor(ledger, { quota: 9, spendUsd: 1 })]);
  const row = await ledgerRow(ledger.id);
  assert.equal(row.newapiQuota, 9);
  assert.equal(row.reconcileStatus, 'matched');
});

test('open 命中 → log_backfill 结算', async () => {
  const ledger = await seedLedger('open-settle');
  const result = await run([logFor(ledger)]);
  assert.equal(result.settledByLog, 1);
  const row = await ledgerRow(ledger.id);
  assert.equal(row.status, 'settled');
  assert.equal(row.usageSource, 'log_backfill');
});

test('failed_unbilled 命中 → waived_by_failure 且不扣费', async () => {
  const ledger = await seedLedger('waived', { status: 'failed_unbilled' });
  await run([logFor(ledger)]);
  const row = await ledgerRow(ledger.id);
  assert.equal(row.reconcileStatus, 'waived_by_failure');
  const charges = await modules
    .db()
    .select()
    .from(modules.schema.walletLedger)
    .where(eq(modules.schema.walletLedger.requestLedgerId, ledger.id));
  assert.equal(charges.length, 0);
});

test('孤儿 rk_ 写 observation、正确归因且不伪造主账本', async () => {
  const userId = await seedUser('orphan-known');
  await modules.db().insert(modules.schema.runtimeCredential).values({
    id: 'credential-orphan-known',
    portalUserId: userId,
    newapiGroup: 'official',
    remoteName: 'rk_orphan_known',
    status: 'active',
  });
  const before = await modules.db().select().from(modules.schema.requestLedger);
  const result = await run([
    {
      id: 'log-orphan-known',
      requestId: 'rid-orphan-known',
      keyMasked: 'rk_orphan_known',
      modelId: 'orphan-model',
      inputTokens: 1,
      outputTokens: 2,
      spendUsd: 0.01,
      createdAt: new Date(BASE_NOW - 1000).toISOString(),
    },
  ]);
  assert.equal(result.orphans, 1);
  const observations = await modules
    .db()
    .select()
    .from(modules.schema.reconcileOrphanObservation)
    .where(
      eq(
        modules.schema.reconcileOrphanObservation.newapiRequestId,
        'rid-orphan-known'
      )
    );
  assert.equal(observations.length, 1);
  assert.equal(observations[0].portalUserId, userId);
  assert.equal(observations[0].credentialId, 'credential-orphan-known');
  assert.equal(
    (await modules.db().select().from(modules.schema.requestLedger)).length,
    before.length
  );
});

test('孤儿幂等：同 request id 二轮仍只有一行', async () => {
  const orphan = {
    id: 'log-orphan-idempotent',
    requestId: 'rid-orphan-idempotent',
    keyMasked: 'rk_unknown_idempotent',
    modelId: 'orphan-model',
    inputTokens: 1,
    outputTokens: 1,
    spendUsd: 0.01,
    createdAt: new Date(BASE_NOW - 1000).toISOString(),
  };
  const first = await run([orphan]);
  const second = await run([orphan]);
  assert.equal(first.orphans, 1);
  assert.equal(second.orphans, 0);
  const rows = await modules
    .db()
    .select()
    .from(modules.schema.reconcileOrphanObservation)
    .where(
      eq(
        modules.schema.reconcileOrphanObservation.newapiRequestId,
        orphan.requestId
      )
    );
  assert.equal(rows.length, 1);
});

test('孤儿反查失败保留 tokenName，归因列为空', async () => {
  const orphan = {
    id: 'log-orphan-unknown',
    requestId: 'rid-orphan-unknown',
    keyMasked: 'rk_no_local_match',
    modelId: 'orphan-model',
    inputTokens: 1,
    outputTokens: 1,
    spendUsd: 0.01,
    createdAt: new Date(BASE_NOW - 1000).toISOString(),
  };
  await run([orphan]);
  const [row] = await modules
    .db()
    .select()
    .from(modules.schema.reconcileOrphanObservation)
    .where(
      eq(
        modules.schema.reconcileOrphanObservation.newapiRequestId,
        orphan.requestId
      )
    );
  assert.equal(row.portalUserId, null);
  assert.equal(row.tokenName, orphan.keyMasked);
});

test('孤儿非 rk_ 属域外消费，不入任何表', async () => {
  await run([
    {
      id: 'log-external',
      requestId: 'rid-external',
      keyMasked: 'manual-token',
      modelId: 'external-model',
      inputTokens: 1,
      outputTokens: 1,
      spendUsd: 0.01,
      createdAt: new Date(BASE_NOW - 1000).toISOString(),
    },
  ]);
  const rows = await modules
    .db()
    .select()
    .from(modules.schema.reconcileOrphanObservation)
    .where(
      eq(
        modules.schema.reconcileOrphanObservation.newapiRequestId,
        'rid-external'
      )
    );
  assert.equal(rows.length, 0);
});

test('时间片推进：3 片处理后水位到区间末端', async () => {
  await setWatermark(new Date(BASE_NOW - 20 * 60_000));
  const calls: any[] = [];
  const result = await modules.reconcile.runReconcileSyncOnce({
    client: pageClient([], { onAdmin: (params) => calls.push(params) }),
    now: () => BASE_NOW,
  });
  assert.equal(result.truncated, false);
  assert.equal((await watermark())!.getTime(), BASE_NOW);
  assert.equal(calls.length, 3);
});

test('积压跨轮续跑：每轮水位净推进，最终追平', async () => {
  await setWatermark(new Date(BASE_NOW - 140 * 60_000));
  const first = await modules.reconcile.runReconcileSyncOnce({
    client: pageClient([]),
    now: () => BASE_NOW,
  });
  const firstWatermark = (await watermark())!.getTime();
  assert.equal(first.truncated, true);
  assert.ok(firstWatermark > BASE_NOW - 140 * 60_000);
  const second = await modules.reconcile.runReconcileSyncOnce({
    client: pageClient([]),
    now: () => BASE_NOW,
  });
  assert.equal(second.truncated, false);
  assert.equal((await watermark())!.getTime(), BASE_NOW);
});

test('片溢出自动二分并最终推进水位', async () => {
  await setWatermark(new Date(BASE_NOW));
  const logs = Array.from({ length: 250 }, (_, index) => ({
    id: `overflow-${index}`,
    requestId: `rid-overflow-${index}`,
    keyMasked: 'manual-token',
    modelId: 'overflow-model',
    inputTokens: 1,
    outputTokens: 1,
    spendUsd: 0.01,
    createdAt: new Date(BASE_NOW - (index % 500_000)).toISOString(),
  }));
  let alerted = false;
  const originalError = console.error;
  const originalWarn = console.warn;
  console.error = (...args: unknown[]) => {
    if (String(args[0]).includes('reconcile_slice_overflow')) alerted = true;
  };
  console.warn = () => {};
  try {
    const result = await modules.reconcile.runReconcileSyncOnce({
      client: pageClient(logs),
      now: () => BASE_NOW,
      slicePageLimit: 2,
      maxSlicesPerRun: 20,
    });
    assert.equal(result.truncated, false);
  } finally {
    console.error = originalError;
    console.warn = originalWarn;
  }
  assert.equal(alerted, true);
  assert.equal((await watermark())!.getTime(), BASE_NOW);
});

test('1s 片溢出不再拆分，继续翻页到耗尽', async () => {
  await setWatermark(new Date(BASE_NOW));
  const logs = Array.from({ length: 250 }, (_, index) => ({
    id: `same-second-${index}`,
    requestId: `rid-same-second-${index}`,
    keyMasked: 'manual-token',
    modelId: 'same-second-model',
    inputTokens: 1,
    outputTokens: 1,
    spendUsd: 0.01,
    createdAt: new Date(BASE_NOW - 500).toISOString(),
  }));
  let pages = 0;
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    await modules.reconcile.runReconcileSyncOnce({
      client: pageClient(logs, { onAdmin: () => (pages += 1) }),
      now: () => BASE_NOW,
      sliceMs: 1000,
      slicePageLimit: 2,
    });
  } finally {
    console.warn = originalWarn;
  }
  assert.ok(pages >= 3);
  assert.equal((await watermark())!.getTime(), BASE_NOW);
});

test('overlap 中断时水位单调不减', async () => {
  const old = BASE_NOW - 20 * 60_000;
  await setWatermark(new Date(old));
  let calls = 0;
  await modules.reconcile.runReconcileSyncOnce({
    client: pageClient([]),
    now: () => BASE_NOW,
    keepAlive: async () => {
      calls += 1;
      return calls === 1;
    },
  });
  assert.ok((await watermark())!.getTime() >= old);
});

test('页间丢锁停在上一完整片，重跑后终态一致', async () => {
  const old = BASE_NOW - 20 * 60_000;
  await setWatermark(new Date(old));
  let calls = 0;
  const first = await modules.reconcile.runReconcileSyncOnce({
    client: pageClient([]),
    now: () => BASE_NOW,
    keepAlive: async () => {
      calls += 1;
      return calls <= 2;
    },
  });
  assert.equal(first.truncated, true);
  const stopped = (await watermark())!.getTime();
  assert.ok(stopped >= old);
  await modules.reconcile.runReconcileSyncOnce({
    client: pageClient([]),
    now: () => BASE_NOW,
  });
  assert.equal((await watermark())!.getTime(), BASE_NOW);
});

test('ref 缺维且对应桶非零：只做内部核对，不产生假 amount_mismatch', async () => {
  const ledger = await seedLedger('ref-missing', {
    status: 'settled',
    buckets: { cachedRead: 2 },
    priceOverrides: { newapiRefCachedInputMicroUsdPerM: null },
  });
  await run([logFor(ledger, { inputTokens: 12, spendUsd: 19 / 1_000_000 })]);
  const row = await ledgerRow(ledger.id);
  assert.equal(row.reconcileStatus, 'matched');
  assert.match(row.reconcileNote, /ref_missing:cached_read/);
});

test('日志模型与账本模型不一致 → token_mismatch + model_mismatch note', async () => {
  const ledger = await seedLedger('model-mismatch', { status: 'settled' });
  await run([logFor(ledger, { modelId: 'different-model' })]);
  const row = await ledgerRow(ledger.id);
  assert.equal(row.reconcileStatus, 'token_mismatch');
  assert.match(row.reconcileNote, /model_mismatch/);
});

test('未知维度成本通过外部金额差额呈现为 amount_mismatch', async () => {
  const ledger = await seedLedger('unmapped-cost', { status: 'settled' });
  await run([logFor(ledger, { quota: 500, spendUsd: 1000 / 1_000_000 })]);
  assert.equal((await ledgerRow(ledger.id)).reconcileStatus, 'amount_mismatch');
});

test('admin 失败时 fallback 按时间片逐用户追平并推进水位', async () => {
  const ledger = await seedLedger('fallback', { status: 'settled' });
  await setWatermark(new Date(BASE_NOW - 20 * 60_000));
  const logs = [
    logFor(ledger, {
      createdAt: new Date(BASE_NOW - 15 * 60_000).toISOString(),
    }),
  ];
  let fallbackCalls = 0;
  const client = pageClient(logs, { adminFails: true });
  const original = client.listUserUsageLogsPage;
  client.listUserUsageLogsPage = async (credentials: any, params: any) => {
    fallbackCalls += 1;
    return original(credentials, params);
  };
  const originalWarn = console.warn;
  console.warn = () => {};
  try {
    const result = await modules.reconcile.runReconcileSyncOnce({
      client,
      now: () => BASE_NOW,
    });
    assert.equal(result.truncated, false);
  } finally {
    console.warn = originalWarn;
  }
  assert.ok(fallbackCalls >= 3);
  assert.equal((await watermark())!.getTime(), BASE_NOW);
  assert.equal((await ledgerRow(ledger.id)).reconcileStatus, 'matched');
});

test('钱包不变量破坏时告警，不自动修复', async () => {
  const userId = await seedUser('wallet-broken', 123);
  const originalError = console.error;
  console.error = () => {};
  let result: { broken: string[] };
  try {
    result = await modules.reconcile.runWalletInvariantCheckOnce();
  } finally {
    console.error = originalError;
  }
  assert.ok(result.broken.includes(userId));
  const [wallet] = await modules
    .db()
    .select()
    .from(modules.schema.walletAccount)
    .where(eq(modules.schema.walletAccount.userId, userId));
  assert.equal(wallet.balanceMicroUsd, 123);
});
