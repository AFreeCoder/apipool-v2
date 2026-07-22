import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { createClient } from '@libsql/client';
import { eq } from 'drizzle-orm';

let modules: any;
let client: ReturnType<typeof createClient>;

const CONFIG = {
  runtimePoolTargetUsd: 1000,
  runtimePoolLowWatermarkUsd: 100,
};
const QUOTA_PER_USD = 500_000;
const TARGET_QUOTA = CONFIG.runtimePoolTargetUsd * QUOTA_PER_USD;

async function setupDb() {
  const dbPath = join(process.cwd(), '.tmp', 'gateway-runtime-pool.db');
  await mkdir(join(process.cwd(), '.tmp'), { recursive: true });
  await rm(dbPath, { force: true });
  process.env.DATABASE_PROVIDER = 'sqlite';
  process.env.DATABASE_URL = `file:${dbPath}`;
  process.env.DB_SCHEMA_FILE = './src/config/db/schema.sqlite.ts';
  process.env.DB_SINGLETON_ENABLED = 'false';
  process.env.APIPOOL_CREDENTIALS_SECRET = 'runtime-pool-test-secret';

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
  const runtimePool = await import('@/features/gateway/server/runtime-pool');
  modules = { schema, db, crypto, runtimePool };
}

async function resetDb() {
  await modules.db().delete(modules.schema.portalAdminAuditLog);
  await modules.db().delete(modules.schema.newApiUserBinding);
  await modules.db().delete(modules.schema.user);
}

async function insertBinding(
  suffix: string,
  values: Record<string, unknown> = {}
) {
  const portalUserId = `runtime-pool-user-${suffix}`;
  await modules
    .db()
    .insert(modules.schema.user)
    .values({
      id: portalUserId,
      name: portalUserId,
      email: `${suffix}@runtime-pool.test`,
    });
  const [binding] = await modules
    .db()
    .insert(modules.schema.newApiUserBinding)
    .values({
      id: `runtime-pool-binding-${suffix}`,
      portalUserId,
      newapiUserId: `remote-${suffix}`,
      status: 'active',
      newapiAccessTokenEnc: modules.crypto.encryptCredential(
        `access-${suffix}`
      ),
      ...values,
    })
    .returning();
  return binding;
}

function createPoolClient(
  initial: Record<string, number>,
  failOverride = false
) {
  const quotas = new Map(Object.entries(initial));
  const getCalls: string[] = [];
  const overrideCalls: Array<{ userId: string; quota: number }> = [];
  return {
    quotas,
    getCalls,
    overrideCalls,
    client: {
      usdToQuota: (usd: number) => usd * QUOTA_PER_USD,
      getQuota: async (user: any) => {
        getCalls.push(user.newapiUserId);
        return { quotaRemaining: quotas.get(user.newapiUserId) ?? 0 };
      },
      overrideUserQuota: async ({ user, quota }: any) => {
        overrideCalls.push({ userId: user.newapiUserId, quota });
        if (failOverride) throw new Error('远端覆盖失败');
        quotas.set(user.newapiUserId, quota);
        return { quotaRemaining: quota };
      },
    },
  };
}

async function getBinding(id: string) {
  const [row] = await modules
    .db()
    .select()
    .from(modules.schema.newApiUserBinding)
    .where(eq(modules.schema.newApiUserBinding.id, id));
  return row;
}

test.before(setupDb);
test.after(() => client.close());
test.beforeEach(resetDb);

test('首次低额度绑定绝对覆盖到目标，重复调用不再访问远端', async () => {
  const binding = await insertBinding('bootstrap');
  const harness = createPoolClient({ [binding.newapiUserId]: 0 });

  const first = await modules.runtimePool.ensureRuntimePoolProvisioned(
    binding,
    harness.client,
    { config: CONFIG }
  );
  const second = await modules.runtimePool.ensureRuntimePoolProvisioned(
    binding,
    harness.client,
    { config: CONFIG }
  );

  assert.deepEqual(first, {
    status: 'ready',
    quota: TARGET_QUOTA,
    remoteWrite: true,
  });
  assert.equal(second.remoteWrite, false);
  assert.equal(harness.getCalls.length, 1);
  assert.deepEqual(harness.overrideCalls, [
    { userId: binding.newapiUserId, quota: TARGET_QUOTA },
  ]);
  const stored = await getBinding(binding.id);
  assert.equal(stored.runtimePoolStatus, 'ready');
  assert.ok(stored.runtimePoolProvisionedAt);
  assert.equal(stored.runtimePoolLastQuota, TARGET_QUOTA);
  const audits = await modules
    .db()
    .select()
    .from(modules.schema.portalAdminAuditLog);
  assert.equal(audits.length, 1);
  assert.equal(audits[0].action, 'newapi.runtime_pool.provision');
});

test('现有额度高于低水位时只建立幂等标记，不覆盖远端', async () => {
  const binding = await insertBinding('existing');
  const existingQuota = 200 * QUOTA_PER_USD;
  const harness = createPoolClient({
    [binding.newapiUserId]: existingQuota,
  });

  const result = await modules.runtimePool.ensureRuntimePoolProvisioned(
    binding,
    harness.client,
    { config: CONFIG }
  );

  assert.equal(result.remoteWrite, false);
  assert.equal(result.quota, existingQuota);
  assert.equal(harness.overrideCalls.length, 0);
  assert.ok((await getBinding(binding.id)).runtimePoolProvisionedAt);
});

test('首次覆盖失败记录 error 且不建立已供应标记', async () => {
  const binding = await insertBinding('failure');
  const harness = createPoolClient({ [binding.newapiUserId]: 0 }, true);

  await assert.rejects(
    () =>
      modules.runtimePool.ensureRuntimePoolProvisioned(
        binding,
        harness.client,
        { config: CONFIG }
      ),
    /远端覆盖失败/
  );

  const stored = await getBinding(binding.id);
  assert.equal(stored.runtimePoolStatus, 'error');
  assert.equal(stored.runtimePoolProvisionedAt, null);
  assert.match(stored.runtimePoolLastError, /远端覆盖失败/);
});

test('定时检查只标记低水位，不自动补充', async () => {
  const binding = await insertBinding('monitor', {
    runtimePoolStatus: 'ready',
    runtimePoolProvisionedAt: new Date(),
  });
  const harness = createPoolClient({
    [binding.newapiUserId]: 10 * QUOTA_PER_USD,
  });

  const result = await modules.runtimePool.runRuntimePoolMonitorOnce({
    client: harness.client,
    config: CONFIG,
  });

  assert.equal(result.scanned, 1);
  assert.equal(result.low, 1);
  assert.equal(result.replenished, 0);
  assert.equal(harness.overrideCalls.length, 0);
  assert.equal((await getBinding(binding.id)).runtimePoolStatus, 'low');
});

test('普通检查不修改未初始化绑定，后台 bootstrap 只供应一次', async () => {
  const binding = await insertBinding('migration-bootstrap');
  const harness = createPoolClient({ [binding.newapiUserId]: 0 });

  const checked = await modules.runtimePool.runRuntimePoolMonitorOnce({
    client: harness.client,
    config: CONFIG,
  });
  assert.equal(checked.uninitialized, 1);
  assert.equal(checked.provisioned, 0);
  assert.equal(harness.getCalls.length, 0);
  assert.equal((await getBinding(binding.id)).runtimePoolProvisionedAt, null);

  const bootstrapped = await modules.runtimePool.runRuntimePoolMonitorOnce({
    client: harness.client,
    config: CONFIG,
    bootstrap: true,
  });
  assert.equal(bootstrapped.uninitialized, 1);
  assert.equal(bootstrapped.provisioned, 1);
  assert.equal(bootstrapped.ready, 1);
  assert.equal(harness.overrideCalls.length, 1);
  assert.ok((await getBinding(binding.id)).runtimePoolProvisionedAt);

  const repeated = await modules.runtimePool.runRuntimePoolMonitorOnce({
    client: harness.client,
    config: CONFIG,
    bootstrap: true,
  });
  assert.equal(repeated.provisioned, 0);
  assert.equal(harness.overrideCalls.length, 1);
});

test('显式 apply 只补充低水位绑定并写入审计', async () => {
  const low = await insertBinding('apply-low', {
    runtimePoolStatus: 'low',
    runtimePoolProvisionedAt: new Date(),
  });
  const ready = await insertBinding('apply-ready', {
    runtimePoolStatus: 'ready',
    runtimePoolProvisionedAt: new Date(),
  });
  const harness = createPoolClient({
    [low.newapiUserId]: 10 * QUOTA_PER_USD,
    [ready.newapiUserId]: 200 * QUOTA_PER_USD,
  });

  const result = await modules.runtimePool.runRuntimePoolMonitorOnce({
    client: harness.client,
    config: CONFIG,
    apply: true,
    operatorUserId: 'operator:test',
  });

  assert.equal(result.scanned, 2);
  assert.equal(result.replenished, 1);
  assert.deepEqual(harness.overrideCalls, [
    { userId: low.newapiUserId, quota: TARGET_QUOTA },
  ]);
  assert.equal((await getBinding(low.id)).runtimePoolStatus, 'ready');
  assert.equal(
    (await getBinding(ready.id)).runtimePoolLastQuota,
    200 * QUOTA_PER_USD
  );
  const audits = await modules
    .db()
    .select()
    .from(modules.schema.portalAdminAuditLog);
  assert.equal(audits.length, 1);
  assert.equal(audits[0].action, 'newapi.runtime_pool.replenish');
  assert.equal(audits[0].operatorUserId, 'operator:test');
});
