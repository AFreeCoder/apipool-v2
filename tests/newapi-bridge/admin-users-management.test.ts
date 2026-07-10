import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { createClient } from '@libsql/client';

let modules: any;

const listPagePath = 'src/app/[locale]/(admin)/admin/users/page.tsx';
const editPagePath = 'src/app/[locale]/(admin)/admin/users/[id]/edit/page.tsx';
const quotaActionsPath =
  'src/features/api-console/server/quota-admin-actions.ts';

async function setupDb() {
  const dbPath = join(process.cwd(), '.tmp', 'admin-users-management.db');
  await mkdir(join(process.cwd(), '.tmp'), { recursive: true });
  await rm(dbPath, { force: true });

  process.env.DATABASE_PROVIDER = 'sqlite';
  process.env.DATABASE_URL = `file:${dbPath}`;
  process.env.DB_SCHEMA_FILE = './src/config/db/schema.sqlite.ts';
  process.env.DB_MIGRATIONS_OUT = './src/config/db/migrations_sqlite';
  process.env.DB_SINGLETON_ENABLED = 'false';
  process.env.APIPOOL_CREDENTIALS_SECRET = 'admin-users-management-test-secret';

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
  const userModel = await import('@/shared/models/user');

  modules = { db, schema, userModel };
}

async function insertUser(id: string, email: string, name = id) {
  await modules.db().insert(modules.schema.user).values({ id, name, email });
  return { id, name, email };
}

async function insertRole(
  id: string,
  name: string,
  title: string,
  status = 'active'
) {
  await modules.db()
    .insert(modules.schema.role)
    .values({ id, name, title, status });
  return { id, name, title, status };
}

async function assignRole(
  id: string,
  userId: string,
  roleId: string,
  expiresAt?: Date
) {
  await modules.db()
    .insert(modules.schema.userRole)
    .values({ id, userId, roleId, expiresAt });
}

test.before(setupDb);

test('getUsers email filter matches case-insensitively and by substring', async () => {
  await insertUser('search_alice', 'Alice@Example.com', 'Alice');

  // Exact address in a different case must still match (S-12 regression).
  const exactDifferentCase = await modules.userModel.getUsers({
    email: 'alice@example.com',
  });
  assert.ok(
    exactDifferentCase.some((u: any) => u.id === 'search_alice'),
    'lower-cased exact email should match a mixed-case stored address'
  );

  // Uppercase partial keyword must match.
  const partialUpper = await modules.userModel.getUsers({ email: 'ALICE' });
  assert.ok(
    partialUpper.some((u: any) => u.id === 'search_alice'),
    'uppercase substring should match'
  );

  // A non-matching keyword returns no rows for this user.
  const noMatch = await modules.userModel.getUsers({
    email: 'no-such-person@nowhere.test',
  });
  assert.equal(
    noMatch.some((u: any) => u.id === 'search_alice'),
    false
  );
});

test('findUsersByExactEmail is case-insensitive but never substring, and flags ambiguity', async () => {
  await insertUser('exact_bob', 'Bob@Example.com', 'Bob');

  const hit = await modules.userModel.findUsersByExactEmail('bob@example.com');
  assert.equal(hit.length, 1);
  assert.equal(hit[0].id, 'exact_bob');

  // Substrings must NOT match — the lookup requires a full address.
  const partial = await modules.userModel.findUsersByExactEmail('bob');
  assert.deepEqual(partial, []);

  // Blank input is a no-op.
  assert.deepEqual(await modules.userModel.findUsersByExactEmail('   '), []);

  // Two rows whose emails are equal once lower-cased => ambiguous (limit 2).
  await insertUser('dup_upper', 'Dup@Example.com', 'Dup Upper');
  await insertUser('dup_lower', 'dup@example.com', 'Dup Lower');
  const ambiguous =
    await modules.userModel.findUsersByExactEmail('DUP@example.com');
  assert.equal(
    ambiguous.length,
    2,
    'ambiguous exact matches must be surfaced so callers can reject them'
  );
});

test('getUserRolesForUserIds batches active, non-expired roles per user', async () => {
  const u1 = await insertUser('roles_u1', 'roles-u1@example.com');
  const u2 = await insertUser('roles_u2', 'roles-u2@example.com');
  const u3 = await insertUser('roles_u3', 'roles-u3@example.com');

  const active1 = await insertRole('role_active_1', 'batch_active_1', 'Active 1');
  const active2 = await insertRole('role_active_2', 'batch_active_2', 'Active 2');
  await insertRole('role_disabled', 'batch_disabled', 'Disabled', 'disabled');

  await assignRole('ur_u1_a1', u1.id, active1.id);
  await assignRole('ur_u1_a2', u1.id, active2.id);
  // Expired assignment must be excluded.
  await assignRole('ur_u2_expired', u2.id, active1.id, new Date(Date.now() - 1000));
  // Disabled role must be excluded.
  await assignRole('ur_u2_disabled', u2.id, 'role_disabled');
  await assignRole('ur_u3_a1', u3.id, active1.id);

  const map = await modules.userModel.getUserRolesForUserIds([
    u1.id,
    u2.id,
    u3.id,
  ]);

  assert.deepEqual(
    (map.get(u1.id) ?? []).map((r: any) => r.id).sort(),
    ['role_active_1', 'role_active_2']
  );
  assert.equal(
    map.has(u2.id),
    false,
    'user with only expired/disabled roles yields no entry'
  );
  assert.deepEqual((map.get(u3.id) ?? []).map((r: any) => r.id), [
    'role_active_1',
  ]);

  // Empty input short-circuits.
  const empty = await modules.userModel.getUserRolesForUserIds([]);
  assert.equal(empty.size, 0);
});

test('user list page probes t.has and batches roles instead of per-row fan-out', async () => {
  const source = await readFile(join(process.cwd(), listPagePath), 'utf8');

  // S-14: the dead try/catch is replaced by an explicit t.has probe.
  assert.match(source, /t\.has\(/);
  assert.doesNotMatch(source, /try\s*\{\s*return t\(/);

  // S-16: single batched role query, no per-row getUserRoles call.
  assert.match(source, /getUserRolesForUserIds/);
  assert.doesNotMatch(source, /getUserRoles\(item\.id\)/);
  assert.doesNotMatch(source, /callback:\s*async\s*\(item: User\)/);

  // S-16: an "All" pill plus an active-state helper for the filter pills.
  assert.match(source, /list\.filters\.all/);
  assert.match(source, /pillClass\(/);

  // S-19: the id column truncates but keeps type:'copy' for the full value.
  assert.match(source, /item\.id\.slice\(0,\s*8\)/);
  assert.match(source, /title=\{item\.id\}/);
});

test('user edit page no longer renders the disabled upload_image field', async () => {
  const source = await readFile(join(process.cwd(), editPagePath), 'utf8');

  // R-4: removing the avatar field means the handler can no longer wipe it.
  assert.doesNotMatch(source, /type:\s*'upload_image'/);
  assert.doesNotMatch(source, /data\.get\('image'\)/);
  assert.doesNotMatch(source, /image:\s*image/);

  // Handler still re-reads the record server-side (no client snapshot trust).
  assert.match(source, /const\s+targetUser\s*=\s*await\s+findUserById\(id\)/);
  // Business errors return instead of throwing (masked in production).
  assert.doesNotMatch(source, /throw new Error/);
  assert.match(source, /status:\s*'error'\s*as const/);
});

test('quota lookup uses a unique case-insensitive exact match, not fuzzy search', async () => {
  const source = await readFile(join(process.cwd(), quotaActionsPath), 'utf8');

  assert.match(source, /findUsersByExactEmail/);
  assert.doesNotMatch(source, /getUsers\(/);
  // Reject 0 or >1 matches so we never adjust the wrong user's balance.
  assert.match(source, /matches\.length\s*!==\s*1/);
});

test('getUsers can list only users whose ledger still has unresolved entries', async () => {
  const stuck = await insertUser('users_ledger_stuck', 'stuck@ledger.test');
  const settled = await insertUser('users_ledger_settled', 'settled@ledger.test');

  await modules
    .db()
    .insert(modules.schema.apipoolLedgerEntry)
    .values([
      {
        id: 'users_ledger_stuck_row',
        portalUserId: stuck.id,
        operatorUserId: stuck.id,
        newapiUserId: 'remote_stuck',
        amountUsd: 10,
        source: 'manual_adjustment',
        status: 'reconciliation_required',
        executor: 'internal_quota_executor',
        reason: 'timed out',
      },
      {
        id: 'users_ledger_settled_row',
        portalUserId: settled.id,
        operatorUserId: settled.id,
        newapiUserId: 'remote_settled',
        amountUsd: 10,
        source: 'manual_adjustment',
        status: 'applied',
        executor: 'internal_quota_executor',
        reason: 'ok',
      },
    ]);

  const rows = await modules.userModel.getUsers({ unresolvedLedger: true });
  const ids = rows.map((row: any) => row.id);
  assert.ok(ids.includes(stuck.id), 'stuck user must be listed');
  assert.ok(!ids.includes(settled.id), 'settled user must not be listed');

  const count = await modules.userModel.getUsersCount({
    unresolvedLedger: true,
  });
  assert.equal(count, 1);

  // 不带该筛选时两人都在（避免筛选条件被永久挂上）
  const all = await modules.userModel.getUsers({});
  const allIds = all.map((row: any) => row.id);
  assert.ok(allIds.includes(stuck.id) && allIds.includes(settled.id));
});
