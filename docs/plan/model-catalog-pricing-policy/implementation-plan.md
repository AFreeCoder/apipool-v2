# 模型目录基准价格与分组折扣/状态策略实施计划

> **给 agentic worker 的要求：** 实施本计划时使用 `superpowers:executing-plans`，按任务逐项执行；步骤使用 checkbox (`- [ ]`) 追踪。实现阶段不要跳过门禁，不要把未验证价格公开成已确认折扣价。

**目标：** 基于已 APPROVE 的需求与冻结设计，落地“模型主数据 + 模型基准价格 + 分组策略”的价格策略，使公开 `/models` 展示价能被 New API group ratio 或 live/usage 对账证实。

**架构：** New API 继续是真实扣费事实源；APIPool 只负责本地模型目录、基准价同步、分组策略、公开展示 DTO 和后台运营表达。正常公开价使用 New API `group_ratio`，`listing_multiplier` 仅作为经过 usage log 或 quota delta 对账的模型+分组最终倍率例外。

**技术栈：** Next.js App Router、React、Drizzle SQLite schema/migration、libsql/SQLite、node:test、New API server-only client、APIPool smoke scripts。

---

## 0. 输入与硬约束

输入文档：

- `docs/requirements/model-catalog-pricing-policy/requirements.md`
- `docs/design/model-catalog-pricing-policy/DESIGN.md`

不可越过的门禁：

- 未 `matched` 的 `listing_multiplier` 不得公开为已确认折扣价，不得显示折扣 badge、划线价或营销折扣文案。
- `legacy_override`、`needs_live_check`、`drifted`、`missing_group` 不得进入 public confirmed `pricePresentation`。
- 正常公开价路径必须使用 New API group ratio；人工 group ratio 或 listing multiplier 必须通过 live/equivalent usage log 或 quota delta 对账。
- public DTO 不得包含 `newapiGroup`、内部 ID、New API raw payload、admin token、内部 URL、admin-only 状态枚举。
- schema 变更不得只改 TypeScript；必须同时处理 SQLite SQL migration、`meta/_journal.json`、snapshot 与 schema 单源测试。
- 迁移必须非破坏性，不删除旧 listing price 字段；回滚应用版本后旧 `/models` 仍能按旧 listing 字段展示。
- 任何同步失败、远端 pricing 为空、group ratio 无效、live 对账失败，都必须保留旧值并进入 drift/report，不得静默覆盖生产展示价。

## 1. 文件范围

### 1.1 计划文件

- 新增：`docs/plan/model-catalog-pricing-policy/implementation-plan.md`

### 1.2 预期实现会涉及的代码文件

- 修改：`src/config/db/schema.sqlite.ts`
- 修改：`src/config/db/migrations_sqlite/meta/_journal.json`
- 新增或修复：`src/config/db/migrations_sqlite/meta/*_snapshot.json`
- 新增：`src/config/db/migrations_sqlite/0008_model_catalog_pricing_policy.sql`（实际文件名以 Drizzle 生成结果为准，但内容必须可审）
- 修改：`scripts/init-catalog.ts`
- 新增：`scripts/capture-newapi-pricing-fixture.ts`
- 新增：`scripts/backfill-catalog-pricing.ts`
- 修改：`scripts/smoke-mvp.ts`
- 修改：`docs/07-runbook.md`
- 修改：`src/features/api-catalog/lib/pricing.ts`
- 修改：`src/features/api-catalog/lib/types.ts`
- 修改：`src/features/newapi-bridge/server/client.ts`
- 新增：`src/features/api-catalog/server/pricing-sync.ts`
- 修改：`src/features/api-catalog/server/catalog-service.ts`
- 修改：`src/features/api-catalog/server/queries.ts`
- 修改：`src/features/api-catalog/server/model-candidate-search.ts`
- 新增：`src/app/api/apipool/admin/catalog/pricing/sync/route.ts`
- 新增：`src/app/api/apipool/admin/catalog/pricing/drift/route.ts`
- 新增：`src/app/api/apipool/admin/catalog/models/[id]/pricing/refresh/route.ts`
- 新增：`src/app/api/apipool/admin/catalog/models/[id]/pricing/manual/route.ts`
- 新增或修改：`src/app/api/apipool/admin/catalog/models/[id]/listings/[listingId]/price-override/route.ts`
- 修改：`src/app/[locale]/(admin)/admin/catalog/models/page.tsx`
- 修改：`src/app/[locale]/(admin)/admin/catalog/models/model-admin-form.tsx`
- 修改：`src/app/[locale]/(admin)/admin/catalog/models/[id]/edit/page.tsx`
- 修改：`src/app/[locale]/(admin)/admin/catalog/models/[id]/listings/page.tsx`
- 修改：`src/app/[locale]/(admin)/admin/catalog/models/[id]/listings/new/page.tsx`
- 修改：`src/app/[locale]/(admin)/admin/catalog/models/[id]/listings/[listingId]/edit/page.tsx`
- 修改：`src/app/[locale]/(admin)/admin/catalog/groups/page.tsx`
- 修改：`src/app/[locale]/(admin)/admin/catalog/groups/new/page.tsx`
- 修改：`src/app/[locale]/(admin)/admin/catalog/groups/[id]/edit/page.tsx`
- 修改：`src/app/[locale]/(landing)/models/page.tsx`
- 修改：`src/features/api-console/components/api-key-manager.tsx`（仅当 API Key UI 需要适配；即使不改也必须纳入回归测试）
- 修改：API Key 创建请求 helper 所在文件（以现有实现为准；若无改动也必须复跑测试）
- 修改：`src/config/locale/messages/{en,zh}/admin/catalog.json`
- 修改：`src/config/locale/messages/{en,zh}/admin/sidebar.json`（仅当新增 admin 入口需要）

### 1.3 预期测试与 fixture 文件

- 新增：`tests/fixtures/newapi/pricing-snapshot.json`
- 新增：`tests/fixtures/newapi/pricing-snapshot.invalid-group-ratio.json`
- 新增：`tests/fixtures/db/catalog-pricing-legacy.sqlite` 或等价 fixture builder
- 修改：`tests/newapi-bridge/client.test.ts`
- 修改：`tests/api-catalog/catalog-pricing.test.ts`
- 修改：`tests/api-catalog/catalog-service.test.ts`
- 修改：`tests/api-catalog/queries.test.ts`
- 修改：`tests/api-catalog/model-candidate-search.test.ts`
- 修改：`tests/api-catalog/catalog-admin-pages.test.ts`
- 修改：`tests/api-catalog/admin-write-authz.test.ts`
- 新增或修改：`tests/api-catalog/pricing-sync-route.test.ts`
- 新增或修改：`tests/db/catalog-pricing-migration.test.ts`
- 修改：`tests/db/catalog-schema-singlesource.test.ts`
- 修改：`tests/db/init-catalog.test.ts`
- 修改：`tests/api-console/api-key-manager.test.ts`
- 修改：`tests/smoke/mvp-smoke-script.test.ts`

## 2. 阶段总览

1. 证据阶段：抓取或固化 New API `/api/pricing` fixture，先确认 group ratio / usable groups / enabled groups 真实形态。
2. 数据阶段：新增 schema、migration、journal、snapshot、回填 CLI、旧 fixture DB 验证和兼容读门禁。
3. 公式阶段：实现 decimal -> bps、基准价、有效价、drift compare、public/admin DTO mapper。
4. 同步阶段：实现 `getPricingSnapshot()`、pricing sync service、admin sync/drift API 与最小 admin 同步入口。
5. 查询与 DTO 阶段：public/admin DTO 分离，确保公开接口白名单且不泄露内部字段。
6. 后台 UI 阶段：调整模型主数据、基准价格、分组策略、override、sync/drift 状态页面。
7. 公开页面阶段：调整 `/models` 有效价、划线价、折扣/override presentation。
8. 验证阶段：migration、route、unit、page、smoke、live/equivalent 对账全部过门禁。

## 3. 实施任务

### Task 1：New API `/api/pricing` fixture 与事实形态确认

**依赖：** 无。必须最先执行。

**涉及文件：**

- 新增：`scripts/capture-newapi-pricing-fixture.ts`
- 新增：`tests/fixtures/newapi/pricing-snapshot.json`
- 新增：`tests/fixtures/newapi/pricing-snapshot.invalid-group-ratio.json`
- 修改：`tests/newapi-bridge/client.test.ts`

**步骤：**

- [ ] 新增只读 fixture 抓取脚本，调用 New API `GET /api/pricing`，输出前先删除 token、内部 URL、用户标识等敏感字段。
- [ ] 在可访问 New API 的环境尝试抓取真实 fixture。

  ```bash
  NEWAPI_BASE_URL=... NEWAPI_ADMIN_TOKEN=... NEWAPI_ADMIN_USER_ID=... pnpm exec tsx scripts/capture-newapi-pricing-fixture.ts
  ```

- [ ] 如果当前环境不能访问真实 New API，则手工固化 mock fixture，但必须覆盖这些字段形态：`data/items`、`vendors` object/array、`group_ratio/groupRatio/group_ratios`、`usable_group/usable_groups/groups`、per-model `enable_groups`、`quota_type=0`、`quota_type=1`、`image_ratio`。
- [ ] 在 `tests/newapi-bridge/client.test.ts` 中先写失败断言：`getPricingSnapshot()` 必须返回 `models`、`vendors`、`groupRatios.{raw,decimal,bps,sourceKey}`、`usableGroups`、`sourceFingerprint`。
- [ ] 写 invalid fixture 测试：无效 group ratio 不得覆盖旧值的输入条件应能被 parser 标记为无效。
- [ ] 运行定向测试，确认当前实现失败。

  ```bash
  pnpm test tests/newapi-bridge/client.test.ts
  ```

**验收：**

- fixture 不含密钥、内部 URL 或用户 token。
- fixture 覆盖 group ratio、usable groups、enabled groups、fixed-price 和 image price。
- 测试失败点明确指向 `getPricingSnapshot()` 尚未实现或 parser 尚不支持 envelope 字段。

**风险与回滚点：**

- 如果真实 `/api/pricing` 返回空，暂停进入同步实现，先记录环境状态：`NEWAPI_INTEGRATION_ENABLED`、`NEWAPI_ADMIN_TOKEN`、New API pricing 数据、channels/abilities。
- 如果真实 payload 没有 group ratio，不能假设可公开折扣；后续只能走 mock fixture + `needs_live_check` 设计，并把 live fixture 缺口列为发布门禁。

### Task 2：schema、migration、journal、snapshot 与回填执行入口

**依赖：** Task 1 至少已有 fixture 或 mock fixture。

**涉及文件：**

- 修改：`src/config/db/schema.sqlite.ts`
- 新增：`src/config/db/migrations_sqlite/0008_model_catalog_pricing_policy.sql`
- 修改：`src/config/db/migrations_sqlite/meta/_journal.json`
- 新增或修复：`src/config/db/migrations_sqlite/meta/*_snapshot.json`
- 修改：`tests/db/catalog-schema-singlesource.test.ts`
- 修改：`tests/db/init-catalog.test.ts`
- 新增或修改：`tests/db/catalog-pricing-migration.test.ts`
- 新增：`tests/fixtures/db/catalog-pricing-legacy.sqlite` 或等价 fixture builder
- 修改：`scripts/init-catalog.ts`
- 新增：`scripts/backfill-catalog-pricing.ts`
- 修改：`docs/07-runbook.md`

**步骤：**

- [ ] 先审计当前 migration 状态。

  ```bash
  ls src/config/db/migrations_sqlite
  ls src/config/db/migrations_sqlite/meta
  cat src/config/db/migrations_sqlite/meta/_journal.json
  ```

- [ ] 在 `tests/db/catalog-schema-singlesource.test.ts` 写失败断言：存在 `catalog_model_price`、`catalog_price_sync_run`，`catalog_group` 有 group ratio raw/decimal/bps/sync 字段，`catalog_model_listing` 有 price policy/override/drift 字段，journal 和 snapshot 覆盖最新 SQL。
- [ ] 在 `tests/db/init-catalog.test.ts` 写失败断言：初始化后 `catalog_model_price` 存在，且 operator-provided `catalog_group.newapi_group` 不被覆盖。
- [ ] 修改 `schema.sqlite.ts`，只增加非破坏性表/字段；不删除旧 listing price 字段。
- [ ] 生成或手写 migration 后人工审阅 SQL：只允许 `CREATE TABLE`、`ALTER TABLE ADD COLUMN`、安全 backfill，不允许 drop/rename 旧核心字段。
- [ ] 补齐 `_journal.json` 和 snapshot；当前 meta snapshot 落后于 journal 的历史风险必须在本任务内消除。
- [ ] 更新 `scripts/init-catalog.ts`，最小种子写入基准价和 listing policy 默认值，但保留生产已有 `newapiGroup`。
- [ ] 新增 `scripts/backfill-catalog-pricing.ts` 作为生产回填执行入口。migration SQL 只负责结构变更和安全默认值，旧 listing 价格的业务回填必须由该 CLI 执行。
- [ ] backfill CLI 支持至少两个模式：
  - `--mode=report`：只生成差异报告，不写入业务表。
  - `--mode=apply`：在事务内创建缺失的 `catalog_model_price`、标记 listing policy/drift，并写入 `catalog_price_sync_run.report_json`。
- [ ] backfill CLI 必须支持显式数据库 URL，避免误连默认本地库。

  ```bash
  DATABASE_PROVIDER=sqlite DATABASE_URL=file:data/local.db pnpm exec tsx scripts/backfill-catalog-pricing.ts --mode=report
  DATABASE_PROVIDER=sqlite DATABASE_URL=file:data/local.db pnpm exec tsx scripts/backfill-catalog-pricing.ts --mode=apply
  ```

- [ ] 更新 `docs/07-runbook.md` 的发布顺序：备份数据库 -> `pnpm run db:migrate` -> backfill report -> 人工确认 report -> backfill apply -> admin pricing sync -> drift 检查 -> public DTO 切换 -> live/equivalent 对账。
- [ ] 在 `tests/db/catalog-pricing-migration.test.ts` 使用旧 fixture DB 跑 migration + backfill CLI apply，断言：
  - 每个 `catalog_model` 都有一条 `catalog_model_price`。
  - 旧 `catalog_model_listing.input_micro_usd/output_micro_usd/image_*` cache 值未变化。
  - 冲突 listing 进入 report，并被标记为 `legacy_override + needs_live_check` 或 `price_drift_status = drifted`，不得是 `matched`。
  - 缺基准价时 public 查询不崩，且不输出 confirmed discount presentation。
  - 迁移前后旧公开展示价不跳变。
- [ ] 运行定向测试。

  ```bash
  pnpm test tests/db/catalog-schema-singlesource.test.ts tests/db/init-catalog.test.ts tests/db/catalog-pricing-migration.test.ts
  ```

**验收：**

- schema、SQL migration、journal、snapshot、测试对同一结构达成一致。
- 旧 listing price 字段仍存在，旧代码可回滚读取。
- seed 不覆盖运营已配置的 `newapiGroup`。
- 生产回填入口明确为 `scripts/backfill-catalog-pricing.ts`；admin sync route 不是首次回填入口。
- 旧 fixture DB 证明 migration + backfill 不改变 listing cache，冲突进入 report，缺基准价 public 不崩，旧展示价不跳变。

**风险与回滚点：**

- 如果 Drizzle 生成 snapshot 与现有 `_journal.json` 不一致，暂停后续开发，先单独修复 migration 生成策略。
- 这是数据库门禁；未通过前不得进入 service/UI 实现。
- 如果旧 fixture DB 的 listing cache 出现变化，回滚本任务实现，禁止 public DTO 切换。

### Task 3：价格公式、decimal 规范与 DTO mapper

**依赖：** Task 2 schema 字段确定。

**涉及文件：**

- 修改：`src/features/api-catalog/lib/pricing.ts`
- 修改：`src/features/api-catalog/lib/types.ts`
- 修改：`tests/api-catalog/catalog-pricing.test.ts`

**步骤：**

- [ ] 写失败测试覆盖 decimal parser：数字和字符串输入、trim、尾随 0、非法值、负数、`NaN`、`Infinity`。
- [ ] 写失败测试覆盖 `round_half_up(decimal * 10000)`，例如 `1 -> 10000`、`0.5 -> 5000`、`0.33335 -> 3334`。
- [ ] 写失败测试覆盖基准价：`model_ratio * 2`、`completion_ratio`、`image_ratio`、`quota_type=1` fixed-price 不生成 token split。
- [ ] 写失败测试覆盖有效价：`inherit_group` 使用 New API group ratio；未 `matched` 的 `listing_multiplier` 不返回 public confirmed presentation；verified override 需要 `override_status=verified` 且 drift matched。
- [ ] 写失败测试覆盖 quota 对账：同一 normalized bps 生成 effective micro-USD，再转 expected quota。
- [ ] 实现 `pricing.ts` 中的集中函数：decimal 规范化、base price 推导、effective price 解析、drift compare、quota spend。
- [ ] 在 `types.ts` 拆出 `PublicCatalogListingDto` 与 `AdminPricingSummaryDto`，并新增 mapper 输入/输出类型。
- [ ] 运行定向测试。

  ```bash
  pnpm test tests/api-catalog/catalog-pricing.test.ts
  ```

**验收：**

- 公式只在 `pricing.ts` 集中实现，页面、route、service 不重复写价格算法。
- public mapper 默认拒绝未 matched multiplier/legacy override。
- 所有金额最终以 integer micro-USD 参与 public 展示和 quota 对账。

**风险与回滚点：**

- 如果实现需要引入 decimal 第三方库，先评估依赖体积和 Node/edge 兼容；否则用小范围 decimal 字符串工具。
- 如果测试发现旧 `discount_rate_bps` 语义和新 bps 不兼容，优先保留旧字段为 legacy cache，不要直接复用成公开折扣。

### Task 4：New API client `getPricingSnapshot()` 与候选搜索兼容

**依赖：** Task 1 fixture、Task 3 parser。

**涉及文件：**

- 修改：`src/features/newapi-bridge/server/client.ts`
- 修改：`src/features/api-catalog/server/model-candidate-search.ts`
- 修改：`tests/newapi-bridge/client.test.ts`
- 修改：`tests/api-catalog/model-candidate-search.test.ts`

**步骤：**

- [ ] 在 `client.test.ts` 完成 Task 1 中的失败用例，覆盖 envelope 解析、success=false、401/timeout、invalid group ratio。
- [ ] 实现 `getPricingSnapshot()`，保留 `listPricingModels()` 兼容包装。
- [ ] `groupRatios` 输出 raw/decimal/bps/sourceKey，不暴露 float number。
- [ ] `sourceFingerprint` 使用排序后的规范化结构和 raw 值生成；payload 顺序变化不误报。
- [ ] 更新 `model-candidate-search.ts`，继续按本地 vendor 与映射后的 New API group 过滤 `enable_groups`，但复用 `getPricingSnapshot()`。
- [ ] 运行定向测试。

  ```bash
  pnpm test tests/newapi-bridge/client.test.ts tests/api-catalog/model-candidate-search.test.ts
  ```

**验收：**

- `listPricingModels()` 旧调用仍可用。
- 浏览器仍不能直连 New API；New API admin token 不进响应、不进日志。
- New API `/api/pricing` 为空或失败时，不清空本地旧价格。

**风险与回滚点：**

- 如果 New API 真实 payload 与 fixture 不同，先扩展 parser 和 fixture，再继续 service 实现。
- 如果 group ratio 在 New API 里只能从 `GroupRatio` 配置间接获得，保留 `pricing_sync_status=missing_remote_group/manual`，不得公开确认折扣。

### Task 5：pricing sync service、回填与 drift report

**依赖：** Task 2 schema、Task 3 公式、Task 4 client。

**涉及文件：**

- 新增：`src/features/api-catalog/server/pricing-sync.ts`
- 修改：`src/features/api-catalog/server/catalog-service.ts`
- 新增：`scripts/backfill-catalog-pricing.ts`
- 修改：`tests/api-catalog/catalog-service.test.ts`
- 修改：`tests/api-catalog/catalog-pricing.test.ts`
- 修改：`tests/db/catalog-pricing-migration.test.ts`

**步骤：**

- [ ] 写失败测试覆盖旧 listing 回填：official list price 优先、official effective fallback、所有 listing 一致、不一致进入 `legacy_override + needs_live_check`。
- [ ] 写失败测试覆盖 sync run：成功、partial、failed、fixed-price、missing group、invalid group ratio、drifted。
- [ ] 实现 `pricing-sync.ts`：`backfillCatalogModelPrices()`、`syncCatalogPricingFromSnapshot()`、`buildCatalogPriceDriftReport()`、`resolveAndCacheEffectivePrices()`。
- [ ] 将 `scripts/backfill-catalog-pricing.ts` 接到 `backfillCatalogModelPrices()`，确保生产首次回填只能通过 CLI 明确执行；admin sync route 不负责自动补历史基准价。
- [ ] backfill CLI 在 `--mode=report` 输出 summary 和 report file path；在 `--mode=apply` 输出 created/updated/conflict/skipped 数量和 sync run id。
- [ ] 确保 sync 失败保留旧值，写 `catalog_price_sync_run.report_json`，不覆盖 public effective cache。
- [ ] 确保 `listing_multiplier` 新建/迁移默认 `needs_live_check`，只有 usage/quota 对账证据才能转 `matched`。
- [ ] 更新 `catalog-service.ts` admin 聚合读写，读写模型主数据、基准价格和 listing policy，但保留旧 wrapper 兼容现有页面。
- [ ] 运行定向测试。

  ```bash
  pnpm test tests/api-catalog/catalog-service.test.ts tests/api-catalog/catalog-pricing.test.ts
  ```

**验收：**

- 回填不平均、不最低价、不最高价静默推导。
- conflict report 包含模型、分组、旧价、基准价、group ratio、建议公式、差异、处理建议。
- 未 matched 的价格永远不会被 service 标成 public confirmed。
- backfill service、CLI 和 migration fixture test 使用同一回填逻辑，避免测试走一套、生产执行走另一套。

**风险与回滚点：**

- 如果回填发现生产数据大量冲突，暂停 public 切换，先只上线 admin drift report。
- 回滚应用版本时新表新字段可保留不用，旧 listing 字段仍可读。
- 如果 CLI apply 中途失败，必须事务回滚；重新执行前先跑 `--mode=report` 核对当前状态。

### Task 6：admin pricing API routes 与权限

**依赖：** Task 5 service。

**涉及文件：**

- 新增：`src/app/api/apipool/admin/catalog/pricing/sync/route.ts`
- 新增：`src/app/api/apipool/admin/catalog/pricing/drift/route.ts`
- 新增：`src/app/api/apipool/admin/catalog/models/[id]/pricing/refresh/route.ts`
- 新增：`src/app/api/apipool/admin/catalog/models/[id]/pricing/manual/route.ts`
- 新增或修改：`src/app/api/apipool/admin/catalog/models/[id]/listings/[listingId]/price-override/route.ts`
- 修改：`tests/api-catalog/admin-write-authz.test.ts`
- 新增或修改：`tests/api-catalog/pricing-sync-route.test.ts`

**步骤：**

- [ ] 写失败测试：write routes 要求 `admin.catalog.write`；drift read route 要求 `admin.catalog.read`。
- [ ] 写失败测试：route response 不含 admin token、internal URL、public 不该有的 raw payload。
- [ ] 写失败的 route integration 测试：使用 Task 1 fixture mock New API `/api/pricing`，以 admin 身份调用 `POST /api/apipool/admin/catalog/pricing/sync`，断言：
  - `catalog_model_price` 写入 base price、pricing mode、source fingerprint、source synced at。
  - `catalog_group` 写入 group ratio raw/decimal/bps 和 pricing sync status。
  - `catalog_price_sync_run` 写入 success/partial 状态、raw report 摘要、fingerprint、matched/drift/missing group 统计。
  - listing effective cache 只在 matched 条件满足时更新，未 matched multiplier 保持 `needs_live_check`。
- [ ] 写失败的 drift route integration 测试：先制造一次 sync report，再调用 `GET /api/apipool/admin/catalog/pricing/drift`，断言能读到最近 sync run、conflict report、missing group 和 fixed-price 待确认项。
- [ ] 实现 sync route，调用 server-only New API client 和 `pricing-sync.ts`。
- [ ] 实现 drift route，返回最近 sync run 与 drift summary。
- [ ] 实现单模型 refresh/manual route，manual 必须提交 reason。
- [ ] 实现 listing price override route，必须提交 reason、override 状态，并按状态门禁写入。
- [ ] 运行定向测试。

  ```bash
  pnpm test tests/api-catalog/admin-write-authz.test.ts tests/api-catalog/pricing-sync-route.test.ts
  ```

**验收：**

- 所有写接口有 RBAC。
- admin DTO 可以包含 `newapiGroup`，但 public/user DTO 仍禁止。
- failed sync 不清空旧价格，返回可读错误和 sync run id。
- sync route 成功路径真实落库；drift route 能读到最近 report，不只是 authz 通过。

**风险与回滚点：**

- 如果权限常量缺失，先补权限 seed/test，不要临时复用过宽权限。
- 如果 route 无法稳定 mock New API，不得删掉成功路径覆盖；应把 New API client 注入点或 fetch mock 收窄到 route integration test 内，避免真实网络 flaky。

### Task 7：public/admin DTO 拆分与查询层切换

**依赖：** Task 2 migration/backfill fixture test、Task 3 mapper、Task 5 service。

**涉及文件：**

- 修改：`src/features/api-catalog/server/queries.ts`
- 修改：`src/features/api-catalog/lib/types.ts`
- 修改：`tests/api-catalog/queries.test.ts`

**步骤：**

- [ ] 写失败测试：`getPublicListingsUncached()` 返回 `PublicCatalogListingDto` 白名单，不含 `newapiGroup`、`groupId`、`listingId`、`basePriceId`、raw source、admin status。
- [ ] 写失败测试：matched `inherit_group` 返回 effective price 和可解释划线价；`needs_live_check/legacy_override/drifted/missing_group` 不返回 discount presentation。
- [ ] 写失败测试：`AdminPricingSummaryDto` mapper 包含 base/source/sync/override/drift 但仅用于 admin service。
- [ ] 写 public DTO 切换前门禁测试：基于旧 fixture DB 完成 migration + backfill 后调用 public query，断言 listing cache 未变化、旧展示价不跳变、缺基准价 public 不崩、冲突 listing 不输出 confirmed discount presentation。
- [ ] 修改 query join `catalog_model_price`、`catalog_group`、`catalog_model_listing`，读取 effective cache 和 formula status。
- [ ] 保留旧字段 alias 的内部兼容层，避免一次性改坏页面。
- [ ] 只有在 Task 2 的旧 fixture DB 验证、Task 5 的回填 report 和本任务 public query 门禁都通过后，才允许 `/models` 切到 `PublicCatalogListingDto`。
- [ ] 运行定向测试。

  ```bash
  pnpm test tests/api-catalog/queries.test.ts
  ```

**验收：**

- public DTO 是白名单输出。
- public 测试继续断言不泄露 `newapiGroup`。
- 未 matched price 不会在 public JSON 中表现成已确认折扣。
- public DTO 切换前已证明 migration + backfill 不改变旧展示价，缺基准价不导致 public 崩溃。

**风险与回滚点：**

- 如果页面依赖旧 `ListingRow` 字段较多，先在 server mapper 保留内部 alias，再逐页切换，不要把 admin 字段塞回 public DTO。
- 如果旧 fixture DB public query 出现价格跳变，暂停 `/models` 切换，继续走旧兼容价展示并隐藏新折扣 presentation。

### Task 8：后台模型主数据、基准价格和分组策略 UI

**依赖：** Task 6 routes、Task 7 admin DTO。

**涉及文件：**

- 修改：`src/app/[locale]/(admin)/admin/catalog/models/page.tsx`
- 修改：`src/app/[locale]/(admin)/admin/catalog/models/model-admin-form.tsx`
- 修改：`src/app/[locale]/(admin)/admin/catalog/models/[id]/edit/page.tsx`
- 修改：`src/app/[locale]/(admin)/admin/catalog/models/[id]/listings/page.tsx`
- 修改：`src/app/[locale]/(admin)/admin/catalog/models/[id]/listings/new/page.tsx`
- 修改：`src/app/[locale]/(admin)/admin/catalog/models/[id]/listings/[listingId]/edit/page.tsx`
- 修改：`src/app/[locale]/(admin)/admin/catalog/groups/page.tsx`
- 修改：`src/app/[locale]/(admin)/admin/catalog/groups/new/page.tsx`
- 修改：`src/app/[locale]/(admin)/admin/catalog/groups/[id]/edit/page.tsx`
- 修改：`src/config/locale/messages/{en,zh}/admin/catalog.json`
- 修改：`tests/api-catalog/catalog-admin-pages.test.ts`

**步骤：**

- [ ] 写失败测试：模型列表显示基准价来源、同步状态、drift 状态、fixed-price 提示。
- [ ] 写失败测试：admin 模型列表或 pricing summary 区提供最小 sync/drift 入口，包含“同步 New API 价格”和“查看漂移报告”控件。
- [ ] 写失败测试：sync 按钮有 loading、success、error 三种状态；success 显示 sync run id 或更新时间，error 显示可读错误但不泄露 token/internal URL。
- [ ] 写失败测试：drift report 入口能展示最近 report 的 missing group、drifted、fixed-price review、needs live check 计数。
- [ ] 写失败测试：listing 策略页显示 group ratio、price policy、override status、price drift status、effective preview。
- [ ] 写失败测试：group 页面显示 `newapiGroup`、group ratio raw/decimal/bps、pricing sync status。
- [ ] 修改 admin 页面，保持管理功能在 `/admin`，不放入 `/dashboard`。
- [ ] 接入 Task 6 的 sync/drift route；首版 UI 只需要最小入口，不必做复杂批量编辑器。
- [ ] `listing_multiplier` UI 必须显示 live check 状态；未 matched 时按钮/文案不得暗示“已生效折扣”。
- [ ] override 表单必须要求 reason；`verified` 状态旁展示最近对账证据或人工确认字段。
- [ ] 更新中英文文案，避免 raw i18n key。
- [ ] 运行页面/静态测试。

  ```bash
  pnpm test tests/api-catalog/catalog-admin-pages.test.ts
  ```

**验收：**

- admin 能区分模型主数据、基准价格、分组策略。
- admin 页面展示价格来源、同步状态、override 状态和 drift 证据。
- admin 首版提供最小 sync/drift 入口，并覆盖 loading/success/error。
- raw key 不应出现在 admin catalog 页面测试中。

**风险与回滚点：**

- 如果 UI 工作量过大，仍必须保留最小 sync/drift 入口；可以延后复杂编辑控件，但不得退化为完全无 UI 的 route-only 方案，也不得为了赶 UI 放宽 public 价格门禁。

### Task 9：公开 `/models` price presentation

**依赖：** Task 7 public DTO。

**涉及文件：**

- 修改：`src/app/[locale]/(landing)/models/page.tsx`
- 修改：`tests/api-catalog/queries.test.ts`
- 修改或新增：`tests/api-catalog/models-filter.test.ts`

**步骤：**

- [ ] 写失败测试：matched group ratio 折扣显示 effective price、可解释划线价、折扣 label。
- [ ] 写失败测试：无折扣时不显示划线价。
- [ ] 写失败测试：verified override 可显示明确但不泄露内部 override 枚举。
- [ ] 写失败测试：`needs_live_check/legacy_override/drifted/missing_group` 不显示折扣 badge、划线价或已确认折扣文案。
- [ ] 修改 `/models` 页面只消费 `PublicCatalogListingDto.pricePresentation`，不自行推导价格。
- [ ] 保持页面不输出 `newapiGroup`、内部 group id、New API 后台名或内部 URL。
- [ ] 运行定向测试。

  ```bash
  pnpm test tests/api-catalog/queries.test.ts tests/api-catalog/models-filter.test.ts
  ```

**验收：**

- 公开页面展示的每个有效价都能追溯到 matched 公式或 verified override。
- 折扣/划线价只在 matched 且可解释时出现。
- 页面层不实现价格公式。

**风险与回滚点：**

- 如果部分 listing 未 matched，页面应隐藏折扣 presentation 或临时不公开该 listing，不能展示旧营销折扣。

### Task 10：API Key 分组创建与 smoke 对齐

**依赖：** Task 5 drift/status，Task 7 public DTO。

**涉及文件：**

- 修改：`src/features/newapi-bridge/server/portal.ts`
- 修改或复核：`src/features/api-console/components/api-key-manager.tsx`
- 修改或复核：API Key 创建请求 helper 所在文件（以现有实现为准）
- 修改：`tests/newapi-bridge/create-portal-key.test.ts`
- 修改或复跑：`tests/api-console/api-key-manager.test.ts`
- 修改：`scripts/smoke-mvp.ts`
- 修改：`tests/smoke/mvp-smoke-script.test.ts`

**步骤：**

- [ ] 保持 API Key 创建只接受 `groupSlug`，服务端解析 `catalog_group.newapi_group`。
- [ ] 写失败测试：public response 和 dashboard API Key UI 不泄露 `newapiGroup`。
- [ ] 复核 `api-key-manager.tsx` 和 API Key 创建请求 helper：请求 payload 只能包含公开 `groupSlug`，不能把 `newapiGroup`、内部 group id 或 pricing status 带到浏览器。
- [ ] 即使本任务不改 API Key UI，也必须复跑 `tests/api-console/api-key-manager.test.ts`，作为 dashboard UI 泄漏回归门禁。
- [ ] 写失败测试：disabled、`allowCreateKey=false`、`newapiGroup` 为空、远端 group 不可用时，在远端调用前失败或返回可审计错误。
- [ ] 扩展 smoke：记录模型、groupSlug、effective price、tokens、expected quota、actual quota/log cost、delta、tolerance。
- [ ] 增加可选 env 门禁：`APIPOOL_SMOKE_PRICE_RECONCILIATION=true` 时必须做 usage log 或 quota delta 对账。
- [ ] 运行定向测试。

  ```bash
  pnpm test tests/newapi-bridge/create-portal-key.test.ts tests/api-console/api-key-manager.test.ts tests/smoke/mvp-smoke-script.test.ts
  ```

**验收：**

- 用户输入仍是 `groupSlug`，内部 `newapiGroup` 只在 server/admin 存在。
- dashboard API Key UI 与请求 helper 通过回归测试，不泄露内部 group 或 pricing 状态。
- smoke 能区分价格公式不匹配、New API 健康问题、渠道不可用、门户代码问题。

**风险与回滚点：**

- 如果 New API usage log 延迟，smoke 先重试；仍不可用时用调用前后 user quota delta。
- 如果 usage log 和 quota delta 都不可用，不得标记 `matched`，发布进入暂停条件。

### Task 11：migration、route、unit、page 全量验证

**依赖：** Task 1-10。

**涉及文件：**

- 修改：所有上述测试文件。

**步骤：**

- [ ] 跑 pricing/client/schema/query/admin 定向测试。

  ```bash
  pnpm test tests/newapi-bridge/client.test.ts tests/api-catalog/catalog-pricing.test.ts tests/api-catalog/catalog-service.test.ts tests/api-catalog/queries.test.ts tests/api-catalog/model-candidate-search.test.ts tests/api-catalog/catalog-admin-pages.test.ts tests/api-catalog/admin-write-authz.test.ts tests/api-catalog/pricing-sync-route.test.ts tests/db/catalog-schema-singlesource.test.ts tests/db/init-catalog.test.ts tests/db/catalog-pricing-migration.test.ts tests/api-console/api-key-manager.test.ts
  ```

- [ ] 跑 smoke 脚本测试。

  ```bash
  pnpm test tests/smoke/mvp-smoke-script.test.ts
  ```

- [ ] 跑全量测试。

  ```bash
  pnpm test
  ```

- [ ] 跑 TypeScript。

  ```bash
  pnpm exec tsc --noEmit --pretty false
  ```

- [ ] 跑 lint。

  ```bash
  pnpm run lint
  ```

- [ ] 如涉及 UI 文案和页面，跑 build。

  ```bash
  pnpm run build
  ```

- [ ] 复核公开泄漏。

  ```bash
  rg -n "newapiGroup|newapi_group|NEWAPI_ADMIN_TOKEN|New-Api-User|source_model_ratio|override_status|drift_status" src/app src/features tests
  ```

  预期：命中只应出现在 server/admin/test 语境；public mapper、landing `/models` 和 dashboard response 不应暴露这些字段。

**验收：**

- 定向测试、全量测试、TypeScript、lint 通过。
- build 通过或明确说明失败与本改动无关且有证据。
- `rg` 复核没有 public 泄漏。
- route integration、旧 fixture DB migration/backfill、API console dashboard UI 回归都纳入最终验证。

**风险与回滚点：**

- 如果全量测试暴露 unrelated 失败，先记录证据并跑相关定向测试；不要顺手修无关模块。
- 如果 public 泄漏 grep 命中无法解释，暂停发布并回修 DTO 边界。

### Task 12：live/equivalent usage log 或 quota delta 对账门禁

**依赖：** Task 10 smoke 能力，Task 11 本地验证。

**涉及文件：**

- 修改：`docs/07-runbook.md`（实现阶段如需要把门禁常青化）
- 修改：`scripts/smoke-mvp.ts`
- 修改：`tests/smoke/mvp-smoke-script.test.ts`

**步骤：**

- [ ] 准备一个 `available + smoke_tested + price_drift_status=matched` 的 listing，优先 `price_policy=inherit_group` 且 group ratio 来自 New API `synced`。
- [ ] 创建该分组 API Key。
- [ ] 发起一次真实或等价 New API 调用。
- [ ] 读取 New API usage log 的 `prompt_tokens/completion_tokens/quota/model_name`；如果 log 延迟，读取调用前后用户 quota delta。
- [ ] 用 APIPool effective micro-USD 和 normalized bps 计算 expected quota。
- [ ] 输出 expected、actual、delta、tolerance、模型、groupSlug、sync run id。
- [ ] delta 在 tolerance 内时才允许该 listing 保持或写入 `matched`。
- [ ] delta 超阈值时 smoke fail，listing 保持 `needs_live_check` 或转 `drifted`，不得公开为已确认折扣价。

**命令：**

```bash
APIPOOL_SMOKE_REQUIRE_LIVE=true APIPOOL_SMOKE_PRICE_RECONCILIATION=true pnpm run smoke:mvp
```

**验收：**

- 至少一个 live/equivalent 调用证明展示价公式与 New API 实际扣费口径一致。
- 对账证据能被 admin drift 页面或 smoke 输出引用。

**风险与回滚点：**

- 如果 live/equivalent 环境不可用，不能宣布开发完成，只能标记“实现完成但发布门禁未过”。
- 如果对账失败，暂停公开切换，回到 Task 3/5 校准公式或 group ratio 解析。

## 4. 阶段门禁与回滚策略

### 4.1 数据门禁

- `catalog_model_price` 和 `catalog_price_sync_run` 必须通过 schema 单源测试。
- migration 必须非破坏性；不得 drop 旧 listing price 字段。
- `_journal.json` 和 snapshot 必须与 SQL migration 一致。
- 旧 fixture DB 必须通过 migration + backfill CLI apply 验证：每个模型有基准价、listing cache 不变、冲突进入 report、缺基准价 public 不崩、旧展示价不跳变。
- 生产发布前必须用只读 SQL 验证目标字段真实存在。

回滚点：回滚应用版本；新表/新字段保留不用，旧代码继续读取旧 listing price。

生产执行入口：

```bash
pnpm run db:migrate
DATABASE_PROVIDER=sqlite DATABASE_URL=file:/path/to/prod.db pnpm exec tsx scripts/backfill-catalog-pricing.ts --mode=report
DATABASE_PROVIDER=sqlite DATABASE_URL=file:/path/to/prod.db pnpm exec tsx scripts/backfill-catalog-pricing.ts --mode=apply
```

执行顺序必须写入 `docs/07-runbook.md`，并要求 report 人工确认后才能 apply。

### 4.2 价格门禁

- `inherit_group` 正常价必须来自 New API group ratio。
- `listing_multiplier` 必须有 live/usage 对账证据才能 `matched`。
- `legacy_override` 默认是运营待处理证据，不是公开折扣来源。
- `fixed_price_review` 不得伪造 token 输入/输出价。

回滚点：停用 pricing sync route，保留最近有效 cache；public mapper 隐藏 discount presentation。

### 4.3 公开 DTO 门禁

- public mapper 白名单输出。
- admin DTO 和 public DTO 禁止共用同一个可被直接序列化的大对象。
- public `/models` 不自行推导价格，只消费 `pricePresentation`。
- public DTO 切换必须等 backfill CLI、旧 fixture DB 门禁、sync/drift report 和 queries public 门禁通过。

回滚点：回退 `/models` 到旧兼容价展示，但隐藏新折扣/划线价。

### 4.4 live 门禁

- live/equivalent 对账未通过时，不得把该功能标为可发布完成。
- usage log 不可用时可用 quota delta；两者都不可用时暂停。

回滚点：保持 listing `needs_live_check`，后台展示待验证，public 不展示 confirmed 折扣。

## 5. 完成定义

实现完成必须同时满足：

- `getPricingSnapshot()` 支持 fixture 覆盖的 `/api/pricing` payload，包含 group ratio raw/decimal/bps、usable groups、enabled groups、fixed-price 和 image price。
- schema、migration、journal、snapshot、seed、schema 单源测试全部一致。
- 生产回填入口明确为 `scripts/backfill-catalog-pricing.ts`，并已在旧 fixture DB 上验证 migration + backfill 不改变 listing cache、不造成旧展示价跳变。
- `pricing.ts` 集中实现 decimal -> bps、base price、effective price、drift compare、quota spend，且单测覆盖。
- pricing sync service 和 admin sync route 能同步基准价、group ratio、drift report，并在失败时保留旧值；route integration 测试覆盖成功落库和 drift report 读取。
- public/admin DTO 已拆分，公开 JSON 不泄露 `newapiGroup`、内部 ID、raw source、admin status。
- admin 页面能展示价格来源、同步状态、override 状态、group ratio、drift 状态和 live check 状态，并提供最小 sync/drift 入口及 loading/success/error 状态。
- API Key dashboard UI 和请求 helper 回归测试通过，确认只使用 `groupSlug` 且不泄露 `newapiGroup`。
- `/models` 展示 effective price、划线价和折扣 presentation，且只在 matched / verified 时出现。
- migration、route、unit、page、smoke 测试通过。
- 至少一个 live/equivalent 调用通过 usage log 或 quota delta 对账。

## 6. 暂停 / 回修条件

遇到以下任一情况，执行 agent 必须暂停当前阶段并回修，不得继续扩大实现范围：

- 真实 `/api/pricing` payload 与 fixture 差异导致 group ratio 无法解析。
- New API pricing 为空且无法确认是环境问题还是数据问题。
- migration journal/snapshot 与 SQL 不一致。
- 旧 fixture DB migration + backfill 后 listing cache 变化、旧展示价跳变、缺基准价 public 崩溃，或冲突没有进入 report。
- 回填发现大量 listing 无法解释，且会影响公开价格稳定性。
- admin sync route 没有成功路径 integration 测试，或 drift route 读不到最近 report。
- admin 页面没有最小 sync/drift 入口或缺 loading/success/error 验证。
- API Key dashboard UI 回归测试无法证明不泄露 `newapiGroup`。
- 任一 public DTO 或页面响应泄露 `newapiGroup`、内部 ID、raw source、admin status 或 token。
- 未 matched 的 `listing_multiplier`、`legacy_override`、`needs_live_check` 出现在公开折扣/划线价 presentation。
- live/equivalent 对账 delta 超过 tolerance。
- smoke 失败无法区分是价格公式、分组配置、New API 健康、渠道不可用还是门户代码问题。
- worktree 出现与本功能无关的大范围改动；先拆 scope，不要混发。

## 7. 建议执行顺序

- 第一批提交：Task 1 fixture 与 client 失败测试。
- 第二批提交：Task 2 schema/migration/journal/snapshot/seed/backfill CLI/旧 fixture DB 验证。
- 第三批提交：Task 3 pricing core 与 DTO 类型。
- 第四批提交：Task 4-6 client、sync service、admin routes、sync/drift route integration。
- 第五批提交：Task 7-9 DTO 查询、admin 最小 sync/drift UI、public `/models`。
- 第六批提交：Task 10-12 smoke、全量验证、live/equivalent 门禁。

每批提交前至少跑对应定向测试；进入最后一批前必须先通过 schema、migration fixture、pricing、client、route integration、queries、API console 七组定向测试。
