import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import type { AdmissionInput } from '@/features/gateway/server/admission';
import { createClient } from '@libsql/client';

let modules: any;
let client: ReturnType<typeof createClient>;

async function setupDb() {
  const dbPath = join(process.cwd(), '.tmp', 'gateway-admission.db');
  await mkdir(join(process.cwd(), '.tmp'), { recursive: true });
  await rm(dbPath, { force: true });
  process.env.DATABASE_PROVIDER = 'sqlite';
  process.env.DATABASE_URL = `file:${dbPath}`;
  process.env.DB_SCHEMA_FILE = './src/config/db/schema.sqlite.ts';
  process.env.DB_SINGLETON_ENABLED = 'false';
  process.env.APIPOOL_CREDENTIALS_SECRET = 'gateway-admission-test-secret';

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
  const admission = await import('@/features/gateway/server/admission');
  const hash = await import('@/shared/lib/hash');
  modules = { admission, db, hash, schema };
}

async function createUser(userId: string, riskLimitOverride?: number) {
  await modules
    .db()
    .insert(modules.schema.user)
    .values({
      id: userId,
      name: userId,
      email: `${userId}@admission.test`,
    });
  await modules.db().insert(modules.schema.walletAccount).values({
    userId,
    riskLimitOverride,
  });
}

function baseInput(
  userId: string,
  over: Partial<AdmissionInput> = {}
): AdmissionInput {
  return {
    id: `preq_${modules.hash.getUuidV7()}`,
    userId,
    portalKeyId: 'k1',
    portalGroupId: 'g1',
    portalModelId: 'gpt-5.4',
    newapiGroup: 'official',
    newapiModelId: 'gpt-5.4',
    credentialId: 'c1',
    routeVersion: 1,
    priceVersionId: 'pv1',
    endpoint: 'chat_completions',
    isStream: false,
    ...over,
  };
}

test.before(setupDb);
test.after(() => client.close());

test('占用 9/上限 10：并发 2 → 恰好 1 open 1 拒绝', async () => {
  const userId = 'admission-race';
  await createUser(userId);
  for (let index = 0; index < 9; index += 1) {
    assert.equal(
      await modules.admission.admitRequest(
        baseInput(userId, { id: `preq_seed_${index}` }),
        10
      ),
      true
    );
  }
  const [first, second] = await Promise.all([
    modules.admission.admitRequest(
      baseInput(userId, { id: 'preq_race_a' }),
      10
    ),
    modules.admission.admitRequest(
      baseInput(userId, { id: 'preq_race_b' }),
      10
    ),
  ]);
  assert.equal(Number(first) + Number(second), 1);
  const rows = await client.execute({
    sql: `SELECT COUNT(*) AS count FROM request_ledger WHERE user_id=? AND status='open'`,
    args: [userId],
  });
  assert.equal(Number(rows.rows[0].count), 10);
});

test('释放=终态迁移本身：markFailedUnbilled 幂等，释放后可再准入', async () => {
  const userId = 'admission-release';
  await createUser(userId);
  assert.equal(
    await modules.admission.admitRequest(
      baseInput(userId, { id: 'preq_release' }),
      1
    ),
    true
  );
  assert.equal(
    await modules.admission.markFailedUnbilled('preq_release', {
      httpStatus: 502,
      errorCode: 'upstream_error',
    }),
    true
  );
  assert.equal(
    await modules.admission.markFailedUnbilled('preq_release', {}),
    false
  );
  assert.equal(
    await modules.admission.admitRequest(
      baseInput(userId, { id: 'preq_after_release' }),
      1
    ),
    true
  );
});

test('captureRequestId：只回填 open 一次，重复 request id 返回 false', async () => {
  const userId = 'admission-capture';
  await createUser(userId);
  await modules.admission.admitRequest(
    baseInput(userId, { id: 'preq_capture_a' }),
    10
  );
  await modules.admission.admitRequest(
    baseInput(userId, { id: 'preq_capture_b' }),
    10
  );
  assert.equal(
    await modules.admission.captureRequestId('preq_capture_a', 'remote-rid-1'),
    true
  );
  assert.equal(
    await modules.admission.captureRequestId('preq_capture_a', 'remote-rid-2'),
    false
  );
  const originalError = console.error;
  console.error = () => undefined;
  try {
    assert.equal(
      await modules.admission.captureRequestId(
        'preq_capture_b',
        'remote-rid-1'
      ),
      false
    );
  } finally {
    console.error = originalError;
  }
});

test('captureRequestId 不吞非 UNIQUE 的 DB 异常', async () => {
  const userId = 'admission-capture-error';
  await createUser(userId);
  await modules.admission.admitRequest(
    baseInput(userId, { id: 'preq_capture_error' }),
    10
  );
  await client.executeMultiple(`
    CREATE TRIGGER fail_nonunique_capture
    BEFORE UPDATE OF newapi_request_id ON request_ledger
    WHEN NEW.id = 'preq_capture_error'
    BEGIN
      SELECT RAISE(ABORT, 'injected nonunique failure');
    END;
  `);
  await assert.rejects(
    modules.admission.captureRequestId(
      'preq_capture_error',
      'remote-rid-error'
    ),
    (error: any) => {
      assert.match(String(error?.cause ?? error), /injected nonunique failure/);
      return true;
    }
  );
});

test('resolveRiskLimit：override 优先，否则 env 默认', async () => {
  await createUser('admission-default');
  await createUser('admission-override', 3);
  delete process.env.GATEWAY_RISK_SLOT_LIMIT;
  assert.equal(
    await modules.admission.resolveRiskLimit('admission-default'),
    10
  );
  process.env.GATEWAY_RISK_SLOT_LIMIT = '12';
  assert.equal(
    await modules.admission.resolveRiskLimit('admission-default'),
    12
  );
  assert.equal(
    await modules.admission.resolveRiskLimit('admission-override'),
    3
  );
  delete process.env.GATEWAY_RISK_SLOT_LIMIT;
});
