import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createClient, type Client } from '@libsql/client';

import { configureLocalSqliteClient } from '@/core/db/sqlite';

function pragmaNumber(rows: unknown[], key: string) {
  const row = rows[0] as Record<string, unknown> | undefined;
  return Number(row?.[key]);
}

test('本地 SQLite 启用 WAL，并在事务切换连接后保留 busy timeout', async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), 'apipool-sqlite-runtime-')
  );
  const databaseUrl = `file:${path.join(directory, 'runtime.db')}`;
  const client = configureLocalSqliteClient(
    createClient({ url: databaseUrl }),
    databaseUrl
  );

  try {
    const journal = await client.execute('PRAGMA journal_mode');
    assert.equal(String(journal.rows[0]?.journal_mode).toLowerCase(), 'wal');

    const before = await client.execute('PRAGMA busy_timeout');
    assert.equal(pragmaNumber(before.rows, 'timeout'), 5_000);

    const transaction = await client.transaction();
    await transaction.execute('CREATE TABLE probe (id integer primary key)');
    await transaction.commit();

    const after = await client.execute('PRAGMA busy_timeout');
    assert.equal(pragmaNumber(after.rows, 'timeout'), 5_000);
  } finally {
    client.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('远程 libSQL 客户端不注入本地 SQLite PRAGMA', () => {
  const client = {
    executeMultiple: () => {
      throw new Error('不应执行本地 PRAGMA');
    },
  } as unknown as Client;

  assert.equal(
    configureLocalSqliteClient(client, 'libsql://example.invalid'),
    client
  );
});
