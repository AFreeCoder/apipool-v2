import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { createClient } from '@libsql/client';

const NEW_TABLES = [
  'portal_api_key',
  'model_route',
  'model_price_version',
  'runtime_credential',
  'wallet_account',
  'wallet_ledger',
  'request_ledger',
  'portal_admin_audit_log',
  'credential_retirement',
  'gateway_job_lock',
  'reconcile_orphan_observation',
];

test('schema.ts 单源：只 re-export schema.sqlite', async () => {
  const content = await readFile(
    join(process.cwd(), 'src/config/db/schema.ts'),
    'utf8'
  );
  const active = content
    .split('\n')
    .filter((line) => line.trim().startsWith('export'));
  assert.deepEqual(active, [`export * from './schema.sqlite';`]);
});

test('迁移 0012 建齐新表并保留存量补建语义', async () => {
  const dbPath = join(process.cwd(), '.tmp', 'schema-guard.db');
  await mkdir(join(process.cwd(), '.tmp'), { recursive: true });
  await rm(dbPath, { force: true });
  const client = createClient({ url: `file:${dbPath}` });
  const dir = join(process.cwd(), 'src/config/db/migrations_sqlite');
  const files = (await readdir(dir))
    .filter((file) => file.endsWith('.sql'))
    .sort();

  for (const file of files.filter((file) => !file.startsWith('0012'))) {
    await client.executeMultiple(await readFile(join(dir, file), 'utf8'));
  }
  await client.execute({
    sql: `INSERT INTO user (id, name, email, created_at, updated_at) VALUES ('u-legacy', 'legacy', 'legacy@t.dev', 1, 1)`,
  });
  const migration = files.find((file) => file.startsWith('0012'));
  assert.ok(migration, '0012 迁移文件存在');
  await client.executeMultiple(await readFile(join(dir, migration), 'utf8'));

  for (const table of NEW_TABLES) {
    const result = await client.execute({
      sql: `SELECT name FROM sqlite_master WHERE type='table' AND name=?`,
      args: [table],
    });
    assert.equal(result.rows.length, 1, `表 ${table} 存在`);
  }

  const columns = async (table: string) =>
    (await client.execute(`PRAGMA table_info(${table})`)).rows.map(
      (row: any) => row.name
    );
  assert.ok((await columns('portal_api_key')).includes('key_hash'));
  assert.ok((await columns('request_ledger')).includes('newapi_request_id'));
  assert.ok(
    (await columns('wallet_ledger')).includes('signed_amount_micro_usd')
  );
  assert.ok(
    (await columns('catalog_model_price')).includes(
      'base_cached_input_micro_usd'
    )
  );
  assert.ok((await columns('catalog_model')).includes('max_output_tokens'));

  const walletAccounts = await client.execute(
    `SELECT user_id, balance_micro_usd FROM wallet_account`
  );
  assert.equal(walletAccounts.rows.length, 1);
  assert.equal(walletAccounts.rows[0].user_id, 'u-legacy');
  assert.equal(Number(walletAccounts.rows[0].balance_micro_usd), 0);
  const locks = await client.execute(`SELECT id FROM gateway_job_lock`);
  assert.equal(locks.rows.length, 1);
  assert.equal(locks.rows[0].id, 'singleton');

  await client.execute({
    sql: `INSERT INTO request_ledger (id, user_id, portal_key_id, portal_group_id, portal_model_id, newapi_group, newapi_model_id, credential_id, route_version, price_version_id, endpoint, is_stream, status, created_at, updated_at)
          VALUES ('preq_x','u-legacy','k','g','m','ng','nm','c',1,'pv','chat_completions',0,'open',1,1)`,
  });
  await assert.rejects(
    client.execute(
      `UPDATE request_ledger SET status='settled' WHERE id='preq_x'`
    ),
    /CHECK|constraint/i,
    'settled 缺 request id/金额被 CHECK 拒绝'
  );

  await client.execute(
    `INSERT INTO request_ledger (id, user_id, portal_key_id, portal_group_id, portal_model_id, newapi_group, newapi_model_id, credential_id, route_version, price_version_id, endpoint, is_stream, status, created_at, updated_at)
     VALUES ('preq_y','u-legacy','k','g','m','ng','nm','c',1,'pv','chat_completions',0,'open',1,1)`
  );
  await client.execute(
    `UPDATE request_ledger SET newapi_request_id='rid-1' WHERE id='preq_x'`
  );
  await assert.rejects(
    client.execute(
      `UPDATE request_ledger SET newapi_request_id='rid-1' WHERE id='preq_y'`
    ),
    /UNIQUE|constraint/i
  );

  await client.execute(`PRAGMA foreign_keys = ON`);
  await client.execute(
    `INSERT INTO wallet_ledger (id, user_id, entry_type, signed_amount_micro_usd, balance_after_micro_usd, created_at)
     VALUES ('wl-1','u-legacy','recharge',1000000,1000000,1)`
  );
  await assert.rejects(
    client.execute(`DELETE FROM user WHERE id='u-legacy'`),
    /FOREIGN KEY|constraint/i,
    '删用户被 wallet_ledger 外键拒绝，历史流水完整保留'
  );
  client.close();
});
