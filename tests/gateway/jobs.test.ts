import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { createClient } from '@libsql/client';
import { eq } from 'drizzle-orm';

let modules: any;
let client: ReturnType<typeof createClient>;

async function setupDb() {
  const dbPath = join(process.cwd(), '.tmp', 'gateway-jobs.db');
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
  const jobs = await import('@/features/gateway/server/jobs');
  modules = { db, jobs, schema };
}

async function resetLock() {
  await modules
    .db()
    .update(modules.schema.gatewayJobLock)
    .set({ holderId: null, heartbeatAt: null, acquiredAt: null })
    .where(eq(modules.schema.gatewayJobLock.id, 'singleton'));
}

test.before(setupDb);
test.after(() => client.close());
test.beforeEach(resetLock);

test('抢锁：两 holder 竞争恰一个成功，同 holder 可重入', async () => {
  const [a, b] = await Promise.all([
    modules.jobs.acquireJobLock('holder-a'),
    modules.jobs.acquireJobLock('holder-b'),
  ]);
  assert.equal(Number(a) + Number(b), 1);
  const winner = a ? 'holder-a' : 'holder-b';
  assert.equal(await modules.jobs.acquireJobLock(winner), true);
});

test('stale 夺锁：A 心跳过期后 B 可接管', async () => {
  assert.equal(await modules.jobs.acquireJobLock('holder-a'), true);
  await modules
    .db()
    .update(modules.schema.gatewayJobLock)
    .set({ heartbeatAt: new Date(Date.now() - 10_000) })
    .where(eq(modules.schema.gatewayJobLock.id, 'singleton'));
  assert.equal(await modules.jobs.acquireJobLock('holder-b', 1000), true);
});

test('heartbeatJobLock：holder 不符返回 false，当前 holder 返回 true', async () => {
  await modules.jobs.acquireJobLock('holder-a');
  assert.equal(await modules.jobs.heartbeatJobLock('holder-b'), false);
  assert.equal(await modules.jobs.heartbeatJobLock('holder-a'), true);
});

test('执行期续租：keepAlive 推进心跳，竞争者无法按 stale 接管', async () => {
  await modules.jobs.acquireJobLock('holder-a');
  await modules
    .db()
    .update(modules.schema.gatewayJobLock)
    .set({ heartbeatAt: new Date(Date.now() - 5000) })
    .where(eq(modules.schema.gatewayJobLock.id, 'singleton'));
  let now = 20_000;
  const controller = modules.jobs.createKeepAliveController('holder-a', {
    now: () => now,
  });
  controller.setHasLock(true, 0);
  assert.equal(await controller.keepAlive(), true);
  assert.equal(await modules.jobs.acquireJobLock('holder-b', 1000), false);
});

test('keepAlive 10 秒内多次调用只发一次真心跳', async () => {
  let now = 10_000;
  let beats = 0;
  const controller = modules.jobs.createKeepAliveController('holder-a', {
    now: () => now,
    heartbeat: async () => {
      beats += 1;
      return true;
    },
  });
  controller.setHasLock(true, 0);
  assert.equal(await controller.keepAlive(), true);
  now = 15_000;
  assert.equal(await controller.keepAlive(), true);
  assert.equal(beats, 1);
  now = 20_000;
  assert.equal(await controller.keepAlive(), true);
  assert.equal(beats, 2);
});

test('丢锁后 keepAlive 返回 false，并将宿主状态置为无锁', async () => {
  let now = 10_000;
  const controller = modules.jobs.createKeepAliveController('holder-a', {
    now: () => now,
    heartbeat: async () => false,
  });
  controller.setHasLock(true, 0);
  assert.equal(await controller.keepAlive(), false);
  assert.equal(controller.hasLock(), false);
  now += 1000;
  assert.equal(await controller.keepAlive(), false);
});

test('instrumentation 仅在 nodejs 且 jobs 未禁用时启动', async () => {
  const source = await readFile('src/instrumentation.ts', 'utf8');
  assert.match(source, /NEXT_RUNTIME\s*!==\s*['"]nodejs['"]/);
  assert.match(source, /GATEWAY_JOBS_ENABLED\s*===\s*['"]false['"]/);
  assert.match(source, /startGatewayJobs/);
});
