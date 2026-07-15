# 批次一：地基（Task 1–11）

> 隶属 [PLAN.md](PLAN.md)。全局约束、共享接口契约、通用工序见 PLAN.md，本文件不重复。
> 每个任务开工前先读 PLAN.md 的 Global Constraints 与本任务的 Interfaces。

---

### Task 1: 迁移 0012 —— 十一张新表 + catalog 扩展列 + CHECK + 存量补建

**Files:**
- Modify: `src/config/db/schema.sqlite.ts`（现 1146 行，末尾追加；`catalogModel` 定义在 521-541、`catalogModelPrice` 在 543-586 内加列）
- Create: `src/config/db/migrations_sqlite/0012_portal_gateway_v1.sql`（由 `pnpm db:generate --name portal_gateway_v1` 生成后手工追加数据语句）
- Test: `tests/gateway/schema-guard.test.ts`

**Interfaces:**
- Consumes: 既有 `table`/`sqliteNowMs` 别名（`schema.sqlite.ts:1-15`）、部分唯一索引先例（`schema.sqlite.ts:794-796` 的 `.where(sql\`...\`)`）。
- Produces: drizzle 导出常量 `portalApiKey`、`modelRoute`、`modelPriceVersion`、`runtimeCredential`、`walletAccount`、`walletLedger`、`requestLedger`、`portalAdminAuditLog`、`credentialRetirement`、`gatewayJobLock`、`reconcileOrphanObservation`；`catalogModel.maxOutputTokens`；`catalogModelPrice.{baseCachedInputMicroUsd,baseCacheWrite5mMicroUsd,baseCacheWrite1hMicroUsd,cachePriceNote}`。后续所有任务经 `@/config/db/schema` 引用。

> 设计对照：§3 全部字段；§3.9 说"4 个可空 cache 基准价列"，但五维价格闭合只需 3 个 cache 列（cached_read / cache_write_5m / cache_write_1h），**按 3 列落地**；若 Spike S2 发现 New API pricing 存在第 4 个 cache 维度再补列。`gateway_job_lock` 未列入 §3 的"8 张核心表"，但 §10.1 明确要求 worker 级 DB 锁，随本迁移一并建。
>
> 资金留痕（评审 F2）：`wallet_account`/`wallet_ledger` 的 user FK **不设 cascade**（NO ACTION）——持有资金记录的用户不可被硬删除。已实测 `@libsql/client` 默认 `PRAGMA foreign_keys = 1`（2026-07-14，与原生 SQLite 默认 OFF 不同），生产运行时 FK 强制生效；测试中仍显式 `PRAGMA foreign_keys = ON` 防未来默认值变化。`portal_api_key`/`runtime_credential` 的 cascade **有意保留**：非资金表、沿仓库既有惯例，且任何产生过流水的用户已被 `wallet_ledger` 的 NO ACTION 挡住删除，这些 cascade 对其永不触达；`request_ledger` 无 FK（账本留痕，同 F2 理由）。

- [ ] **Step 1: 写失败的 schema 守卫测试**

```ts
// tests/gateway/schema-guard.test.ts
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { createClient } from '@libsql/client';
import { mkdir, readdir, rm } from 'node:fs/promises';

const NEW_TABLES = [
  'portal_api_key', 'model_route', 'model_price_version', 'runtime_credential',
  'wallet_account', 'wallet_ledger', 'request_ledger', 'portal_admin_audit_log',
  'credential_retirement', 'gateway_job_lock', 'reconcile_orphan_observation',
];

test('schema.ts 单源：只 re-export schema.sqlite', async () => {
  const content = await readFile(join(process.cwd(), 'src/config/db/schema.ts'), 'utf8');
  const active = content.split('\n').filter((l) => l.trim().startsWith('export'));
  assert.deepEqual(active, [`export * from './schema.sqlite';`]);
});

test('迁移 0012 建齐新表并保留存量补建语义', async () => {
  const dbPath = join(process.cwd(), '.tmp', 'schema-guard.db');
  await mkdir(join(process.cwd(), '.tmp'), { recursive: true });
  await rm(dbPath, { force: true });
  const client = createClient({ url: `file:${dbPath}` });
  const dir = join(process.cwd(), 'src/config/db/migrations_sqlite');
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  // 先跑 0000-0011，插一个存量用户，再跑 0012 —— 验证 wallet_account 批量补建
  for (const f of files.filter((f) => !f.startsWith('0012'))) {
    await client.executeMultiple(await readFile(join(dir, f), 'utf8'));
  }
  await client.execute({
    sql: `INSERT INTO user (id, name, email, created_at, updated_at) VALUES ('u-legacy', 'legacy', 'legacy@t.dev', 1, 1)`,
  });
  const m0012 = files.find((f) => f.startsWith('0012'));
  assert.ok(m0012, '0012 迁移文件存在');
  await client.executeMultiple(await readFile(join(dir, m0012!), 'utf8'));

  for (const t of NEW_TABLES) {
    const r = await client.execute({ sql: `SELECT name FROM sqlite_master WHERE type='table' AND name=?`, args: [t] });
    assert.equal(r.rows.length, 1, `表 ${t} 存在`);
  }
  // 关键列（生产只读验证同款语句）
  const cols = async (t: string) => (await client.execute(`PRAGMA table_info(${t})`)).rows.map((r: any) => r.name);
  assert.ok((await cols('portal_api_key')).includes('key_hash'));
  assert.ok((await cols('request_ledger')).includes('newapi_request_id'));
  assert.ok((await cols('wallet_ledger')).includes('signed_amount_micro_usd'));
  assert.ok((await cols('catalog_model_price')).includes('base_cached_input_micro_usd'));
  assert.ok((await cols('catalog_model')).includes('max_output_tokens'));
  // 存量用户已补建 wallet_account、job lock 单行已播种
  const wa = await client.execute(`SELECT user_id, balance_micro_usd FROM wallet_account`);
  assert.equal(wa.rows.length, 1);
  assert.equal(wa.rows[0].user_id, 'u-legacy');
  assert.equal(Number(wa.rows[0].balance_micro_usd), 0);
  const lock = await client.execute(`SELECT id FROM gateway_job_lock`);
  assert.equal(lock.rows.length, 1);
  assert.equal(lock.rows[0].id, 'singleton');
  // CHECK：settled 无 request id 必须被拒绝
  await client.execute({
    sql: `INSERT INTO request_ledger (id, user_id, portal_key_id, portal_group_id, portal_model_id, newapi_group, newapi_model_id, credential_id, route_version, price_version_id, endpoint, is_stream, status, created_at, updated_at)
          VALUES ('preq_x','u-legacy','k','g','m','ng','nm','c',1,'pv','chat_completions',0,'open',1,1)`,
  });
  await assert.rejects(
    client.execute(`UPDATE request_ledger SET status='settled' WHERE id='preq_x'`),
    /CHECK|constraint/i,
    'settled 缺 request id/金额被 CHECK 拒绝'
  );
  // 唯一索引：newapi_request_id 允许多个 NULL、值唯一
  await client.execute(`INSERT INTO request_ledger (id, user_id, portal_key_id, portal_group_id, portal_model_id, newapi_group, newapi_model_id, credential_id, route_version, price_version_id, endpoint, is_stream, status, created_at, updated_at)
          VALUES ('preq_y','u-legacy','k','g','m','ng','nm','c',1,'pv','chat_completions',0,'open',1,1)`);
  await client.execute(`UPDATE request_ledger SET newapi_request_id='rid-1' WHERE id='preq_x'`);
  await assert.rejects(
    client.execute(`UPDATE request_ledger SET newapi_request_id='rid-1' WHERE id='preq_y'`),
    /UNIQUE|constraint/i
  );
  // 资金留痕（评审 F2）：持有钱包流水的用户不可被硬删除（外键 NO ACTION 挡住级联清账）
  await client.execute(`PRAGMA foreign_keys = ON`);
  await client.execute(`INSERT INTO wallet_ledger (id, user_id, entry_type, signed_amount_micro_usd, balance_after_micro_usd, created_at)
          VALUES ('wl-1','u-legacy','recharge',1000000,1000000,1)`);
  await assert.rejects(
    client.execute(`DELETE FROM user WHERE id='u-legacy'`),
    /FOREIGN KEY|constraint/i,
    '删用户被 wallet_ledger 外键拒绝，历史流水完整保留'
  );
  client.close();
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `NODE_OPTIONS='--conditions react-server' tsx --test tests/gateway/schema-guard.test.ts`
Expected: FAIL —— `0012 迁移文件存在` 断言失败。

- [ ] **Step 3: 在 `schema.sqlite.ts` 末尾追加十张表定义、在既有两表内加列**

在 `catalogModel`（521-541）字段区加：

```ts
    // 展示用最大输出（发布最坏成本计算要求非空，见 routing-admin）
    maxOutputTokens: integer('max_output_tokens'),
```

在 `catalogModelPrice`（543-586）字段区加（放在 `baseOutputMicroUsd` 之后）：

```ts
    // cache 维度基准价（micro-USD / 1M tokens；管理员锁定+复核的成本快照，设计 §5.3/§9.3）
    baseCachedInputMicroUsd: integer('base_cached_input_micro_usd'),
    baseCacheWrite5mMicroUsd: integer('base_cache_write_5m_micro_usd'),
    baseCacheWrite1hMicroUsd: integer('base_cache_write_1h_micro_usd'),
    cachePriceNote: text('cache_price_note'),
```

文件末尾追加（`check` 需并入第 2 行的 `drizzle-orm/sqlite-core` import）：

```ts
// ---------------- Portal Gateway v1（portal-newapi-routing-billing-decoupling，设计 §3） ----------------

export const portalApiKey = table(
  'portal_api_key',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
    groupId: text('group_id').notNull().references(() => catalogGroup.id),
    keyHash: text('key_hash').notNull(),
    keyPrefix: text('key_prefix').notNull(),
    status: text('status').notNull().default('active'), // active / disabled / deleted
    name: text('name').notNull(),
    lastUsedAt: integer('last_used_at', { mode: 'timestamp_ms' }),
    disabledAt: integer('disabled_at', { mode: 'timestamp_ms' }),
    deletedAt: integer('deleted_at', { mode: 'timestamp_ms' }),
    revokedReason: text('revoked_reason'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).default(sqliteNowMs).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .default(sqliteNowMs)
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex('uniq_portal_api_key_hash').on(table.keyHash),
    index('idx_portal_api_key_user_status').on(table.userId, table.status),
    uniqueIndex('uniq_portal_api_key_user_name_live')
      .on(table.userId, table.name)
      .where(sql`${table.status} != 'deleted'`),
  ]
);

export const modelRoute = table(
  'model_route',
  {
    id: text('id').primaryKey(),
    portalGroupId: text('portal_group_id').notNull().references(() => catalogGroup.id),
    portalModelId: text('portal_model_id').notNull(), // = catalog_model.model_id（恒等）
    newapiGroup: text('newapi_group').notNull(), // 发布快照
    newapiModelId: text('newapi_model_id').notNull(), // 默认同 portal_model_id
    version: integer('version').notNull(),
    status: text('status').notNull().default('active'), // active / retired
    publishedBy: text('published_by').notNull(),
    retiredAt: integer('retired_at', { mode: 'timestamp_ms' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).default(sqliteNowMs).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .default(sqliteNowMs)
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex('uniq_model_route_active')
      .on(table.portalGroupId, table.portalModelId)
      .where(sql`${table.status} = 'active'`), // 需求 9.2：同二元组最多一个 active
    uniqueIndex('uniq_model_route_version').on(table.portalGroupId, table.portalModelId, table.version),
  ]
);

export const modelPriceVersion = table(
  'model_price_version',
  {
    id: text('id').primaryKey(),
    portalGroupId: text('portal_group_id').notNull().references(() => catalogGroup.id),
    portalModelId: text('portal_model_id').notNull(),
    version: integer('version').notNull(),
    status: text('status').notNull().default('active'), // active / retired
    // 五维显式单价（micro-USD / 1M tokens），发布时全部落库、结算永不运行时推导
    inputMicroUsdPerM: integer('input_micro_usd_per_m').notNull(),
    cachedInputMicroUsdPerM: integer('cached_input_micro_usd_per_m').notNull(),
    cacheWrite5mMicroUsdPerM: integer('cache_write_5m_micro_usd_per_m').notNull(),
    cacheWrite1hMicroUsdPerM: integer('cache_write_1h_micro_usd_per_m').notNull(),
    outputMicroUsdPerM: integer('output_micro_usd_per_m').notNull(),
    // 发布参照快照（勘误 E7 / 评审 R3-F7）：五维 New API 成本参照全部版本化锁定——
    // catalog 基准价是活表，历史请求的金额层对账（§10.4 五桶×ref 公式）只允许读本快照
    newapiRefInputMicroUsdPerM: integer('newapi_ref_input_micro_usd_per_m'),
    newapiRefOutputMicroUsdPerM: integer('newapi_ref_output_micro_usd_per_m'),
    newapiRefCachedInputMicroUsdPerM: integer('newapi_ref_cached_input_micro_usd_per_m'),
    newapiRefCacheWrite5mMicroUsdPerM: integer('newapi_ref_cache_write_5m_micro_usd_per_m'),
    newapiRefCacheWrite1hMicroUsdPerM: integer('newapi_ref_cache_write_1h_micro_usd_per_m'),
    // ref 参照分组（勘误 E8 / 评审 R4-F2）：五维 ref 按哪个 New API 分组倍率锁定——
    // 路由发布目标分组变化时据此判定 active price 是否需重发（方向门禁跟随实际路由目标）
    refNewapiGroup: text('ref_newapi_group'),
    sourceNote: text('source_note'),
    publishedBy: text('published_by').notNull(),
    retiredAt: integer('retired_at', { mode: 'timestamp_ms' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).default(sqliteNowMs).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .default(sqliteNowMs)
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex('uniq_model_price_version_active')
      .on(table.portalGroupId, table.portalModelId)
      .where(sql`${table.status} = 'active'`),
    uniqueIndex('uniq_model_price_version_version').on(table.portalGroupId, table.portalModelId, table.version),
  ]
);

export const runtimeCredential = table(
  'runtime_credential',
  {
    id: text('id').primaryKey(),
    portalUserId: text('portal_user_id').notNull().references(() => user.id, { onDelete: 'cascade' }),
    newapiGroup: text('newapi_group').notNull(),
    newapiUserId: text('newapi_user_id'), // 冗余快照（审计/归因）
    remoteName: text('remote_name').notNull(), // rk_{sha256(userId:group)[:24]}，可重算收编
    newapiTokenId: text('newapi_token_id'),
    tokenEnc: text('token_enc'), // AES-256-GCM（crypto.ts）
    keyMasked: text('key_masked'),
    status: text('status').notNull().default('pending'), // pending / active / disabled / invalid
    lastUsedAt: integer('last_used_at', { mode: 'timestamp_ms' }),
    lastError: text('last_error'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).default(sqliteNowMs).notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .default(sqliteNowMs)
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex('uniq_runtime_credential_scope').on(table.portalUserId, table.newapiGroup), // 需求 9.3
    index('idx_runtime_credential_user_status').on(table.portalUserId, table.status),
    index('idx_runtime_credential_status').on(table.status), // worker 扫 pending/invalid
  ]
);

export const walletAccount = table('wallet_account', {
  // 资金留痕：不设 cascade（SQLite 默认 NO ACTION）——持有钱包/流水的用户不可被硬删除（评审 F2）
  userId: text('user_id')
    .primaryKey()
    .references(() => user.id),
  balanceMicroUsd: integer('balance_micro_usd').notNull().default(0), // 不变量 = Σ wallet_ledger.signed_amount
  riskLimitOverride: integer('risk_limit_override'),
  frozenAt: integer('frozen_at', { mode: 'timestamp_ms' }),
  freezeReason: text('freeze_reason'), // overdraft_auto / manual / refund_in_progress
  frozenBy: text('frozen_by'),
  createdAt: integer('created_at', { mode: 'timestamp_ms' }).default(sqliteNowMs).notNull(),
  updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
    .default(sqliteNowMs)
    .$onUpdate(() => new Date())
    .notNull(),
});

// append-only：无 updatedAt、任何代码不得 UPDATE 本表（grep 守卫见 Task 8）；
// FK 无 cascade（NO ACTION）——资金流水永不随用户删除消失（评审 F2）
export const walletLedger = table(
  'wallet_ledger',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull().references(() => user.id),
    entryType: text('entry_type').notNull(), // recharge / request_charge / manual_adjustment
    signedAmountMicroUsd: integer('signed_amount_micro_usd').notNull(),
    balanceAfterMicroUsd: integer('balance_after_micro_usd').notNull(), // 事务内快照
    requestLedgerId: text('request_ledger_id'),
    orderNo: text('order_no'),
    idempotencyKey: text('idempotency_key'),
    operatorUserId: text('operator_user_id'),
    reason: text('reason'), // manual_adjustment 必填（服务层校验）
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).default(sqliteNowMs).notNull(),
  },
  (table) => [
    uniqueIndex('uniq_wallet_ledger_request_charge')
      .on(table.requestLedgerId)
      .where(sql`${table.entryType} = 'request_charge'`), // 同请求最多一条扣费
    uniqueIndex('uniq_wallet_ledger_recharge_order')
      .on(table.orderNo)
      .where(sql`${table.entryType} = 'recharge'`),
    uniqueIndex('uniq_wallet_ledger_idempotency').on(table.idempotencyKey),
    index('idx_wallet_ledger_user_created').on(table.userId, table.createdAt),
    check('ck_wallet_ledger_nonzero', sql`${table.signedAmountMicroUsd} != 0`),
  ]
);

export const requestLedger = table(
  'request_ledger',
  {
    id: text('id').primaryKey(), // preq_{uuidv7}，对外错误体透出
    newapiRequestId: text('newapi_request_id'), // X-Oneapi-Request-Id；需求 9.6 唯一键
    userId: text('user_id').notNull(),
    portalKeyId: text('portal_key_id').notNull(),
    portalGroupId: text('portal_group_id').notNull(),
    portalModelId: text('portal_model_id').notNull(),
    newapiGroup: text('newapi_group').notNull(),
    newapiModelId: text('newapi_model_id').notNull(),
    credentialId: text('credential_id').notNull(),
    routeVersion: integer('route_version').notNull(),
    priceVersionId: text('price_version_id').notNull(), // 锁定快照（需求 7.2.4/7.8）
    endpoint: text('endpoint').notNull(),
    isStream: integer('is_stream', { mode: 'boolean' }).notNull().default(false),
    httpStatus: integer('http_status'),
    errorCode: text('error_code'),
    streamAborted: integer('stream_aborted', { mode: 'boolean' }),
    status: text('status').notNull().default('open'), // open / pending_backfill / settled / failed_unbilled
    resolvedAt: integer('resolved_at', { mode: 'timestamp_ms' }), // 卡住/孤儿人工闭环
    respondedAt: integer('responded_at', { mode: 'timestamp_ms' }),
    finishedAt: integer('finished_at', { mode: 'timestamp_ms' }),
    settledAt: integer('settled_at', { mode: 'timestamp_ms' }),
    uncachedInputTokens: integer('uncached_input_tokens'),
    cachedReadTokens: integer('cached_read_tokens'),
    cacheWrite5mTokens: integer('cache_write_5m_tokens'),
    cacheWrite1hTokens: integer('cache_write_1h_tokens'),
    outputTokens: integer('output_tokens'),
    reasoningTokens: integer('reasoning_tokens'), // 信息性，不独立计价
    usageSource: text('usage_source'), // response / log_backfill
    chargedMicroUsd: integer('charged_micro_usd'),
    backfillAttempts: integer('backfill_attempts').notNull().default(0),
    nextBackfillAt: integer('next_backfill_at', { mode: 'timestamp_ms' }),
    lastBackfillError: text('last_backfill_error'),
    newapiQuota: integer('newapi_quota'),
    newapiPromptTokens: integer('newapi_prompt_tokens'),
    newapiCompletionTokens: integer('newapi_completion_tokens'),
    newapiTokenName: text('newapi_token_name'),
    reconcileStatus: text('reconcile_status').notNull().default('pending'),
    // pending / matched / token_mismatch / amount_mismatch / explained / waived_by_failure
    reconciledAt: integer('reconciled_at', { mode: 'timestamp_ms' }),
    reconcileNote: text('reconcile_note'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).default(sqliteNowMs).notNull(), // 准入时刻
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .default(sqliteNowMs)
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    uniqueIndex('uniq_request_ledger_newapi_request').on(table.newapiRequestId),
    index('idx_request_ledger_risk')
      .on(table.userId)
      .where(sql`${table.status} IN ('open','pending_backfill')`), // 风险占用 COUNT = O(未决数)
    index('idx_request_ledger_backfill').on(table.status, table.nextBackfillAt),
    index('idx_request_ledger_user_created').on(table.userId, table.createdAt),
    index('idx_request_ledger_reconcile').on(table.reconcileStatus),
    check(
      'ck_request_ledger_settled',
      sql`${table.status} != 'settled' OR (${table.newapiRequestId} IS NOT NULL AND ${table.chargedMicroUsd} IS NOT NULL)`
    ),
  ]
);

export const portalAdminAuditLog = table(
  'portal_admin_audit_log',
  {
    id: text('id').primaryKey(),
    action: text('action').notNull(), // routing.publish / price.publish / wallet.adjust / wallet.freeze / …（设计 §3.7）
    operatorUserId: text('operator_user_id').notNull(),
    targetType: text('target_type').notNull(),
    targetId: text('target_id'),
    beforeJson: text('before_json'), // 已脱敏
    afterJson: text('after_json'),
    reason: text('reason'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).default(sqliteNowMs).notNull(),
  },
  (table) => [
    index('idx_portal_admin_audit_action_created').on(table.action, table.createdAt),
    index('idx_portal_admin_audit_target').on(table.targetType, table.targetId),
  ]
);

// 简单待禁用列表（串行创建下不是状态机，设计 §3.8）
export const credentialRetirement = table(
  'credential_retirement',
  {
    id: text('id').primaryKey(),
    credentialId: text('credential_id')
      .notNull()
      .references(() => runtimeCredential.id),
    newapiTokenId: text('newapi_token_id').notNull(),
    reason: text('reason').notNull(), // rotate / user_disable / invalid
    disabledAt: integer('disabled_at', { mode: 'timestamp_ms' }), // 空 = 待处理
    lastError: text('last_error'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).default(sqliteNowMs).notNull(),
  },
  (table) => [index('idx_credential_retirement_pending').on(table.disabledAt)]
);

// worker 级单行锁（防 compose up 新旧容器并存，设计 §10.1）+ 对账水位持久化
export const gatewayJobLock = table('gateway_job_lock', {
  id: text('id').primaryKey(), // 恒为 'singleton'
  holderId: text('holder_id'),
  heartbeatAt: integer('heartbeat_at', { mode: 'timestamp_ms' }),
  acquiredAt: integer('acquired_at', { mode: 'timestamp_ms' }),
  reconcileWatermarkAt: integer('reconcile_watermark_at', { mode: 'timestamp_ms' }), // reconcile_worker 批量同步扫描水位
});

// 远端孤儿消费观测表（policy B 可见性，勘误 E6 / 评审 R2-F4）：
// request_ledger 的非空快照（portal_key_id/route_version/price_version_id…）在孤儿场景原理上不可恢复，
// 故观测行落独立表——字段集 = 设计 §10.2 列举的可恢复集合；不扣用户、不进主账本。
export const reconcileOrphanObservation = table(
  'reconcile_orphan_observation',
  {
    id: text('id').primaryKey(),
    newapiRequestId: text('newapi_request_id').notNull(), // 唯一幂等键（同一孤儿只观测一次）
    portalUserId: text('portal_user_id'), // rk_ 名反查 runtime_credential 归因；反查失败留 null
    newapiGroup: text('newapi_group'),
    newapiModelId: text('newapi_model_id'),
    credentialId: text('credential_id'),
    tokenName: text('token_name').notNull(), // 原始归因证据（远端日志 token_name）
    newapiQuota: integer('newapi_quota'),
    newapiPromptTokens: integer('newapi_prompt_tokens'),
    newapiCompletionTokens: integer('newapi_completion_tokens'),
    logCreatedAt: integer('log_created_at', { mode: 'timestamp_ms' }),
    resolvedAt: integer('resolved_at', { mode: 'timestamp_ms' }), // 人工闭环（核实为应收 → 手工 manual_adjustment 后置位）
    note: text('note'),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).default(sqliteNowMs).notNull(),
  },
  (table) => [
    uniqueIndex('uniq_orphan_observation_request').on(table.newapiRequestId),
    index('idx_orphan_observation_user').on(table.portalUserId),
    index('idx_orphan_observation_open').on(table.resolvedAt),
  ]
);
```

- [ ] **Step 4: 生成迁移并手工追加数据语句**

Run: `pnpm db:generate --name portal_gateway_v1`
Expected: 生成 `src/config/db/migrations_sqlite/0012_portal_gateway_v1.sql` + `meta/0012_snapshot.json`，`meta/_journal.json` 追加 `idx:12, tag:"0012_portal_gateway_v1"`。

人工核对生成 SQL：11 张 `CREATE TABLE`（含两处 `CHECK`）、部分唯一索引带 `WHERE` 子句、`ALTER TABLE catalog_model ADD max_output_tokens`、`ALTER TABLE catalog_model_price ADD …` ×4。若 drizzle 未生成 CHECK（版本行为差异），手工把 CHECK 写进 CREATE TABLE 语句内（SQLite 不支持 ALTER 加 CHECK，只能改建表语句）。

然后在 0012 文件末尾**追加**（0005/0011 手写数据迁移先例）：

```sql
--> statement-breakpoint
INSERT INTO `gateway_job_lock` (`id`) VALUES ('singleton');--> statement-breakpoint
INSERT INTO `wallet_account` (`user_id`, `balance_micro_usd`, `created_at`, `updated_at`)
SELECT `id`, 0,
  (cast((julianday('now') - 2440587.5)*86400000 as integer)),
  (cast((julianday('now') - 2440587.5)*86400000 as integer))
FROM `user`
WHERE NOT EXISTS (SELECT 1 FROM `wallet_account` wa WHERE wa.`user_id` = `user`.`id`);
```

- [ ] **Step 5: 跑测试确认通过**

Run: `NODE_OPTIONS='--conditions react-server' tsx --test tests/gateway/schema-guard.test.ts`
Expected: PASS（全部断言）。再跑 `pnpm test` 确认存量测试（尤其 `tests/newapi-bridge/billing-ledger.test.ts`，它顺序执行全部迁移）不回归。

- [ ] **Step 6: Commit**

```bash
git add src/config/db/schema.sqlite.ts src/config/db/migrations_sqlite/ tests/gateway/schema-guard.test.ts
git commit -m "feat(gateway): 新增网关解耦十张核心表与 catalog 扩展列（迁移 0012）"
```

---

### Task 2: proxy.ts matcher 排除 /v1 + 守卫测试

**Files:**
- Modify: `src/proxy.ts:87-89`
- Test: `tests/gateway/proxy-matcher.test.ts`

**Interfaces:** 无产出接口；守卫 `/v1/*` 永不进 next-intl middleware（设计 §0#1 代码硬坑）。

- [ ] **Step 1: 写失败测试**（读文件文本抽 matcher，避免 import next 运行时依赖）

```ts
// tests/gateway/proxy-matcher.test.ts
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

async function loadMatcher(): Promise<RegExp> {
  const src = await readFile(join(process.cwd(), 'src/proxy.ts'), 'utf8');
  const m = src.match(/matcher:\s*'([^']+)'/);
  assert.ok(m, 'proxy.ts 含 matcher 字符串');
  return new RegExp(`^${m![1]}$`);
}

test('matcher 不吞 /v1（网关路径不得进 intl middleware）', async () => {
  const re = await loadMatcher();
  assert.equal(re.test('/v1/chat/completions'), false);
  assert.equal(re.test('/v1/messages'), false);
  assert.equal(re.test('/v1/models'), false);
});

test('matcher 仍覆盖门户页面路径', async () => {
  const re = await loadMatcher();
  assert.equal(re.test('/dashboard'), true);
  assert.equal(re.test('/zh/models'), true);
  assert.equal(re.test('/api/apipool/keys'), false); // 既有排除不回归
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `NODE_OPTIONS='--conditions react-server' tsx --test tests/gateway/proxy-matcher.test.ts`
Expected: FAIL —— `/v1/chat/completions` 被现 matcher 命中（返回 true）。

- [ ] **Step 3: 修改 matcher**（`src/proxy.ts:87-89`）

```ts
export const config = {
  matcher: '/((?!api|v1|trpc|_next|_vercel|.*\\..*).*)',
};
```

- [ ] **Step 4: 跑测试确认通过**；Run 同上，Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/proxy.ts tests/gateway/proxy-matcher.test.ts
git commit -m "fix(gateway): proxy matcher 排除 /v1 防 next-intl 吞网关路径"
```

---

### Task 3: env 接线 + `gateway/lib/config.ts`

**Files:**
- Create: `src/features/gateway/lib/config.ts`
- Modify: `.env.example`（New API 段之后新增 Gateway/Wallet 段）、`deploy/env.production.example`
- Test: `tests/gateway/config.test.ts`

**Interfaces:**
- Produces: PLAN.md 契约的 `gatewayConfig()` / `walletLedgerWriteEnabled()` / `walletDisplayEnabled()` / `checkoutEnabled()`。
- 读取模式：直读 `process.env`（`crypto.ts:20-26` 先例），**每次调用现读**（便于测试改 env；无缓存）。
- 注意：compose allowlist 修改延后到 Task 26 统一做（同一文件集中改一次），本任务只改两个 example 文件。

- [ ] **Step 1: 写失败测试**

```ts
// tests/gateway/config.test.ts
import assert from 'node:assert/strict';
import test from 'node:test';

test('gatewayConfig 默认值与 env 覆盖', async () => {
  delete process.env.GATEWAY_RISK_SLOT_LIMIT;
  const { gatewayConfig, walletLedgerWriteEnabled, checkoutEnabled } = await import('@/features/gateway/lib/config');
  assert.equal(gatewayConfig().riskSlotLimit, 10);
  assert.equal(gatewayConfig().overdraftFreezeMicroUsd, 10_000_000);
  assert.equal(gatewayConfig().maxBodyBytes, 26_214_400);
  assert.equal(gatewayConfig().parseBufferMax, 33_554_432);
  assert.equal(gatewayConfig().firstByteTimeoutMs, 120_000);
  process.env.GATEWAY_RISK_SLOT_LIMIT = '25';
  assert.equal(gatewayConfig().riskSlotLimit, 25);
  process.env.GATEWAY_RISK_SLOT_LIMIT = 'garbage';
  assert.equal(gatewayConfig().riskSlotLimit, 10, '非法值回退默认');
  assert.equal(walletLedgerWriteEnabled(), false, 'wallet 默认 dormant');
  process.env.WALLET_LEDGER_WRITE_ENABLED = 'true';
  assert.equal(walletLedgerWriteEnabled(), true);
  delete process.env.WALLET_LEDGER_WRITE_ENABLED;
  // 评审 R16-F1：checkout fail-closed——仅精确 'true' 开放
  delete process.env.APIPOOL_CHECKOUT_ENABLED;
  assert.equal(checkoutEnabled(), false, '缺失 → 关闭（fail-closed）');
  process.env.APIPOOL_CHECKOUT_ENABLED = '';
  assert.equal(checkoutEnabled(), false, '空值 → 关闭');
  process.env.APIPOOL_CHECKOUT_ENABLED = 'yes';
  assert.equal(checkoutEnabled(), false, '非法值 → 关闭');
  process.env.APIPOOL_CHECKOUT_ENABLED = 'true';
  assert.equal(checkoutEnabled(), true, '仅精确 true → 开放');
  process.env.APIPOOL_CHECKOUT_ENABLED = 'false';
  assert.equal(checkoutEnabled(), false);
  delete process.env.APIPOOL_CHECKOUT_ENABLED;
});
```

- [ ] **Step 2: 跑测试确认失败**（模块不存在）。

- [ ] **Step 3: 实现 `src/features/gateway/lib/config.ts`**

```ts
// 网关运行时配置：直读 process.env（先例 crypto.ts getSecret），不进 envConfigs，避免双源。
function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : fallback;
}

function boolEnv(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  return raw === 'true';
}

export function gatewayConfig() {
  return {
    riskSlotLimit: intEnv('GATEWAY_RISK_SLOT_LIMIT', 10),
    overdraftFreezeMicroUsd: intEnv('GATEWAY_OVERDRAFT_FREEZE_MICRO_USD', 10_000_000),
    maxBodyBytes: intEnv('GATEWAY_MAX_BODY_BYTES', 26_214_400),
    maxInflight: intEnv('GATEWAY_MAX_INFLIGHT', 16), // 评审 R13-F1：内存上限=inflight×maxBody，默认 16×25MB≈400MB
    parseBufferMax: intEnv('GATEWAY_PARSE_BUFFER_MAX', 33_554_432),
    firstByteTimeoutMs: intEnv('GATEWAY_FIRST_BYTE_TIMEOUT_MS', 120_000),
    nonstreamTotalTimeoutMs: intEnv('GATEWAY_NONSTREAM_TOTAL_TIMEOUT_MS', 300_000),
    streamIdleTimeoutMs: intEnv('GATEWAY_STREAM_IDLE_TIMEOUT_MS', 180_000),
    hardTimeoutMs: intEnv('GATEWAY_HARD_TIMEOUT_MS', 3_600_000),
    newapiBaseUrl: process.env.NEWAPI_BASE_URL ?? '',
    jobsEnabled: process.env.GATEWAY_JOBS_ENABLED !== 'false',
  };
}

export function walletLedgerWriteEnabled(): boolean {
  return boolEnv('WALLET_LEDGER_WRITE_ENABLED', false);
}

export function walletDisplayEnabled(): boolean {
  return boolEnv('WALLET_DISPLAY_ENABLED', false);
}

// 评审 R16-F1：钱门禁 fail-closed——【仅精确 'true' 为开】，缺失/空/非法值一律关闭。
// 原 `!== 'false'` 把缺失/空/非法判为开，与 deploy.sh 门禁的 `= "true"` 不一致，形成确定性旁路。
// 注意语义翻转：现有 env 模板/compose allowlist 必须显式提供 APIPOOL_CHECKOUT_ENABLED=true 才开放收款。
export function checkoutEnabled(): boolean {
  return process.env.APIPOOL_CHECKOUT_ENABLED === 'true';
}
```

`.env.example`（末尾追加，沿用 `KEY = "value"` 格式）与 `deploy/env.production.example`（`KEY=value` 格式）各加一段，列出 PLAN.md env 总表全部 14 个变量及默认值，生产模板补注释：`# APIPOOL_API_MODE: legacy|maintenance|portal（configure-caddy.sh 经 read_env_value 读取）`、`# WALLET_LEDGER_WRITE_ENABLED 打开前置=备份恢复演练证据在案`。

- [ ] **Step 4: 跑测试确认通过**。
- [ ] **Step 5: Commit** `feat(gateway): 网关与钱包 env 配置接线`

---

### Task 4: `endpoints.ts` 白名单端点表 + `errors.ts` 双协议错误体

**Files:**
- Create: `src/features/gateway/lib/endpoints.ts`、`src/features/gateway/lib/errors.ts`
- Test: `tests/gateway/errors.test.ts`

**Interfaces:** PLAN.md 契约 `GatewayEndpointKey/GatewayProtocol/GatewayEndpoint/resolveEndpoint/GatewayErrorCode/gatewayErrorResponse`。

- [ ] **Step 1: 写失败测试**

```ts
// tests/gateway/errors.test.ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveEndpoint } from '@/features/gateway/lib/endpoints';
import { gatewayErrorResponse } from '@/features/gateway/lib/errors';

test('端点白名单：五端点命中、其余 null（需求 7.5.1 不透传）', () => {
  assert.equal(resolveEndpoint('POST', ['chat', 'completions'])?.key, 'chat_completions');
  assert.equal(resolveEndpoint('POST', ['responses'])?.key, 'responses');
  assert.equal(resolveEndpoint('POST', ['messages'])?.protocol, 'anthropic');
  assert.equal(resolveEndpoint('POST', ['embeddings'])?.key, 'embeddings');
  assert.equal(resolveEndpoint('GET', ['models'])?.billable, false);
  assert.equal(resolveEndpoint('GET', ['chat', 'completions']), null); // method 不匹配
  assert.equal(resolveEndpoint('POST', ['completions']), null);
  assert.equal(resolveEndpoint('POST', ['audio', 'speech']), null);
});

test('OpenAI 协议错误体含 request_id 且带 no-store', async () => {
  const res = gatewayErrorResponse('openai', 'insufficient_quota', { status: 429, portalRequestId: 'preq_1' });
  assert.equal(res.status, 429);
  assert.equal(res.headers.get('x-apipool-request-id'), 'preq_1');
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const body = await res.json();
  assert.equal(body.error.code, 'insufficient_quota');
  assert.equal(body.error.request_id, 'preq_1');
});

test('Anthropic 协议错误体形态 + Retry-After', async () => {
  const res = gatewayErrorResponse('anthropic', 'concurrency_limit_exceeded', {
    status: 429, portalRequestId: 'preq_2', retryAfterSeconds: 5,
  });
  assert.equal(res.headers.get('retry-after'), '5');
  const body = await res.json();
  assert.equal(body.type, 'error');
  assert.equal(body.error.type, 'concurrency_limit_exceeded');
  assert.equal(body.request_id, 'preq_2');
});

test('错误文案不泄漏内部信息', async () => {
  const res = gatewayErrorResponse('openai', 'model_not_found', { status: 404, portalRequestId: 'preq_3' });
  const text = JSON.stringify(await res.json()).toLowerCase();
  for (const banned of ['newapi', 'new-api', 'oneapi', 'upstream_host']) {
    assert.ok(!text.includes(banned), `不含 ${banned}`);
  }
});
```

- [ ] **Step 2: 跑测试确认失败**。

- [ ] **Step 3: 实现**

```ts
// src/features/gateway/lib/endpoints.ts —— 一期白名单（设计 §2.3/§4.6）；扩展=在表中加条目，非配置开关
export type GatewayEndpointKey = 'chat_completions' | 'responses' | 'messages' | 'embeddings' | 'models';
export type GatewayProtocol = 'openai' | 'anthropic';

export interface GatewayEndpoint {
  key: GatewayEndpointKey;
  method: 'GET' | 'POST';
  upstreamPath: string;
  protocol: GatewayProtocol;
  billable: boolean;
}

export const GATEWAY_ENDPOINTS: readonly GatewayEndpoint[] = [
  { key: 'chat_completions', method: 'POST', upstreamPath: '/v1/chat/completions', protocol: 'openai', billable: true },
  { key: 'responses', method: 'POST', upstreamPath: '/v1/responses', protocol: 'openai', billable: true },
  { key: 'messages', method: 'POST', upstreamPath: '/v1/messages', protocol: 'anthropic', billable: true },
  { key: 'embeddings', method: 'POST', upstreamPath: '/v1/embeddings', protocol: 'openai', billable: true },
  { key: 'models', method: 'GET', upstreamPath: '/v1/models', protocol: 'openai', billable: false },
];

export function resolveEndpoint(method: string, pathSegments: string[]): GatewayEndpoint | null {
  const path = `/v1/${pathSegments.join('/')}`;
  const verb = method.toUpperCase();
  return GATEWAY_ENDPOINTS.find((e) => e.method === verb && e.upstreamPath === path) ?? null;
}
```

```ts
// src/features/gateway/lib/errors.ts —— 双协议错误体（设计 §4.5）
import type { GatewayProtocol } from './endpoints';

export type GatewayErrorCode =
  | 'invalid_api_key' | 'account_disabled' | 'account_frozen'
  | 'insufficient_quota' | 'concurrency_limit_exceeded'
  | 'model_not_found' | 'unknown_endpoint' | 'request_too_large'
  | 'request_timeout' // 408：读体 idle/总时长超时（评审 R3-F3）
  | 'invalid_request' // 400：请求体歧义（重复/转义歧义 model 键——计费与执行分叉向量，评审 R6-F1）
  | 'upstream_unavailable' | 'upstream_error' | 'internal_error';

const DEFAULT_MESSAGES: Record<GatewayErrorCode, string> = {
  invalid_api_key: 'Invalid API key provided.',
  account_disabled: 'This account has been disabled.',
  account_frozen: 'This account is frozen. Contact support.',
  insufficient_quota: 'Insufficient balance. Top up to continue.',
  concurrency_limit_exceeded: 'Too many in-flight requests. Retry shortly.',
  model_not_found: 'The requested model does not exist or is not available for this key.',
  unknown_endpoint: 'Unknown endpoint.',
  request_too_large: 'Request body exceeds the size limit.',
  request_timeout: 'Request body timed out.',
  invalid_request: 'Malformed or ambiguous request body.',
  upstream_unavailable: 'Service temporarily unavailable. Retry shortly.',
  upstream_error: 'Upstream service error.',
  internal_error: 'Internal error.',
};

const OPENAI_TYPE: Partial<Record<GatewayErrorCode, string>> = {
  invalid_api_key: 'invalid_request_error',
  insufficient_quota: 'insufficient_quota',
  concurrency_limit_exceeded: 'rate_limit_error',
  model_not_found: 'invalid_request_error',
  unknown_endpoint: 'invalid_request_error',
  request_too_large: 'invalid_request_error',
  request_timeout: 'invalid_request_error',
  invalid_request: 'invalid_request_error',
};

export function gatewayErrorResponse(
  protocol: GatewayProtocol,
  code: GatewayErrorCode,
  opts: { status: number; portalRequestId: string; message?: string; retryAfterSeconds?: number }
): Response {
  const message = opts.message ?? DEFAULT_MESSAGES[code];
  const body =
    protocol === 'anthropic'
      ? { type: 'error', error: { type: code, message }, request_id: opts.portalRequestId }
      : { error: { message, type: OPENAI_TYPE[code] ?? 'api_error', code, request_id: opts.portalRequestId } };
  const headers = new Headers({
    'content-type': 'application/json',
    'cache-control': 'no-store',
    'x-apipool-request-id': opts.portalRequestId,
  });
  if (opts.retryAfterSeconds) headers.set('retry-after', String(opts.retryAfterSeconds));
  return new Response(JSON.stringify(body), { status: opts.status, headers });
}
```

- [ ] **Step 4: 跑测试确认通过**。
- [ ] **Step 5: Commit** `feat(gateway): 端点白名单与双协议错误契约`

---

### Task 5: `billing.ts` 计费桶归一化 + BigInt 金额

**Files:**
- Create: `src/features/gateway/lib/billing.ts`
- Test: `tests/gateway/billing.test.ts`

**Interfaces:** PLAN.md 契约 `UsageBuckets/PriceVector/ceilDiv/normalizeUsage/normalizeBackfillUsage/computeChargeMicroUsd`。行为逐条对照设计 §5.1/§5.2。

- [ ] **Step 1: 写失败测试**（四端点 fixture 全覆盖）

```ts
// tests/gateway/billing.test.ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { ceilDiv, computeChargeMicroUsd, normalizeUsage, normalizeBackfillUsage } from '@/features/gateway/lib/billing';

const PRICE = { inputMicroUsdPerM: 2_500_000, cachedInputMicroUsdPerM: 1_250_000,
  cacheWrite5mMicroUsdPerM: 3_125_000, cacheWrite1hMicroUsdPerM: 5_000_000, outputMicroUsdPerM: 10_000_000 };

test('Chat：prompt_tokens 含 cached 子集必须扣除', () => {
  const { buckets, unmappedNonZero } = normalizeUsage('chat_completions', {
    prompt_tokens: 1000, completion_tokens: 50,
    prompt_tokens_details: { cached_tokens: 600, cache_creation_tokens: 100 },
  });
  assert.deepEqual(buckets, { uncachedInput: 400, cachedRead: 600, cacheWrite5m: 100, cacheWrite1h: 0, output: 50, reasoning: 0 });
  assert.deepEqual(unmappedNonZero, []);
});

test('Chat：cached 超过 prompt 时 uncached 钳到 0', () => {
  const { buckets } = normalizeUsage('chat_completions', {
    prompt_tokens: 100, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 150 },
  });
  assert.equal(buckets.uncachedInput, 0);
});

test('Responses：input_tokens_details 直映（16.2 实测字段）', () => {
  const { buckets } = normalizeUsage('responses', {
    input_tokens: 800, output_tokens: 120,
    input_tokens_details: { cached_tokens: 300, cache_write_tokens: 50 },
    output_tokens_details: { reasoning_tokens: 40 },
  });
  assert.deepEqual(buckets, { uncachedInput: 500, cachedRead: 300, cacheWrite5m: 50, cacheWrite1h: 0, output: 120, reasoning: 40 });
});

test('Messages：Anthropic 互斥直映、input_tokens 不扣、5m/1h 分桶', () => {
  const { buckets } = normalizeUsage('messages', {
    input_tokens: 200, output_tokens: 90, cache_read_input_tokens: 500,
    cache_creation: { ephemeral_5m_input_tokens: 60, ephemeral_1h_input_tokens: 30 },
    cache_creation_input_tokens: 90,
  });
  assert.deepEqual(buckets, { uncachedInput: 200, cachedRead: 500, cacheWrite5m: 60, cacheWrite1h: 30, output: 90, reasoning: 0 });
});

test('Messages：无 cache_creation 明细时回退 cache_creation_input_tokens → 5m', () => {
  const { buckets } = normalizeUsage('messages', {
    input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 40,
  });
  assert.equal(buckets.cacheWrite5m, 40);
  assert.equal(buckets.cacheWrite1h, 0);
});

test('Embeddings：仅 uncached_input', () => {
  const { buckets } = normalizeUsage('embeddings', { prompt_tokens: 512, total_tokens: 512 });
  assert.deepEqual(buckets, { uncachedInput: 512, cachedRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, output: 0, reasoning: 0 });
});

test('未映射非零字段被上报（宁少勿错）', () => {
  const { unmappedNonZero } = normalizeUsage('chat_completions', {
    prompt_tokens: 10, completion_tokens: 1, web_search_requests: 3,
  });
  assert.deepEqual(unmappedNonZero, ['web_search_requests']);
});

test('金额：BigInt 全程、合计一次 ceil、不足 1 计 1', () => {
  assert.equal(ceilDiv(1n, 1_000_000n), 1n);
  assert.equal(ceilDiv(0n, 1_000_000n), 0n);
  assert.equal(ceilDiv(1_000_001n, 1_000_000n), 2n);
  // 单 token 最小扣费：1 token × 2.5 usd/M = 2.5 micro → ceil = 3
  assert.equal(computeChargeMicroUsd({ uncachedInput: 1, cachedRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, output: 0, reasoning: 0 }, PRICE), 3n);
  // 全桶 0（成功但零用量）→ 隐含最小扣费 1
  assert.equal(computeChargeMicroUsd({ uncachedInput: 0, cachedRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, output: 0, reasoning: 0 }, PRICE), 1n);
  // 大数不溢出：10^7 tokens × 10^9 micro/M = 10^16 中间值
  const big = computeChargeMicroUsd(
    { uncachedInput: 10_000_000, cachedRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, output: 0, reasoning: 0 },
    { ...PRICE, inputMicroUsdPerM: 1_000_000_000 });
  assert.equal(big, 10_000_000_000n);
});

test('连续小额逐笔和 = 逐笔 ceil 之和（不跨请求携余数）', () => {
  const one = computeChargeMicroUsd({ uncachedInput: 1, cachedRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, output: 0, reasoning: 0 }, PRICE);
  let sum = 0n;
  for (let i = 0; i < 10; i++) sum += one;
  assert.equal(sum, 30n); // 10 × ceil(2.5) = 30，而非 ceil(25)=25
});

test('日志回填口径：cache 明细缺失时降级两桶', () => {
  assert.deepEqual(normalizeBackfillUsage({ inputTokens: 100, outputTokens: 20 }),
    { uncachedInput: 100, cachedRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, output: 20, reasoning: 0 });
  assert.deepEqual(normalizeBackfillUsage({ inputTokens: 100, outputTokens: 20, cacheTokens: 30, cacheCreationTokens5m: 5, cacheCreationTokens1h: 2 }),
    { uncachedInput: 70, cachedRead: 30, cacheWrite5m: 5, cacheWrite1h: 2, output: 20, reasoning: 0 });
});
```

- [ ] **Step 2: 跑测试确认失败**。

- [ ] **Step 3: 实现 `src/features/gateway/lib/billing.ts`**

```ts
import type { GatewayEndpointKey } from './endpoints';

export interface UsageBuckets {
  uncachedInput: number; cachedRead: number; cacheWrite5m: number;
  cacheWrite1h: number; output: number; reasoning: number;
}

export interface PriceVector {
  inputMicroUsdPerM: number; cachedInputMicroUsdPerM: number;
  cacheWrite5mMicroUsdPerM: number; cacheWrite1hMicroUsdPerM: number; outputMicroUsdPerM: number;
}

export function ceilDiv(a: bigint, b: bigint): bigint {
  return (a + b - 1n) / b;
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});

// 每端点已映射字段白名单：其余顶层数值字段非零 → 上报 unmappedNonZero（告警 + 不入账，设计 §5.1 末条）
const MAPPED_KEYS: Record<string, Set<string>> = {
  chat_completions: new Set(['prompt_tokens', 'completion_tokens', 'total_tokens', 'prompt_tokens_details', 'completion_tokens_details', 'cache_creation_input_tokens']),
  responses: new Set(['input_tokens', 'output_tokens', 'total_tokens', 'input_tokens_details', 'output_tokens_details']),
  messages: new Set(['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens', 'cache_creation', 'server_tool_use', 'service_tier']),
  embeddings: new Set(['prompt_tokens', 'total_tokens']),
};

export function normalizeUsage(endpoint: GatewayEndpointKey, usage: Record<string, unknown>) {
  let buckets: UsageBuckets;
  switch (endpoint) {
    case 'chat_completions': {
      const details = obj(usage.prompt_tokens_details);
      const completionDetails = obj(usage.completion_tokens_details);
      const cachedRead = num(details.cached_tokens);
      buckets = {
        uncachedInput: Math.max(0, num(usage.prompt_tokens) - cachedRead),
        cachedRead,
        cacheWrite5m: num(details.cache_creation_tokens ?? usage.cache_creation_input_tokens),
        cacheWrite1h: 0,
        output: num(usage.completion_tokens),
        reasoning: num(completionDetails.reasoning_tokens),
      };
      break;
    }
    case 'responses': {
      const inDetails = obj(usage.input_tokens_details);
      const outDetails = obj(usage.output_tokens_details);
      const cachedRead = num(inDetails.cached_tokens);
      buckets = {
        uncachedInput: Math.max(0, num(usage.input_tokens) - cachedRead),
        cachedRead,
        cacheWrite5m: num(inDetails.cache_write_tokens),
        cacheWrite1h: 0,
        output: num(usage.output_tokens),
        reasoning: num(outDetails.reasoning_tokens),
      };
      break;
    }
    case 'messages': {
      const creation = obj(usage.cache_creation);
      const has5m = creation.ephemeral_5m_input_tokens !== undefined;
      const has1h = creation.ephemeral_1h_input_tokens !== undefined;
      buckets = {
        uncachedInput: num(usage.input_tokens), // Anthropic 互斥语义：不扣
        cachedRead: num(usage.cache_read_input_tokens),
        cacheWrite5m: has5m ? num(creation.ephemeral_5m_input_tokens) : num(usage.cache_creation_input_tokens),
        cacheWrite1h: has1h ? num(creation.ephemeral_1h_input_tokens) : 0,
        output: num(usage.output_tokens),
        reasoning: 0,
      };
      break;
    }
    case 'embeddings':
      buckets = { uncachedInput: num(usage.prompt_tokens), cachedRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, output: 0, reasoning: 0 };
      break;
    default:
      buckets = { uncachedInput: 0, cachedRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, output: 0, reasoning: 0 };
  }
  const mapped = MAPPED_KEYS[endpoint] ?? new Set<string>();
  const unmappedNonZero = Object.entries(usage)
    .filter(([k, v]) => !mapped.has(k) && typeof v === 'number' && v !== 0)
    .map(([k]) => k);
  return { buckets, unmappedNonZero };
}

// 日志回填口径（设计 §5.1）：复用 client.ts parseUsageLogCacheMetadata 的产物字段
export function normalizeBackfillUsage(log: {
  inputTokens: number; outputTokens: number; cacheTokens?: number;
  cacheCreationTokens?: number; cacheCreationTokens5m?: number; cacheCreationTokens1h?: number;
}): UsageBuckets {
  const cachedRead = num(log.cacheTokens);
  const write5m = num(log.cacheCreationTokens5m ?? log.cacheCreationTokens);
  const write1h = num(log.cacheCreationTokens1h);
  return {
    uncachedInput: Math.max(0, num(log.inputTokens) - cachedRead),
    cachedRead, cacheWrite5m: write5m, cacheWrite1h: write1h,
    output: num(log.outputTokens), reasoning: 0,
  };
}

const MICRO_PER_M = 1_000_000n;

export function computeChargeMicroUsd(buckets: UsageBuckets, price: PriceVector): bigint {
  const total =
    BigInt(buckets.uncachedInput) * BigInt(price.inputMicroUsdPerM) +
    BigInt(buckets.cachedRead) * BigInt(price.cachedInputMicroUsdPerM) +
    BigInt(buckets.cacheWrite5m) * BigInt(price.cacheWrite5mMicroUsdPerM) +
    BigInt(buckets.cacheWrite1h) * BigInt(price.cacheWrite1hMicroUsdPerM) +
    BigInt(buckets.output) * BigInt(price.outputMicroUsdPerM);
  const charged = ceilDiv(total, MICRO_PER_M);
  return charged > 0n ? charged : 1n; // 隐含最小扣费（仅结算路径调用=请求成功有 usage）
}
```

- [ ] **Step 4: 跑测试确认通过**。
- [ ] **Step 5: Commit** `feat(gateway): 计费桶归一化与 BigInt 金额引擎`

---

### Task 6: `credentials-strip.ts` 凭证剥离/注入

**Files:**
- Create: `src/features/gateway/lib/credentials-strip.ts`
- Test: `tests/gateway/credentials-strip.test.ts`

**Interfaces:** PLAN.md 契约 `buildUpstreamHeaders/sanitizeDownstreamHeaders`。行为=设计 §4.2 出站剥离注入 + §4.4 压缩头处理。

- [ ] **Step 1: 写失败测试**

```ts
// tests/gateway/credentials-strip.test.ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { buildUpstreamHeaders, sanitizeDownstreamHeaders } from '@/features/gateway/lib/credentials-strip';

test('全载体零残留 + 注入唯一 Authorization（需求 14.6）', () => {
  const incoming = new Headers({
    Authorization: 'Bearer sk-ap-user-key',
    'X-Api-Key': 'sk-ap-user-key',        // 实测 x-api-key 覆盖 Authorization —— 必剥
    'x-goog-api-key': 'g-key', 'api-key': 'azure-key',
    Cookie: 'session=abc', 'X-Apipool-Trace': 'x',
    Connection: 'keep-alive', 'Transfer-Encoding': 'chunked', Host: 'api2.apipool.dev',
    'Proxy-Authorization': 'p', 'Content-Type': 'application/json',
    'User-Agent': 'openai-node/4.0', 'anthropic-version': '2023-06-01',
  });
  const out = buildUpstreamHeaders(incoming, 'sk-runtime-secret');
  assert.equal(out.get('authorization'), 'Bearer sk-runtime-secret');
  for (const gone of ['x-api-key', 'x-goog-api-key', 'api-key', 'cookie', 'x-apipool-trace',
    'connection', 'transfer-encoding', 'host', 'proxy-authorization', 'content-length']) {
    assert.equal(out.get(gone), null, `${gone} 已剥离`);
  }
  assert.equal(out.get('content-type'), 'application/json', 'SDK 头白名单透传');
  assert.equal(out.get('anthropic-version'), '2023-06-01');
  assert.equal(out.get('user-agent'), 'openai-node/4.0');
  assert.equal(out.get('accept-encoding'), 'identity', '同机内网禁压缩（设计 §4.4）');
  assert.equal(out.get('new-api-user'), null, '不注 New-Api-User');
  // 零凭证残留总断言：所有 value 不含门户 Key
  out.forEach((v) => assert.ok(!v.includes('sk-ap-user-key')));
});

test('sec-websocket-protocol 备用凭证覆盖被剥离（评审 R7-F1）', () => {
  const incoming = new Headers({
    Authorization: 'Bearer sk-ap-user-key',
    'Sec-WebSocket-Protocol': 'openai-insecure-api-key.sk-leaked-newapi-token, openai-beta',
    'Content-Type': 'application/json',
  });
  const out = buildUpstreamHeaders(incoming, 'sk-runtime-secret');
  assert.equal(out.get('sec-websocket-protocol'), null, 'ws 备用凭证载体已剥离');
  assert.equal(out.get('authorization'), 'Bearer sk-runtime-secret', '注入的运行 Key 不被覆盖');
  out.forEach((v) => assert.ok(!v.includes('sk-leaked-newapi-token')));
});

test('下发响应头剥内部痕迹 + 压缩三头 + 加门户请求 ID', () => {
  const upstream = new Headers({
    'X-Oneapi-Request-Id': 'oneapi-123', Server: 'nginx',
    'Content-Encoding': 'gzip', 'Content-Length': '999', 'Transfer-Encoding': 'chunked',
    'Content-Type': 'text/event-stream',
  });
  const out = sanitizeDownstreamHeaders(upstream, 'preq_abc');
  for (const gone of ['x-oneapi-request-id', 'server', 'content-encoding', 'content-length', 'transfer-encoding']) {
    assert.equal(out.get(gone), null);
  }
  assert.equal(out.get('x-apipool-request-id'), 'preq_abc');
  assert.equal(out.get('cache-control'), 'no-store');
  assert.equal(out.get('content-type'), 'text/event-stream');
});
```

- [ ] **Step 2: 跑测试确认失败**。

- [ ] **Step 3: 实现**（Headers 迭代时 name 已被 fetch 规范小写化，大小写变体天然归一）

```ts
// src/features/gateway/lib/credentials-strip.ts —— 设计 §4.2/§4.4
// sec-websocket-protocol 必剥（评审 R7-F1）：New API TokenAuth 会从中提取 openai-insecure-api-key.*
// 覆盖注入的 Authorization——持观察期旧 token 的用户可借此绕过运行 Key 的分组/轮换/归属边界。
const CREDENTIAL_HEADERS = new Set(['authorization', 'x-api-key', 'x-goog-api-key', 'api-key', 'cookie', 'sec-websocket-protocol']);
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'transfer-encoding', 'te', 'upgrade', 'trailer', 'host', 'content-length']);
const DOWNSTREAM_STRIP = new Set(['x-oneapi-request-id', 'server', 'content-encoding', 'content-length', 'transfer-encoding', 'connection', 'keep-alive']);

export function buildUpstreamHeaders(incoming: Headers, runtimeKey: string): Headers {
  const out = new Headers();
  incoming.forEach((value, name) => {
    if (CREDENTIAL_HEADERS.has(name) || HOP_BY_HOP.has(name)) return;
    if (name.startsWith('proxy-') || name.startsWith('x-apipool-')) return;
    out.set(name, value);
  });
  out.set('authorization', `Bearer ${runtimeKey}`); // 唯一凭证载体；不注 x-api-key / New-Api-User
  out.set('accept-encoding', 'identity');
  return out;
}

export function sanitizeDownstreamHeaders(upstream: Headers, portalRequestId: string): Headers {
  const out = new Headers();
  upstream.forEach((value, name) => {
    if (DOWNSTREAM_STRIP.has(name)) return;
    out.set(name, value);
  });
  out.set('x-apipool-request-id', portalRequestId);
  out.set('cache-control', 'no-store');
  return out;
}
```

- [ ] **Step 4: 跑测试确认通过**。
- [ ] **Step 5: Commit** `feat(gateway): 凭证剥离注入与响应头消毒`

---

### Task 7: `sse-parser.ts` 受限扫描器

**Files:**
- Create: `src/features/gateway/lib/sse-parser.ts`
- Test: `tests/gateway/sse-parser.test.ts`

**Interfaces:** PLAN.md 契约 `extractTopLevelModel/createUsageExtractor/UsageExtractor/ExtractedUsage`。约束（设计 §2.4/§4.4）：不整体 `JSON.parse` 请求体/响应全文、不把大 body 物化成完整字符串；流式对**单行 SSE event** 做行级 parse 是允许的；有界窗口超限 → `overflowed=true` 放弃提取（转日志回填）。
**完整性标志（评审 R5-F3，设计 §4.3 原文"拿到完整 usage"）**：`finish()` 返回 `{ usage, complete }`——`complete` 按协议终止证据判定：`chat_completions`/`embeddings` = 含 usage 的末尾 chunk 已出现（该 chunk 本身即终止信号）；`responses` = 收到 `response.completed` 事件；`messages` = **见过 `message_delta` 携带的 usage**（`message_start` 的 usage 是含 `output_tokens` 占位的初始值，仅有它 = 不完整）；非流式 = 子树提取成功即 complete（整包收完才 finish）。部分 usage 结算 = 截断响应被扣费，违反 policy B。

- [ ] **Step 1: 写失败测试**

```ts
// tests/gateway/sse-parser.test.ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { createUsageExtractor, extractTopLevelModel } from '@/features/gateway/lib/sse-parser';

const enc = new TextEncoder();

test('extractTopLevelModel：只取顶层 model、恰好一个', () => {
  assert.deepEqual(extractTopLevelModel(enc.encode('{"model":"gpt-5.4","messages":[]}')), { ok: true, model: 'gpt-5.4' });
  assert.deepEqual(extractTopLevelModel(enc.encode('{"messages":[{"model":"fake"}],"model":"real"}')), { ok: true, model: 'real' }, '嵌套 model 不计入');
  assert.deepEqual(extractTopLevelModel(enc.encode('{"input":"say \\"model\\": x","model":"m1"}')), { ok: true, model: 'm1' }, '字符串内容不误判');
  assert.deepEqual(extractTopLevelModel(enc.encode('{"messages":[{"model":"nested-only"}]}')), { ok: false, reason: 'missing' });
  assert.equal(extractTopLevelModel(enc.encode('not json')).ok, false);
});

test('重复 model 键拒绝（评审 R6-F1：Go 上游后值覆盖=计费/执行分叉）', () => {
  assert.deepEqual(
    extractTopLevelModel(enc.encode('{"model":"cheap","messages":[],"model":"expensive"}')),
    { ok: false, reason: 'ambiguous' }
  );
});

test('Unicode 转义键规范解码（评审 R6-F1：\\u006dodel 就是 model）', () => {
  assert.deepEqual(extractTopLevelModel(enc.encode('{"\\u006dodel":"m1"}')), { ok: true, model: 'm1' });
  assert.deepEqual(
    extractTopLevelModel(enc.encode('{"model":"cheap","\\u006dodel":"expensive"}')),
    { ok: false, reason: 'ambiguous' },
    '转义变体计入重复判定'
  );
});

test('全量扫描：model 在大 body 尾部仍可达（无扫描窗口截断）', () => {
  const huge = `{"padding":"${'x'.repeat(500_000)}","model":"late"}`;
  assert.deepEqual(extractTopLevelModel(enc.encode(huge)), { ok: true, model: 'late' });
});

test('Chat 流式：末尾 chunk usage 提取即 complete，畸形行不抛', () => {
  const ex = createUsageExtractor('chat_completions', true, 1 << 20);
  ex.push(enc.encode('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n'));
  ex.push(enc.encode('data: {broken json\n\n'));
  ex.push(enc.encode('data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":2}}\n\n'));
  ex.push(enc.encode('data: [DONE]\n\n'));
  const { usage, complete } = ex.finish();
  assert.equal(usage?.prompt_tokens, 10);
  assert.equal(complete, true);
});

test('Messages 流式：start+delta 合并且 complete=true（评审 R5-F3）', () => {
  const ex = createUsageExtractor('messages', true, 1 << 20);
  ex.push(enc.encode('event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":25,"cache_read_input_tokens":100,"output_tokens":1}}}\n\n'));
  ex.push(enc.encode('event: content_block_delta\ndata: {"type":"content_block_delta"}\n\n'));
  ex.push(enc.encode('event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":77}}\n\n'));
  const { usage, complete } = ex.finish();
  assert.equal(usage?.input_tokens, 25);
  assert.equal(usage?.cache_read_input_tokens, 100);
  assert.equal(usage?.output_tokens, 77, 'delta 覆盖 start');
  assert.equal(complete, true);
});

test('Messages 仅 message_start（delta 前中断）→ usage 非空但 complete=false（评审 R5-F3：占位 output_tokens 不可结算）', () => {
  const ex = createUsageExtractor('messages', true, 1 << 20);
  ex.push(enc.encode('event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":25,"output_tokens":1}}}\n\n'));
  const { usage, complete } = ex.finish();
  assert.equal(usage?.input_tokens, 25);
  assert.equal(complete, false);
});

test('Responses 流式：response.completed 事件内 usage → complete=true', () => {
  const ex = createUsageExtractor('responses', true, 1 << 20);
  ex.push(enc.encode('event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":5,"output_tokens":9}}}\n\n'));
  const done = ex.finish();
  assert.equal(done.usage?.input_tokens, 5);
  assert.equal(done.complete, true);
});

test('非流式：定位根级 usage 子树、不整体 parse 大响应、提取成功即 complete', () => {
  const ex = createUsageExtractor('chat_completions', false, 1 << 20);
  ex.push(enc.encode('{"id":"cmpl","choices":[{"message":{"content":"hello"}}],'));
  ex.push(enc.encode('"usage":{"prompt_tokens":3,"completion_tokens":7,"prompt_tokens_details":{"cached_tokens":1}}}'));
  const { usage, complete } = ex.finish();
  assert.equal(usage?.prompt_tokens, 3);
  assert.deepEqual(usage?.prompt_tokens_details, { cached_tokens: 1 });
  assert.equal(complete, true);
});

test('非流式 usage 伪造防御（评审 R7-F2）：tool_use.input.usage 前置于真实顶层 usage → 不被采信', () => {
  const ex = createUsageExtractor('messages', false, 1 << 20);
  // 用户可控 tool_use.input 内塞低值 usage（深处），真实 usage 在顶层
  ex.push(enc.encode('{"content":[{"type":"tool_use","input":{"usage":{"input_tokens":1,"output_tokens":1}}}],'));
  ex.push(enc.encode('"usage":{"input_tokens":9000,"output_tokens":8000}}'));
  const { usage, complete } = ex.finish();
  assert.equal(usage?.input_tokens, 9000, '只认根级 usage');
  assert.equal(complete, true);
});

test('非流式仅深处 usage（无根级）→ complete=false 转回填（评审 R7-F2）', () => {
  const ex = createUsageExtractor('messages', false, 1 << 20);
  ex.push(enc.encode('{"content":[{"type":"tool_use","input":{"usage":{"input_tokens":1,"output_tokens":1}}}]}'));
  assert.deepEqual(ex.finish(), { usage: null, complete: false });
});

test('字节级扫描内存有界（评审 R7-F5）：25MB body（大量短串）提取 model 正确', () => {
  const big = `{"model":"gpt-5.4","messages":[${'{"role":"user","content":"x"},'.repeat(400_000)}{"role":"user","content":"end"}]}`;
  assert.deepEqual(extractTopLevelModel(enc.encode(big)), { ok: true, model: 'gpt-5.4' });
});

test('零分配跳过大字符串（评审 R8-F1）：单个 ~25MB content 串不物化——提取 model 不 OOM', () => {
  // 关键回归：R7-F5 的 readJsonStringBytes 会累积每个字符串的每个字节；本用例证明零分配扫描下
  // 单个巨串只被边界跳过。用 --max-old-space-size=256（package.json test 或 T18 集成）收紧堆跑，
  // 断言解析 25MB 单串 body 不抛 OOM 且 model 正确。
  const huge = `{"model":"gpt-5.4","input":"${'y'.repeat(25 * 1024 * 1024)}"}`;
  assert.deepEqual(extractTopLevelModel(enc.encode(huge)), { ok: true, model: 'gpt-5.4' });
});

test('model 值超 512B → malformed（评审 R8-F1：值本应短）', () => {
  const longVal = `{"model":"${'m'.repeat(600)}"}`;
  assert.deepEqual(extractTopLevelModel(enc.encode(longVal)), { ok: false, reason: 'malformed' });
});

test('海量重复顶层 model 键短路（评审 R9-F1）：遇第二个即 ambiguous、不逐个分配', () => {
  // 25MB body 全是 "model":"x" —— 第二个命中就返回，不应 OOM/超时
  const flood = `{${'"model":"x",'.repeat(2_000_000)}"end":1}`;
  assert.deepEqual(extractTopLevelModel(enc.encode(flood)), { ok: false, reason: 'ambiguous' });
});

test('跨 chunk 切割的 usage 行仍可提取', () => {
  const ex = createUsageExtractor('chat_completions', true, 1 << 20);
  ex.push(enc.encode('data: {"usage":{"prompt_'));
  ex.push(enc.encode('tokens":42,"completion_tokens":1}}\n\n'));
  assert.equal(ex.finish().usage?.prompt_tokens, 42);
});

test('超出扫描窗口 → overflowed，finish 返回 { usage: null, complete: false }', () => {
  const ex = createUsageExtractor('chat_completions', true, 64);
  ex.push(enc.encode(`data: {"choices":[{"delta":{"content":"${'y'.repeat(200)}"}}]}\n\n`));
  ex.push(enc.encode('data: {"usage":{"prompt_tokens":1,"completion_tokens":1}}\n\n'));
  assert.equal(ex.overflowed, true);
  assert.deepEqual(ex.finish(), { usage: null, complete: false });
});
```

- [ ] **Step 2: 跑测试确认失败**。

- [ ] **Step 3: 实现 `src/features/gateway/lib/sse-parser.ts`**

实现要点（完整实现按此写，核心骨架如下）：

```ts
import type { GatewayEndpointKey } from './endpoints';

// —— 顶层 model 提取（设计 §2.4 + 评审 R6-F1 + R7-F5）——
// 【字节级 UTF-8 状态扫描】直接在 Uint8Array 上进行，不 TextDecoder 整个 body、不构建对象树：
//   评审 R7-F5——全量 decode 成 UTF-16 字符串在 64×25MB 并发下峰值上 GiB、单 Key 可 OOM 同进程门户。
// 语义（评审 R6-F1）：全量扫描 + 转义字节层解码 + 顶层 model 恰好一个——
//   Go 上游（New API）对重复键取后值，{"model":"cheap","model":"expensive"} 会按 cheap 计费、
//   按 expensive 执行；"model" 不解码则逃逸扫描却被上游认作 model。
// 只有命中的 model 键名与其字符串值被解码成小字符串，body 本身始终是字节。
export type ModelExtraction =
  | { ok: true; model: string }
  | { ok: false; reason: 'missing' | 'ambiguous' | 'malformed' };

const QUOTE = 0x22, BACKSLASH = 0x5c, COLON = 0x3a;
const OPEN_BRACE = 0x7b, OPEN_BRACKET = 0x5b, CLOSE_BRACE = 0x7d, CLOSE_BRACKET = 0x5d;
const isWs = (b: number) => b === 0x20 || b === 0x09 || b === 0x0a || b === 0x0d;
const MODEL_KEY = [0x6d, 0x6f, 0x64, 0x65, 0x6c]; // "model"（字节）
const MODEL_VALUE_MAX_BYTES = 512;                // model 值字节上限（评审 R8-F1：超限=非法输入）

export function extractTopLevelModel(body: Uint8Array): ModelExtraction {
  // 评审 R9-F1：只保留【第一个】顶层 model 值、遇第二个立即返回 ambiguous——不建数组、不逐个解码。
  // 否则 25MB body 塞满 `"model":"x"` 会 2M 次分配 × 64 并发 → GC 风暴/OOM（都在准入前）。
  let model: string | null = null;
  let depth = 0;
  let i = 0;
  const n = body.length;
  while (i < n) {
    const b = body[i];
    if (b === QUOTE) {
      // 评审 R8-F1（零分配）：先只判"该字符串是否恰好解码为 'model'"——不累积任何字节；
      // 是则再有界解码其值（≤512B），否则纯边界跳过。任意大的 content/input 串永不物化。
      const keyEnd = matchKeyIsModel(body, i);           // { end, isModel } | null（未闭合/非法转义）
      if (!keyEnd) return { ok: false, reason: 'malformed' };
      if (depth === 1 && keyEnd.isModel) {
        let k = keyEnd.end;
        while (k < n && isWs(body[k])) k++;
        if (body[k] === COLON) {
          let v = k + 1;
          while (v < n && isWs(body[v])) v++;
          if (body[v] !== QUOTE) return { ok: false, reason: 'malformed' };
          if (model !== null) return { ok: false, reason: 'ambiguous' }; // 第二个顶层 model → 立即拒绝，不再解码
          const val = decodeBoundedString(body, v, MODEL_VALUE_MAX_BYTES);
          if (!val) return { ok: false, reason: 'malformed' };   // 未闭合/非法转义/超 512B
          model = val.value;                                     // 只存第一个
          i = val.end;
          continue;
        }
      }
      i = keyEnd.end; // 非 model 键（或非顶层）：仅拿到边界，零字节累积
      continue;
    }
    if (b === OPEN_BRACE || b === OPEN_BRACKET) depth++;
    else if (b === CLOSE_BRACE || b === CLOSE_BRACKET) depth--;
    i++;
  }
  if (model === null) return { ok: false, reason: 'missing' };
  return { ok: true, model };
}

const hexDigit = (b: number) =>
  b >= 0x30 && b <= 0x39 ? b - 0x30 : b >= 0x61 && b <= 0x66 ? b - 0x57 : b >= 0x41 && b <= 0x46 ? b - 0x37 : -1;

// 转义感知消费一个 JSON 字符串跨度，回调每个【解码后字节】；返回收尾引号后下标，未闭合/非法转义 → null。
// 零分配：不累积——调用方决定是否收集（评审 R8-F1）。
function walkJsonString(body: Uint8Array, openQuoteIdx: number, onByte: (b: number) => boolean): number | null {
  let j = openQuoteIdx + 1;
  const n = body.length;
  while (j < n) {
    const c = body[j];
    if (c === BACKSLASH) {
      const esc = body[j + 1];
      if (esc === 0x75) { // \uXXXX：真解码为码点再按 UTF-8 逐字节回调（评审 R6-F1）
        let cp = 0;
        for (let h = 0; h < 4; h++) { const d = hexDigit(body[j + 2 + h] ?? -1); if (d < 0) return null; cp = cp * 16 + d; }
        if (cp < 0x80) { if (!onByte(cp)) return null; }
        else if (cp < 0x800) { if (!onByte(0xc0 | (cp >> 6)) || !onByte(0x80 | (cp & 0x3f))) return null; }
        else { if (!onByte(0xe0 | (cp >> 12)) || !onByte(0x80 | ((cp >> 6) & 0x3f)) || !onByte(0x80 | (cp & 0x3f))) return null; }
        j += 6; continue;
      }
      const map: Record<number, number> = { 0x22: 0x22, 0x5c: 0x5c, 0x2f: 0x2f, 0x62: 0x08, 0x66: 0x0c, 0x6e: 0x0a, 0x72: 0x0d, 0x74: 0x09 };
      if (!(esc in map)) return null;
      if (!onByte(map[esc])) return null;
      j += 2; continue;
    }
    if (c === QUOTE) return j + 1;
    if (!onByte(c)) return null; // onByte 返回 false = 调用方要求中止（如键名已确定不匹配 / 值超上限）
    j++;
  }
  return null; // 未闭合
}

// 判该字符串是否恰好解码为 "model"：逐字节比对，首个不符即中止（零分配，评审 R8-F1）。
// 返回 { end, isModel }；未闭合/非法转义 → null（malformed）。
function matchKeyIsModel(body: Uint8Array, openQuoteIdx: number): { end: number; isModel: boolean } | null {
  let idx = 0;
  let matched = true;
  const end = walkJsonString(body, openQuoteIdx, (b) => {
    if (matched && (idx >= MODEL_KEY.length || b !== MODEL_KEY[idx])) matched = false;
    idx++;
    return true; // 始终走到收尾引号以取 end（键名短，代价可忽略）
  });
  if (end === null) return null;
  return { end, isModel: matched && idx === MODEL_KEY.length };
}

// 有界解码 model 值：累积 ≤maxBytes 字节，超限即中止返回 null（评审 R8-F1：值本就应短）。
function decodeBoundedString(body: Uint8Array, openQuoteIdx: number, maxBytes: number): { value: string; end: number } | null {
  const out: number[] = [];
  const end = walkJsonString(body, openQuoteIdx, (b) => {
    if (out.length >= maxBytes) return false; // 超限中止 → walkJsonString 返回 null
    out.push(b);
    return true;
  });
  if (end === null) return null;
  return { value: new TextDecoder('utf-8', { fatal: false }).decode(Uint8Array.from(out)), end };
}

// —— usage 提取器 ——
export interface ExtractedUsage { usage: Record<string, unknown> | null; complete: boolean }

export interface UsageExtractor {
  push(chunk: Uint8Array): void;
  finish(): ExtractedUsage;
  overflowed: boolean;
}

export function createUsageExtractor(endpoint: GatewayEndpointKey, isStream: boolean, maxBufferBytes: number): UsageExtractor {
  return isStream ? createStreamExtractor(endpoint, maxBufferBytes) : createBodyExtractor(endpoint, maxBufferBytes);
  // createBodyExtractor 接 endpoint（评审 R7-F2）：只认协议根级 usage 路径，拒绝深处伪造
}
```

流式实现 `createStreamExtractor`：
- 持有 `carry: string`（未完行）与 `consumed: number` 计数；`push` 将 chunk decode（`TextDecoder({ stream: true })` 增量模式）追加到 carry，按 `\n` 切行；`consumed += chunk.byteLength`，超 `maxBufferBytes` → `overflowed = true`，此后 push 直接丢弃、`finish()` 恒 `{ usage: null, complete: false }`。
- 每完整行：去 `data:` 前缀；`trim() === '[DONE]'` 跳过；行内含 `'"usage"'` 才 `try { JSON.parse(line) } catch { 忽略 }`（畸形不抛）。
- 按端点取 usage 并维护 `complete` 标志（评审 R5-F3——部分 usage 结算 = 截断响应被扣费）：
  - `chat_completions`/`embeddings` → `parsed.usage`；命中即 `complete = true`（含 usage 的末尾 chunk 本身是终止信号）；
  - `responses` → `parsed.response?.usage ?? parsed.usage`；仅当 `parsed.type === 'response.completed'` 才置 `complete = true`；
  - `messages` → `parsed.message?.usage`（message_start，**不置 complete**——其 `output_tokens` 是占位初始值）与 `parsed.usage`（message_delta，**置 `complete = true`**），字段级合并、后到覆盖：`merged = { ...merged, ...found }`。
- `finish()` 处理 carry 里最后一行后返回 `{ usage: merged ?? null, complete }`。

非流式实现 `createBodyExtractor(endpoint, maxBufferBytes)`（**接 endpoint**，评审 R7-F2）：
- 累积 chunks（总量超窗 → overflowed、清空、finish `{ usage: null, complete: false }`）。
- `finish()`：拼接后扫描 usage 键——**只认协议根级路径，不再"任意深度首个命中"**（评审 R7-F2：Messages 用户可控 `tool_use.input` 可塞低值假 usage 先于真实顶层 usage 命中 → 高成本按最低金额结算）：
  - 用字节级/深度跟踪扫描（同 `extractTopLevelModel` 范式）定位 `"usage"` 键，**仅接受**：`chat_completions`/`embeddings`/`messages` = `depth===1` 的顶层 `usage`；`responses` = 顶层 `usage` 或 `response.usage`（`response` 在 depth 1、其内 `usage` 在 depth 2）；
  - 命中根级 → 平衡大括号截子树 `JSON.parse` → `{ usage, complete: true }`；
  - **无根级命中 / 根级 usage 结构异常 / 多个根级 usage** → `{ usage: null, complete: false }`（转 pending_backfill 走 New API 权威日志回填，绕开客户端伪造）。
- 非根级深处的 `usage`（如 `tool_use.input.usage`）被显式忽略，不参与判定。

- [ ] **Step 4: 跑测试确认通过**。
- [ ] **Step 5: Commit** `feat(gateway): usage 旁路受限扫描器（三协议）`

---

### Task 8: 钱包 —— `ledger.ts` + `freeze.ts` + 管理审计

**Files:**
- Create: `src/features/wallet/server/ledger.ts`、`src/features/wallet/server/freeze.ts`、`src/shared/models/portal-admin-audit.ts`
- Test: `tests/wallet/ledger.test.ts`

**Interfaces:**
- Consumes: Task 1 schema（`walletAccount/walletLedger/portalAdminAuditLog`）、`getUuid()`。
- Produces: PLAN.md 契约 `ensureWalletAccount/getWalletAccount/appendLedgerEntryInTx/applyManualAdjustment/reverseRequestCharge/freezeWallet/unfreezeWallet/recordPortalAdminAudit`。
- 注意：与设计 §6.2 的语句顺序差异——本实现先 `UPDATE wallet_account … RETURNING` 再 `INSERT wallet_ledger(balance_after)`（同事务内等价，balance_after 取值更直接）。
- 幂等与审计原子性（评审 F1）：`applyManualAdjustment` 的 `idempotencyKey` **由调用方提供且必须跨重试稳定**（本函数不生成）；可选 `audit` 参数提供时，`recordPortalAdminAudit(audit, tx)` 在**同一事务内**写入——资金变更与审计要么同时落库、要么同时回滚，杜绝"资金已变但请求报错→重试再入账"。

- [ ] **Step 1: 写失败测试**（setupDb 模板见 PLAN.md 通用工序；`.tmp/wallet-ledger.db`）

```ts
// tests/wallet/ledger.test.ts —— setupDb 后动态 import，关键用例：
test('符号校验：recharge 必须为正、request_charge 必须为负、manual 非零', ...);
  // appendLedgerEntryInTx 在 db().transaction 内调用，断言错误 message 含 'invalid sign'
test('manual_adjustment 缺 reason/operator 被拒', ...);
test('余额闭合：多笔后 balance == Σ signed_amount 且每行 balance_after 正确', async () => {
  // +5_000_000（recharge, orderNo 'o1'）→ -1_234_567（request_charge, requestLedgerId 'preq_a'）→ +234_567（manual）
  // 断言 wallet_account.balance_micro_usd === 4_000_000
  // 断言三行 balance_after 分别为 5_000_000 / 3_765_433 / 4_000_000
});
test('applyManualAdjustment 幂等：同 idempotencyKey 同载荷二次调用 alreadyApplied=true 且只一行', ...);
test('响应丢失重放（评审 F1）：首次成功后模拟调用方未收到响应、以同 idempotencyKey 重试 → 余额只变一次', ...);
test('幂等冲突（评审 R5-F6）：同 idempotencyKey 不同 userId / 不同金额 / 不同 reason → 抛 IdempotencyConflictError、余额不变、无新流水', ...);
test('并发唯一索引冲突读回同样过载荷校验：并发写入后读回若载荷不符 → 冲突而非谎报成功', ...);
test('审计与资金同事务（评审 F1）：带 audit 参数成功 → 流水与审计各一行；对已冻结校验等使事务失败的输入 → 两者都不落库', ...);
test('reverseRequestCharge：金额=原扣费绝对值、reason=reverse:<原id>、幂等', ...);
test('同一 requestLedgerId 第二条 request_charge 被部分唯一索引拒绝', ...);
test('freeze/unfreeze：条件迁移幂等（二次 freeze 返回 false）、unfreeze 写审计行', ...);
test('append-only 代码守卫：src/ 中不存在 update(walletLedger)', () => {
  const hits = execSync(`grep -rn "update(walletLedger)" src/ || true`, { encoding: 'utf8' }).trim();
  assert.equal(hits, '');
});
```

（测试完整代码按上述断言写全；`request_charge` 行需先在 `request_ledger` 插一行 open 占位再引用其 id——FK 不存在（requestLedgerId 无 FK 约束），可直接引用任意 id 值。）

- [ ] **Step 2: 跑测试确认失败**。

- [ ] **Step 3: 实现三个文件**

```ts
// src/shared/models/portal-admin-audit.ts
import 'server-only';
import { db } from '@/core/db';
import { portalAdminAuditLog } from '@/config/db/schema';
import { getUuid } from '@/shared/lib/hash';

function serialize(v: unknown): string | undefined {
  if (v === undefined) return undefined;
  try { return JSON.stringify(v); } catch { return String(v); }
}

export async function recordPortalAdminAudit(
  input: { action: string; operatorUserId: string; targetType: string; targetId?: string;
    beforeJson?: unknown; afterJson?: unknown; reason?: string },
  writer: any = db()
) {
  await writer.insert(portalAdminAuditLog).values({
    id: getUuid(), action: input.action, operatorUserId: input.operatorUserId,
    targetType: input.targetType, targetId: input.targetId,
    beforeJson: serialize(input.beforeJson), afterJson: serialize(input.afterJson), reason: input.reason,
  });
}
```

```ts
// src/features/wallet/server/ledger.ts
import 'server-only';
import { and, eq } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { db } from '@/core/db';
import { walletAccount, walletLedger } from '@/config/db/schema';
import { getUuid } from '@/shared/lib/hash';

export type WalletEntryType = 'recharge' | 'request_charge' | 'manual_adjustment';

const SIGN_OK: Record<WalletEntryType, (n: number) => boolean> = {
  recharge: (n) => n > 0,
  request_charge: (n) => n < 0,
  manual_adjustment: (n) => n !== 0,
};

export async function ensureWalletAccount(userId: string, tx: any = db()) {
  await tx.insert(walletAccount).values({ userId }).onConflictDoNothing();
}

export async function getWalletAccount(userId: string) {
  const [row] = await db().select().from(walletAccount).where(eq(walletAccount.userId, userId)).limit(1);
  return row ?? null;
}

export async function appendLedgerEntryInTx(tx: any, entry: {
  userId: string; entryType: WalletEntryType; signedAmountMicroUsd: number;
  requestLedgerId?: string; orderNo?: string; idempotencyKey?: string;
  operatorUserId?: string; reason?: string;
}) {
  const amount = entry.signedAmountMicroUsd;
  if (!Number.isSafeInteger(amount)) throw new Error('wallet amount exceeds safe integer');
  if (!SIGN_OK[entry.entryType](amount)) throw new Error(`invalid sign for ${entry.entryType}: ${amount}`);
  if (entry.entryType === 'manual_adjustment' && (!entry.reason || !entry.operatorUserId)) {
    throw new Error('manual_adjustment requires reason and operatorUserId');
  }
  const [account] = await tx
    .update(walletAccount)
    .set({ balanceMicroUsd: sql`${walletAccount.balanceMicroUsd} + ${amount}`, updatedAt: new Date() })
    .where(eq(walletAccount.userId, entry.userId))
    .returning();
  if (!account) throw new Error(`wallet account missing for ${entry.userId}`);
  const ledgerId = getUuid();
  await tx.insert(walletLedger).values({
    id: ledgerId, userId: entry.userId, entryType: entry.entryType,
    signedAmountMicroUsd: amount, balanceAfterMicroUsd: account.balanceMicroUsd,
    requestLedgerId: entry.requestLedgerId, orderNo: entry.orderNo,
    idempotencyKey: entry.idempotencyKey, operatorUserId: entry.operatorUserId, reason: entry.reason,
  });
  return { ledgerId, balanceAfterMicroUsd: account.balanceMicroUsd as number };
}

export class IdempotencyConflictError extends Error {}

export async function applyManualAdjustment(input: {
  userId: string; signedAmountMicroUsd: number; reason: string; operatorUserId: string;
  idempotencyKey: string; // 调用方提供、跨重试稳定（评审 F1）——本函数不生成
  audit?: { action: string; targetType: string; targetId?: string; beforeJson?: unknown; afterJson?: unknown };
}) {
  // 幂等重放必须载荷一致（评审 R5-F6）：同键不同载荷 = 调用方误用 operationId，
  // 谎报 alreadyApplied 会让预期资金操作静默丢失——必须显式冲突
  const readBack = async () => {
    const [row] = await db().select().from(walletLedger)
      .where(eq(walletLedger.idempotencyKey, input.idempotencyKey)).limit(1);
    if (!row) return undefined;
    const payloadMatches =
      row.userId === input.userId &&
      row.signedAmountMicroUsd === input.signedAmountMicroUsd &&
      row.reason === input.reason &&
      row.operatorUserId === input.operatorUserId;
    if (!payloadMatches) {
      throw new IdempotencyConflictError(
        `idempotency key ${input.idempotencyKey} was used with a different payload`
      );
    }
    return row;
  };
  const existing = await readBack();
  if (existing) return { ledgerId: existing.id, balanceAfterMicroUsd: existing.balanceAfterMicroUsd, alreadyApplied: true };
  try {
    const result = await db().transaction(async (tx: any) => {
      await ensureWalletAccount(input.userId, tx);
      const entry = await appendLedgerEntryInTx(tx, {
        userId: input.userId, entryType: 'manual_adjustment',
        signedAmountMicroUsd: input.signedAmountMicroUsd, reason: input.reason,
        operatorUserId: input.operatorUserId, idempotencyKey: input.idempotencyKey,
      });
      if (input.audit) {
        // 资金变更与审计同事务（评审 F1）：审计失败 → 整体回滚，重试凭同一幂等键安全重放
        const { recordPortalAdminAudit } = await import('@/shared/models/portal-admin-audit');
        await recordPortalAdminAudit({ ...input.audit, operatorUserId: input.operatorUserId, reason: input.reason }, tx);
      }
      return entry;
    });
    return { ...result, alreadyApplied: false };
  } catch (error) {
    const row = await readBack(); // 唯一索引并发冲突 → 读回
    if (row) return { ledgerId: row.id, balanceAfterMicroUsd: row.balanceAfterMicroUsd, alreadyApplied: true };
    throw error;
  }
}

export async function reverseRequestCharge(input: { walletLedgerId: string; operatorUserId: string }) {
  const [orig] = await db().select().from(walletLedger).where(eq(walletLedger.id, input.walletLedgerId)).limit(1);
  if (!orig || orig.entryType !== 'request_charge') throw new Error('target is not a request_charge entry');
  // 金额取原流水绝对值，界面不提供金额输入（设计 §6.1）
  return applyManualAdjustment({
    userId: orig.userId, signedAmountMicroUsd: Math.abs(orig.signedAmountMicroUsd),
    reason: `reverse:${orig.id}`, operatorUserId: input.operatorUserId,
    idempotencyKey: `reverse:${orig.id}`,
  });
}
```

```ts
// src/features/wallet/server/freeze.ts
import 'server-only';
import { and, eq, isNotNull, isNull } from 'drizzle-orm';
import { db } from '@/core/db';
import { walletAccount } from '@/config/db/schema';
import { recordPortalAdminAudit } from '@/shared/models/portal-admin-audit';

export async function freezeWallet(input: { userId: string; reason: 'overdraft_auto' | 'manual' | 'refund_in_progress'; frozenBy: string }) {
  const [row] = await db().update(walletAccount)
    .set({ frozenAt: new Date(), freezeReason: input.reason, frozenBy: input.frozenBy, updatedAt: new Date() })
    .where(and(eq(walletAccount.userId, input.userId), isNull(walletAccount.frozenAt)))
    .returning();
  return Boolean(row);
}

// fail-closed 守卫必须配解封出口（管理后台复盘教训 R-7）
export async function unfreezeWallet(input: { userId: string; operatorUserId: string; reason: string }) {
  if (!input.reason.trim()) throw new Error('unfreeze requires reason');
  const [row] = await db().update(walletAccount)
    .set({ frozenAt: null, freezeReason: null, frozenBy: null, updatedAt: new Date() })
    .where(and(eq(walletAccount.userId, input.userId), isNotNull(walletAccount.frozenAt)))
    .returning();
  if (row) {
    await recordPortalAdminAudit({
      action: 'wallet.unfreeze', operatorUserId: input.operatorUserId,
      targetType: 'wallet_account', targetId: input.userId, reason: input.reason,
    });
  }
  return Boolean(row);
}
```

- [ ] **Step 4: 跑测试确认通过**。
- [ ] **Step 5: Commit** `feat(wallet): 带符号追加钱包账本与冻结解冻`

---

### Task 9: `admission.ts` 原子准入与终态迁移

**Files:**
- Create: `src/features/gateway/server/admission.ts`
- Modify: `src/shared/lib/hash.ts`（加 `getUuidV7`）
- Test: `tests/gateway/admission.test.ts`

**Interfaces:**
- Consumes: Task 1 schema、Task 3 `gatewayConfig()`、Task 8 `getWalletAccount`。
- Produces: PLAN.md 契约 `AdmissionInput/admitRequest/resolveRiskLimit/captureRequestId/markFailedUnbilled/markPendingBackfill` + `hash.ts` 新增 `getUuidV7(): string`。

- [ ] **Step 1: `hash.ts` 加 uuidv7**（uuid@13 已含 v7）

```ts
// src/shared/lib/hash.ts —— 在 getUuid 旁追加
import { v4 as uuidv4, v7 as uuidv7 } from 'uuid';

export function getUuidV7(): string {
  return uuidv7();
}
```

- [ ] **Step 2: 写失败测试**（setupDb 模板；`.tmp/gateway-admission.db`。需先播种：user、`catalog_group` 一行拿 groupId——准入 INSERT 的快照字段无 FK 除 user，直接填字符串即可）

```ts
// tests/gateway/admission.test.ts —— 关键用例（完整写全）：
const baseInput = (over: Partial<AdmissionInput> = {}): AdmissionInput => ({
  id: modules.hash.getUuidV7ForTest?.() ?? `preq_${crypto.randomUUID()}`,
  userId: 'u1', portalKeyId: 'k1', portalGroupId: 'g1', portalModelId: 'gpt-5.4',
  newapiGroup: 'official', newapiModelId: 'gpt-5.4', credentialId: 'c1',
  routeVersion: 1, priceVersionId: 'pv1', endpoint: 'chat_completions', isStream: false, ...over,
});

test('占用 9/上限 10：并发 2 → 恰好 1 open 1 拒绝（需求 P0-D）', async () => {
  for (let i = 0; i < 9; i++) assert.equal(await admitRequest(baseInput({ id: `preq_seed_${i}` }), 10), true);
  const [a, b] = await Promise.all([
    admitRequest(baseInput({ id: 'preq_race_a' }), 10),
    admitRequest(baseInput({ id: 'preq_race_b' }), 10),
  ]);
  assert.equal(Number(a) + Number(b), 1, '两并发只放行一个');
  // 第二连接（独立 libsql client 直跑同款 SQL）也被拒 —— 同文件进程组一致性
});

test('pending_backfill 仍占槽：转 pending 后新请求仍被拒', async () => { ... });

test('释放=终态迁移本身：markFailedUnbilled 幂等（二次 false）、释放后可再准入', async () => { ... });

test('captureRequestId：只回填 open 行一次；重复 request id 唯一索引不崩、返回 false', async () => { ... });

test('captureRequestId 不吞非唯一异常（评审 R5-F2）：注入非 UNIQUE 的 DB 异常 → 向上抛（可被调用方重试）', async () => { ... });

test('resolveRiskLimit：override 优先、否则 env 默认 10', async () => { ... });
```

- [ ] **Step 3: 跑测试确认失败**。

- [ ] **Step 4: 实现 `src/features/gateway/server/admission.ts`**

```ts
import 'server-only';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { db } from '@/core/db';
import { requestLedger, walletAccount } from '@/config/db/schema';
import { gatewayConfig } from '@/features/gateway/lib/config';
import type { GatewayEndpointKey } from '@/features/gateway/lib/endpoints';

export interface AdmissionInput {
  id: string; userId: string; portalKeyId: string; portalGroupId: string; portalModelId: string;
  newapiGroup: string; newapiModelId: string; credentialId: string;
  routeVersion: number; priceVersionId: string; endpoint: GatewayEndpointKey; isStream: boolean;
}

// 单语句条件 INSERT：SQLite 单条语句原子 + 单写者，COUNT 与 INSERT 无写入窗口（设计 §7.2，需求 P0-D）
export async function admitRequest(input: AdmissionInput, riskLimit: number): Promise<boolean> {
  const now = Date.now();
  const result = await db().run(sql`
    INSERT INTO request_ledger (id, user_id, portal_key_id, portal_group_id, portal_model_id,
      newapi_group, newapi_model_id, credential_id, route_version, price_version_id,
      endpoint, is_stream, status, created_at, updated_at)
    SELECT ${input.id}, ${input.userId}, ${input.portalKeyId}, ${input.portalGroupId}, ${input.portalModelId},
      ${input.newapiGroup}, ${input.newapiModelId}, ${input.credentialId}, ${input.routeVersion}, ${input.priceVersionId},
      ${input.endpoint}, ${input.isStream ? 1 : 0}, 'open', ${now}, ${now}
    WHERE (
      SELECT COUNT(*) FROM request_ledger
      WHERE user_id = ${input.userId} AND status IN ('open', 'pending_backfill')
    ) < ${riskLimit}
  `);
  return Number(result?.rowsAffected ?? 0) === 1;
}

export async function resolveRiskLimit(userId: string): Promise<number> {
  const [row] = await db().select({ override: walletAccount.riskLimitOverride })
    .from(walletAccount).where(eq(walletAccount.userId, userId)).limit(1);
  return row?.override ?? gatewayConfig().riskSlotLimit;
}

// 唯一冲突 → false（不可重试语义）；其余 DB 异常【上抛】交调用方 persistTerminal 退避重试
//（评审 R5-F2：吞掉 busy 类异常会让调用方误判"未捕获"，成功请求永久失去结算关联）
export async function captureRequestId(ledgerId: string, newapiRequestId: string): Promise<boolean> {
  try {
    const [row] = await db().update(requestLedger)
      .set({ newapiRequestId, respondedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(requestLedger.id, ledgerId), eq(requestLedger.status, 'open'), isNull(requestLedger.newapiRequestId)))
      .returning();
    return Boolean(row);
  } catch (error: any) {
    const message = String(error?.cause ?? error);
    if (/UNIQUE|constraint/i.test(message)) {
      // 同一 request id 重复出现，不可吸收：记录并放弃（该请求后续走 failed_unbilled）
      console.error('[gateway] duplicate newapi_request_id', { ledgerId, newapiRequestId, error: message });
      return false;
    }
    throw error;
  }
}

export async function markFailedUnbilled(ledgerId: string, patch: { httpStatus?: number; errorCode?: string; streamAborted?: boolean }): Promise<boolean> {
  const [row] = await db().update(requestLedger)
    .set({ status: 'failed_unbilled', finishedAt: new Date(), updatedAt: new Date(),
      httpStatus: patch.httpStatus, errorCode: patch.errorCode, streamAborted: patch.streamAborted })
    .where(and(eq(requestLedger.id, ledgerId), inArray(requestLedger.status, ['open', 'pending_backfill'])))
    .returning();
  return Boolean(row); // affected=0 → 已被并发处理，幂等拒绝
}

export async function markPendingBackfill(ledgerId: string, patch: { httpStatus?: number }): Promise<boolean> {
  const [row] = await db().update(requestLedger)
    .set({ status: 'pending_backfill', finishedAt: new Date(), updatedAt: new Date(),
      httpStatus: patch.httpStatus, nextBackfillAt: new Date(Date.now() + 5_000), backfillAttempts: 0 })
    .where(and(eq(requestLedger.id, ledgerId), eq(requestLedger.status, 'open')))
    .returning();
  return Boolean(row);
}
```

- [ ] **Step 5: 跑测试确认通过**。
- [ ] **Step 6: Commit** `feat(gateway): 单语句原子准入与请求账本终态迁移`

---

### Task 10: `settlement.ts` 结算事务

**Files:**
- Create: `src/features/gateway/server/settlement.ts`
- Test: `tests/gateway/settlement.test.ts`

**Interfaces:**
- Consumes: Task 5 `computeChargeMicroUsd/UsageBuckets/PriceVector`、Task 8 `ensureWalletAccount/appendLedgerEntryInTx`、Task 9 终态语义、schema `modelPriceVersion`。
- Produces: PLAN.md 契约 `SettlementUsage/SettleResult/settleByLedgerId/settleByNewapiRequestId`。
- 前置断言：ledger 行无 `newapi_request_id` → 抛错（表 CHECK 是兜底，服务层先显式拒绝）。

- [ ] **Step 1: 写失败测试**（setupDb；播种 user + wallet_account + model_price_version 一行 + request_ledger open 行已 captureRequestId）

```ts
// tests/gateway/settlement.test.ts —— 关键用例（完整写全）：
test('正常结算：终态+桶+金额落库、钱包扣费一条、余额物化正确', async () => {
  // price: input 2_500_000/M；usage: uncachedInput 1000 → charged = ceil(2.5e9/1e6)=2500
  // 断言 request_ledger.status='settled'、charged_micro_usd=2500、settled_at 非空
  // 断言 wallet_ledger 恰一条 request_charge、signed=-2500、balance_after=期初-2500
});
test('结算幂等：同 ledger 二次 settle → already_finalized、流水仍一条', ...);
test('双路径幂等：settleByLedgerId 后 settleByNewapiRequestId 同行 → already_finalized', ...);
test('无 request id 结算被拒（前置断言抛错）', ...);
test('负余额允许（需求决策 9 路径二）：余额 1 结算 2500 → balance=-2499、不冻结（未越阈）', ...);
test('越阈自动冻结：余额 0 结算 10_000_001 → frozen_at 非空、freeze_reason=overdraft_auto、frozen_by=system', ...);
test('已 failed_unbilled 的行不可结算 → already_finalized', ...);
test('余额闭合：全部用例后 balance == Σ signed_amount', ...);
```

- [ ] **Step 2: 跑测试确认失败**。

- [ ] **Step 3: 实现 `src/features/gateway/server/settlement.ts`**

```ts
import 'server-only';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { sql } from 'drizzle-orm';
import { db } from '@/core/db';
import { modelPriceVersion, requestLedger, walletAccount } from '@/config/db/schema';
import { computeChargeMicroUsd, type PriceVector, type UsageBuckets } from '@/features/gateway/lib/billing';
import { gatewayConfig } from '@/features/gateway/lib/config';
import { appendLedgerEntryInTx, ensureWalletAccount } from '@/features/wallet/server/ledger';

export interface SettlementUsage { buckets: UsageBuckets; usageSource: 'response' | 'log_backfill' }
export type SettleResult = 'settled' | 'already_finalized' | 'not_found';

class SettleConflict extends Error {}

export async function settleByLedgerId(ledgerId: string, usage: SettlementUsage): Promise<SettleResult> {
  const [ledger] = await db().select().from(requestLedger).where(eq(requestLedger.id, ledgerId)).limit(1);
  if (!ledger) return 'not_found';
  return settleRow(ledger, usage);
}

export async function settleByNewapiRequestId(newapiRequestId: string, usage: SettlementUsage): Promise<SettleResult> {
  const [ledger] = await db().select().from(requestLedger)
    .where(eq(requestLedger.newapiRequestId, newapiRequestId)).limit(1);
  if (!ledger) return 'not_found';
  return settleRow(ledger, usage);
}

function toPriceVector(price: any): PriceVector {
  return {
    inputMicroUsdPerM: price.inputMicroUsdPerM,
    cachedInputMicroUsdPerM: price.cachedInputMicroUsdPerM,
    cacheWrite5mMicroUsdPerM: price.cacheWrite5mMicroUsdPerM,
    cacheWrite1hMicroUsdPerM: price.cacheWrite1hMicroUsdPerM,
    outputMicroUsdPerM: price.outputMicroUsdPerM,
  };
}

async function settleRow(ledger: any, usage: SettlementUsage): Promise<SettleResult> {
  if (ledger.status === 'settled' || ledger.status === 'failed_unbilled') return 'already_finalized';
  if (!ledger.newapiRequestId) throw new Error(`settlement requires captured newapi_request_id (ledger ${ledger.id})`);
  const [price] = await db().select().from(modelPriceVersion)
    .where(eq(modelPriceVersion.id, ledger.priceVersionId)).limit(1);
  if (!price) throw new Error(`price version ${ledger.priceVersionId} missing`);

  const charged = computeChargeMicroUsd(usage.buckets, toPriceVector(price));
  if (charged > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('charge exceeds safe integer');
  const chargedNum = Number(charged);
  const freezeThreshold = gatewayConfig().overdraftFreezeMicroUsd;
  const now = new Date();

  try {
    return await db().transaction(async (tx: any) => {
      // ① 终态条件 UPDATE —— affected=0 即已被并发/重复处理，整体回滚（幂等守卫）
      const [updated] = await tx.update(requestLedger)
        .set({
          status: 'settled',
          uncachedInputTokens: usage.buckets.uncachedInput, cachedReadTokens: usage.buckets.cachedRead,
          cacheWrite5mTokens: usage.buckets.cacheWrite5m, cacheWrite1hTokens: usage.buckets.cacheWrite1h,
          outputTokens: usage.buckets.output, reasoningTokens: usage.buckets.reasoning,
          usageSource: usage.usageSource, chargedMicroUsd: chargedNum, settledAt: now, updatedAt: now,
        })
        .where(and(eq(requestLedger.id, ledger.id), inArray(requestLedger.status, ['open', 'pending_backfill'])))
        .returning();
      if (!updated) throw new SettleConflict();
      // ② 物化余额 + ③ 扣费流水（无条件入账、允许负 —— 需求决策 9 路径二）
      await ensureWalletAccount(ledger.userId, tx);
      await appendLedgerEntryInTx(tx, {
        userId: ledger.userId, entryType: 'request_charge',
        signedAmountMicroUsd: -chargedNum, requestLedgerId: ledger.id,
      });
      // ④ 越阈自动冻结（按扣费后余额）
      await tx.update(walletAccount)
        .set({ frozenAt: now, freezeReason: 'overdraft_auto', frozenBy: 'system', updatedAt: now })
        .where(and(
          eq(walletAccount.userId, ledger.userId), isNull(walletAccount.frozenAt),
          sql`${walletAccount.balanceMicroUsd} < ${-freezeThreshold}`
        ));
      return 'settled' as const;
    });
  } catch (error) {
    if (error instanceof SettleConflict) return 'already_finalized';
    throw error;
  }
}
```

- [ ] **Step 4: 跑测试确认通过**。
- [ ] **Step 5: Commit** `feat(gateway): 原子结算事务（扣费+物化余额+透支冻结）`

---

### Task 11: 充值链路双写 + 注册钩子 + checkout 开关

**Files:**
- Modify: `src/shared/models/order.ts:206-320`（`updateOrderInTransaction` 加 `newWalletRecharge` 分支）、`src/shared/services/payment.ts`（`handleCheckoutSuccess:151-310` 与 `handlePaymentSuccess:315-443` 的 credit 组装处）、`src/core/auth/config.ts:137-157`（after 钩子）、`src/app/api/payment/checkout/checkout-handler.ts`（入口加开关）
- Test: `tests/payments/wallet-recharge.test.ts`

**Interfaces:**
- Consumes: Task 8 `ensureWalletAccount/appendLedgerEntryInTx`、Task 3 `walletLedgerWriteEnabled/checkoutEnabled`。
- Produces: `updateOrderInTransaction` 新可选参 `newWalletRecharge?: { userId: string; amountMicroUsd: number }`。
- 金额换算：`order.amount` 是**美分**（`schema.sqlite.ts:214` 注释）→ micro-USD = `amount * 10_000`。
- 行为矩阵（设计 §6.3）：开关 off → 完整现状（credit 入账、不写 wallet）；on → PAID 事务内写 `wallet_ledger(recharge, +C, order_no)` + **不组装 newCredit**；`applyApipoolRecharge`（远端推送）两种模式下都原样保留。

- [ ] **Step 1: 写失败测试**（setupDb；播种 user + order(CREATED, amount=500 美分)；构造 session mock 参照 `tests/payments/` 既有用法）

```ts
// tests/payments/wallet-recharge.test.ts —— 关键用例（完整写全）：
test('开关 off：走现状 —— credit 入账、零 wallet 流水', async () => {
  delete process.env.WALLET_LEDGER_WRITE_ENABLED;
  // handleCheckoutSuccess 后：credit 表 1 行、wallet_ledger 0 行
});
test('开关 on：PAID 事务内写 recharge 流水、停写 credit', async () => {
  process.env.WALLET_LEDGER_WRITE_ENABLED = 'true';
  // handleCheckoutSuccess 后：wallet_ledger 1 行 recharge、signed=+5_000_000（500 美分×10^4）、
  // order_no 关联、balance=5_000_000；credit 表 0 行
});
test('wallet-only 事务路径（评审 R7-F4）：无 credit/subscription、仅 newWalletRecharge → 订单 PAID 且钱包流水入账（不命中早退）', ...);
test('webhook 重放幂等：二次 handleCheckoutSuccess → 仍 1 行 recharge（乐观锁+order_no 部分唯一双保险）', ...);
test('注册钩子建 wallet_account：新 user 创建后行存在、balance=0', ...);
test('checkout 创建门控：APIPOOL_CHECKOUT_ENABLED=false/缺失/非法 时创建 checkout 被拒（评审 R16-F1 fail-closed）', ...);
test('结算不受 checkout 门控（评审 R17-F1）：checkoutEnabled()=false（冻结）下 handleCheckoutSuccess 仍照常写 wallet recharge——recharge smoke 因此能在冻结创建期正常通过', ...);
```

- [ ] **Step 2: 跑测试确认失败**。

- [ ] **Step 3: 实现**

`order.ts` **必须先改早退条件（评审 R7-F4，真 bug）**——`updateOrderInTransaction` 现在 `order.ts:221-224` 是 `if (!newSubscription && !newCredit) return updateOrderByOrderNo(...)`（无副作用则不开事务、走单表 update）。wallet-only 充值恰好 `newCredit` 为空、只有 `newWalletRecharge`，会命中早退 → 订单在事务外变 PAID、钱包流水整段跳过、PAID webhook 重放也只跑远端充值补不回。改为：

```ts
// order.ts:221（评审 R7-F4）
if (!newSubscription && !newCredit && !newWalletRecharge) return updateOrderByOrderNo(orderNo, updateOrder);
```

`UpdateOrderTransactionParams` 加 `newWalletRecharge` 字段、结果类型 `result.walletLedgerId?` 同步；事务内 credit 分支（298-314）之后追加：

```ts
    // 钱包充值流水：只有本事务真正把订单翻成 PAID（orderResult 非空）才入账；
    // order_no 部分唯一索引兜底重复（设计 §6.3）
    if (newWalletRecharge && result.order) {
      const { ensureWalletAccount, appendLedgerEntryInTx } = await import('@/features/wallet/server/ledger');
      await ensureWalletAccount(newWalletRecharge.userId, tx);
      const [dupe] = await tx.select().from(walletLedger)
        .where(and(eq(walletLedger.orderNo, orderNo), eq(walletLedger.entryType, 'recharge'))).limit(1);
      if (!dupe) {
        await appendLedgerEntryInTx(tx, {
          userId: newWalletRecharge.userId, entryType: 'recharge',
          signedAmountMicroUsd: newWalletRecharge.amountMicroUsd, orderNo,
        });
      }
    }
```

（`walletLedger`/`and`/`eq` 进 import；动态 import 避免 payment 模块循环依赖，如无循环则改静态。）

`payment.ts` —— `handleCheckoutSuccess` 中 newCredit 组装（252-281）改为：

```ts
    const walletEnabled = walletLedgerWriteEnabled();
    let newCredit: NewCredit | undefined;
    if (!walletEnabled && /* 原 252-281 的组装条件 */) {
      newCredit = { /* 原组装逻辑不动 */ };
    }
    // wallet recharge 是否入账只看 walletEnabled（结算路径【不】受 checkoutEnabled 门控，评审 R17-F1）：
    //   R16 曾试图给结算加 checkoutEnabled 门控 + 延后 + reconcile 补入——衍生三个新 high（smoke 必失败 /
    //   reconcile 绕过冻结误补历史订单 / 早退跳过远端充值），已按 R17 回退。收款【创建】由 checkoutEnabled()
    //   fail-closed 门控（checkout-handler）+ 发布 recharge smoke 保护（deploy.sh 冻结在前替换在后）即足够。
    const newWalletRecharge = walletEnabled && order.creditsAmount && order.creditsAmount > 0
      ? { userId: order.userId, amountMicroUsd: order.amount * 10_000 }
      : undefined;
    const transaction = await updateOrderInTransaction({ orderNo, updateOrder, newSubscription, newCredit, newWalletRecharge });
```

`handlePaymentSuccess` 的一次性支付分支做同款改造。`applyApipoolRecharge` 调用处（291/437-439）**不动**（New API 远端推送不受影响）——一次性充值订单 walletEnabled 下 `newWalletRecharge` 非空、不走早退，`transaction.order` 存在，applyApipoolRecharge 照常执行（评审 R17-F3 随回退消失）。

`src/core/auth/config.ts` after 钩子（137 起）在 `grantRoleForNewUser` 之后追加（沿用既有 try/catch 容错，不阻断注册）：

```ts
        try {
          const { ensureWalletAccount } = await import('@/features/wallet/server/ledger');
          await ensureWalletAccount(user.id);
        } catch (e) {
          console.log('ensure wallet account failed:', e);
        }
```

`checkout-handler.ts` 的 `createTopUpCheckoutResponse` 入口加：

```ts
  if (!checkoutEnabled()) {
    return respErr('Checkout is temporarily disabled for maintenance.');
  }
```

- [ ] **Step 4: 跑测试确认通过**；并跑 `tests/payments/`、`tests/newapi-bridge/billing-ledger.test.ts` 全绿（现状路径不回归）。
- [ ] **Step 5: Commit** `feat(wallet): 充值双写开关接入 PAID 事务与注册钩子`
