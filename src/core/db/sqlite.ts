import { createClient, type Client } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';

import { envConfigs } from '@/config';
import { isCloudflareWorker } from '@/shared/lib/env';

// SQLite/libsql singleton (only used when DB_SINGLETON_ENABLED === 'true' and not in Workers)
let sqliteDbInstance: ReturnType<typeof drizzle> | null = null;

const LOCAL_SQLITE_BUSY_TIMEOUT_MS = 5_000;

/**
 * 本地 SQLite 需要 WAL 承载 Portal 与受控运维脚本的并发读写；busy_timeout
 * 则把短暂的单写者竞争交给 SQLite 排队，而不是立即抛出 SQLITE_BUSY。
 *
 * @libsql/client 在开启交互事务时会把主连接移交给事务，并为后续查询懒建
 * 新连接，因此 transaction/reconnect 后必须重新设置连接级 busy_timeout。
 * journal_mode=WAL 是文件级持久设置，只需在客户端初始化时确认一次。
 */
export function configureLocalSqliteClient(
  client: Client,
  databaseUrl: string
): Client {
  if (!databaseUrl.startsWith('file:')) return client;

  let ready: Promise<unknown> = client.executeMultiple(`
    PRAGMA busy_timeout=${LOCAL_SQLITE_BUSY_TIMEOUT_MS};
    PRAGMA journal_mode=WAL;
  `);

  const configureNextConnection = () => {
    ready = client.execute(
      `PRAGMA busy_timeout=${LOCAL_SQLITE_BUSY_TIMEOUT_MS}`
    );
  };

  return new Proxy(client, {
    get(target, property, receiver) {
      if (property === 'transaction') {
        return async (...args: Parameters<Client['transaction']>) => {
          await ready;
          const transaction = await target.transaction(...args);
          // transaction() 会分离当前连接；立即初始化后续查询将使用的新连接。
          configureNextConnection();
          await ready;
          return transaction;
        };
      }

      if (property === 'reconnect') {
        return async () => {
          await target.reconnect();
          configureNextConnection();
          await ready;
        };
      }

      if (property === 'close') {
        return () => target.close();
      }

      const value = Reflect.get(target, property, receiver);
      if (typeof value !== 'function') return value;

      return async (...args: unknown[]) => {
        await ready;
        return (value as (...input: unknown[]) => unknown).apply(target, args);
      };
    },
  }) as Client;
}

function createSqliteClient(
  databaseUrl: string,
  options: { authToken?: string }
) {
  return configureLocalSqliteClient(
    createClient({
      url: databaseUrl,
      ...options,
    }),
    databaseUrl
  );
}

// get sqlite db instance (works for both local sqlite file:... and turso/libsql://...)
export function getSqliteDb() {
  const databaseUrl = envConfigs.database_url;
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is not set');
  }

  // custom options
  const options: Record<string, string> = {};
  if (envConfigs.database_auth_token) {
    options.authToken = envConfigs.database_auth_token;
  }

  // In Cloudflare Workers, create new connection each time (avoid cross-request state)
  if (isCloudflareWorker) {
    const client = createSqliteClient(databaseUrl, options);
    return drizzle({ client });
  }

  // Singleton mode: reuse existing instance
  if (envConfigs.db_singleton_enabled === 'true') {
    if (sqliteDbInstance) return sqliteDbInstance;

    const client = createSqliteClient(databaseUrl, options);
    sqliteDbInstance = drizzle({ client });
    return sqliteDbInstance;
  }

  // Non-singleton mode: create new connection each time
  const client = createSqliteClient(databaseUrl, options);
  return drizzle({ client });
}
