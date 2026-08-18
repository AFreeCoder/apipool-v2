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

  for (const file of files.filter((file) => file < '0012_')) {
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

test('迁移 0013 将价格版本 map 化、等价迁移旧价并补齐账本 meter 列', async () => {
  const dbPath = join(process.cwd(), '.tmp', 'pricing-v2-schema-guard.db');
  await mkdir(join(process.cwd(), '.tmp'), { recursive: true });
  await rm(dbPath, { force: true });
  const client = createClient({ url: `file:${dbPath}` });
  const dir = join(process.cwd(), 'src/config/db/migrations_sqlite');
  const files = (await readdir(dir))
    .filter((file) => file.endsWith('.sql'))
    .sort();

  for (const file of files.filter((file) => file < '0013_')) {
    await client.executeMultiple(await readFile(join(dir, file), 'utf8'));
  }

  const group = await client.execute(
    `SELECT id FROM catalog_group ORDER BY id LIMIT 1`
  );
  assert.equal(group.rows.length, 1, '旧价格版本测试需要一条目录分组');
  await client.execute({
    sql: `
      INSERT INTO model_price_version (
        id, portal_group_id, portal_model_id, version, status,
        input_micro_usd_per_m, cached_input_micro_usd_per_m,
        cache_write_5m_micro_usd_per_m, cache_write_1h_micro_usd_per_m,
        output_micro_usd_per_m, newapi_ref_input_micro_usd_per_m,
        ref_newapi_group, source_note, published_by, created_at, updated_at
      ) VALUES (?, ?, 'legacy-model', 1, 'active', ?, ?, ?, ?, ?, ?, 'legacy-group', '保留备注', 'tester', 1, 2)
    `,
    args: [
      'pv-legacy',
      group.rows[0].id,
      2_500_000,
      1_250_000,
      3_125_000,
      5_000_000,
      10_000_000,
      2_000_000,
    ],
  });

  const migration = files.find((file) => file.startsWith('0013_'));
  assert.ok(migration, '0013 迁移文件存在');
  await client.executeMultiple(await readFile(join(dir, migration), 'utf8'));

  const columns = async (table: string) =>
    (await client.execute(`PRAGMA table_info(${table})`)).rows.map((row: any) =>
      String(row.name)
    );
  const priceColumns = await columns('model_price_version');
  assert.ok(priceColumns.includes('billing_scheme'));
  assert.ok(priceColumns.includes('rates_json'));
  assert.ok(priceColumns.includes('tiers_json'));
  assert.ok(priceColumns.includes('long_context_threshold_tokens'));
  assert.equal(priceColumns.includes('input_micro_usd_per_m'), false);
  assert.equal(priceColumns.includes('cached_input_micro_usd_per_m'), false);

  const migrated = await client.execute(
    `SELECT billing_scheme, rates_json, tiers_json, long_context_threshold_tokens,
            newapi_ref_input_micro_usd_per_m, ref_newapi_group, source_note
     FROM model_price_version WHERE id = 'pv-legacy'`
  );
  assert.equal(migrated.rows[0].billing_scheme, 'token');
  assert.deepEqual(JSON.parse(String(migrated.rows[0].rates_json)), {
    input: 2_500_000,
    cached_input: 1_250_000,
    cache_write_5m: 3_125_000,
    cache_write_1h: 5_000_000,
    output: 10_000_000,
  });
  assert.equal(migrated.rows[0].tiers_json, '{}');
  assert.equal(migrated.rows[0].long_context_threshold_tokens, null);
  assert.equal(
    Number(migrated.rows[0].newapi_ref_input_micro_usd_per_m),
    2_000_000
  );
  assert.equal(migrated.rows[0].ref_newapi_group, 'legacy-group');
  assert.equal(migrated.rows[0].source_note, '保留备注');

  const ledgerColumns = await columns('request_ledger');
  for (const column of [
    'billing_scheme',
    'cache_write_tokens',
    'image_input_tokens',
    'cached_image_input_tokens',
    'image_output_tokens',
    'sku_key',
    'unit_count',
    'long_context_applied',
    'billing_flags_json',
    'raw_usage_json',
    'web_search_count',
  ]) {
    assert.ok(ledgerColumns.includes(column), `request_ledger 含 ${column}`);
  }

  const integrity = await client.execute(`PRAGMA integrity_check`);
  assert.equal(integrity.rows[0].integrity_check, 'ok');
  const foreignKeys = await client.execute(`PRAGMA foreign_key_check`);
  assert.equal(foreignKeys.rows.length, 0);
  client.close();
});

test('迁移 0019 增加异步图片任务、所有权与调度索引', async () => {
  const dbPath = join(process.cwd(), '.tmp', 'gateway-task-schema-guard.db');
  await mkdir(join(process.cwd(), '.tmp'), { recursive: true });
  await rm(dbPath, { force: true });
  const client = createClient({ url: `file:${dbPath}` });
  const dir = join(process.cwd(), 'src/config/db/migrations_sqlite');
  const files = (await readdir(dir))
    .filter((file) => file.endsWith('.sql'))
    .sort();
  for (const file of files) {
    await client.executeMultiple(await readFile(join(dir, file), 'utf8'));
  }
  const columns = (
    await client.execute(`PRAGMA table_info(gateway_task)`)
  ).rows.map((row: any) => String(row.name));
  for (const column of [
    'request_ledger_id',
    'user_id',
    'portal_key_id',
    'newapi_task_id',
    'next_poll_at',
    'lease_expires_at',
    'terminal_evidence_json',
    'result_cache_json',
    'result_url_expires_at',
  ]) {
    assert.ok(columns.includes(column), `gateway_task 含 ${column}`);
  }
  const indexes = (
    await client.execute(`PRAGMA index_list(gateway_task)`)
  ).rows.map((row: any) => String(row.name));
  for (const index of [
    'uniq_gateway_task_request',
    'uniq_gateway_task_newapi_task',
    'idx_gateway_task_due',
    'idx_gateway_task_owner',
  ]) {
    assert.ok(indexes.includes(index), `gateway_task 含索引 ${index}`);
  }
  const integrity = await client.execute(`PRAGMA integrity_check`);
  assert.equal(integrity.rows[0].integrity_check, 'ok');
  client.close();
});
