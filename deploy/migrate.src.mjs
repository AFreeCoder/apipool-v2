// 运行时数据库迁移：对 SQLite 文件建表/补结构。
// 由 Docker 构建期 esbuild 打包为 deploy/migrate.cjs，容器 entrypoint 在起服务前执行。
import { createClient } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { migrate } from 'drizzle-orm/libsql/migrator';

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('[migrate] DATABASE_URL is not set');
    process.exit(1);
  }

  const migrationsFolder = process.env.MIGRATIONS_DIR || './migrations_sqlite';
  const client = createClient({ url });
  const db = drizzle({ client });

  await migrate(db, { migrationsFolder });
  console.log('[migrate] migrations applied');
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('[migrate] migration failed:', err);
    process.exit(1);
  });
