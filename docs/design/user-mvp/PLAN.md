# APIPool user-mvp 实现计划（Implementation Plan）

> **执行方式（重要）**：本计划是 **multi-agent-dev-iteration** skill 的输入，而非 superpowers 标准执行流。每个「Step」= dev-iteration 的一个迭代单元（Codex TDD 主笔 → 独立 Claude 评审 → 收敛判定，硬上限 M=5 / 连续无净进展 K=2）。**不**走 subagent-driven-development / executing-plans。
>
> Step 内的「TDD 微步骤」是给 Codex 主笔的执行骨架（先写测试→跑失败→最小实现→跑绿→提交）；具体实现代码由 Codex 在 worktree 内自主完成（TDD 要求主笔自己写测试与实现）。本计划负责锁定**范围边界、文件清单、依赖序、验收标准（F 映射 + 具体断言）、关键约束（引用冻结 DESIGN）**。

**Goal:** 把 APIPool 模型目录从硬编码迁到 DB + 后台 CRUD，建 Key 选分组，接回登录设置页，补齐支付展示与管理员额度运营，让真实用户完成「注册/登录 → 充值/发放额度 → 看模型价格 → 选分组建 Key → 真实调用 → 控制台看余额用量」完整自助闭环。

**Architecture:** 7 张 `catalog_*` 表（sqlite-only，遵循 bridge 表先例）承载供应商/能力/状态/分组/模型本体/模型能力关联/分组售卖项；`/models` 与建 Key 数据源从 `import publicModels` 切到 `api-catalog/server/queries.ts`（`'server-only'` + `unstable_cache`）；后台 CRUD 全仿 `admin/roles`（TableCard/FormCard/`'use server'`）；建 Key 公共入参一律 `groupSlug`、内部 id/newapiGroup 绝不下发浏览器；登录/支付/额度运营复用现有核心，仅接回与补缺口，零核心重写。

**Tech Stack:** Next.js App Router（RSC + 纯链接式 SSR）、drizzle-orm（SQLite 方言）、Better Auth、Resend、node:test（`tsx --test`）+ `scripts/smoke-mvp.ts` 端到端。

**冻结输入：** [`docs/design/user-mvp/DESIGN.md`](DESIGN.md)（已冻结 2026-06-24，经 2 轮 Codex 对抗评审）。本计划所有「关键约束」均引用 DESIGN 章节，Codex 主笔每 step 会同时收到对应 DESIGN 章节原文。

---

## 全局约定（每个 Step 都适用）

- **测试命令（全量）**：`npm test`（= `NODE_OPTIONS='--conditions react-server' tsx --test tests/**/*.test.ts`）
- **测试命令（单文件）**：`NODE_OPTIONS='--conditions react-server' npx tsx --test tests/<path>.test.ts`
- **端到端**：`npm run smoke:mvp`（连真实 New API 烟测环境，仅 Step 16 与需要时跑）
- **DB 范式**（`schema.sqlite.ts`，DESIGN §3.2）：`text('id').primaryKey()` + 应用层 `getUuid()`；boolean = `integer('x',{mode:'boolean'}).default(false).notNull()`；timestamp = `integer('x',{mode:'timestamp_ms'}).default(sqliteNowMs)`；FK = `.references(()=>x.id,{onDelete:...})`；唯一索引 `uniqueIndex(...)`、普通索引 `index(...)`。
- **服务层范式**（`src/shared/services/rbac.ts`）：标准 `db().select()/insert().values().returning()/update().set().where().returning()/delete().where()`；类型用 `typeof table.$inferSelect` / `$inferInsert`。
- **CRUD 页范式**（`admin/roles/page.tsx` + `[id]/edit/page.tsx`）：列表页 `requirePermission` → `getX()` → `Table{columns, data}`（含 `type:'dropdown'` + `callback`）→ `<TableCard>`；编辑/新增页 `Form{fields, passby, data, submit.handler}`，handler 内 `'use server'` 调服务层、返回 `{status:'success', message, redirect_url}` → `<FormCard>`。
- **价格单位**（DESIGN §D1）：`inputMicroUsd/outputMicroUsd` 存 integer = micro-USD/1M tokens（$0.15 → `150000`）；展示 `÷1_000_000` 再 `toFixed(2)`。**禁止**浮点存储。
- **公共边界硬约束**（DESIGN §D5/§8.1，F1/F8）：`newapiGroup` 与 `catalog_group.id` **仅**服务端/admin 可见；公共形状（`ListingRow`、`getGroupsForKeyCreation` 返回）**不得含** `newapiGroup`/内部 `id`；建 Key 浏览器侧只用 `groupSlug`。
- **commit 粒度**：每个 Step 至少 1 个 commit；TDD 微步骤可多次 commit。提交信息中文，scope 用 `feat(catalog)`/`feat(auth)`/`feat(billing)` 等。

---

## 文件结构映射（创建/修改清单）

**新增（Create）：**
- `scripts/init-catalog.ts` — catalog 幂等可重入 seed（D9）
- `src/features/api-catalog/server/catalog-service.ts` — admin CRUD 服务层（6 实体）
- `src/features/api-catalog/server/queries.ts` — 公共/建 Key 读层（`'server-only'`）
- `src/features/api-catalog/lib/types.ts` — DB 派生公共/内部边界类型
- `src/app/[locale]/(admin)/admin/catalog/vendors/{page,new,[id]/edit}.tsx` 等 6 实体 CRUD 页
- `src/app/[locale]/(admin)/admin/users/[id]/detail/page.tsx` — 用户详情聚合只读视图
- `src/config/locale/messages/{en,zh}/admin/catalog.json` — catalog 后台 i18n
- 测试：`tests/db/catalog-schema-singlesource.test.ts`、`tests/api-catalog/*.test.ts`、`tests/api-console/key-input.test.ts`（扩展）、`tests/newapi-bridge/billing-ledger.test.ts`、`tests/payments/*`（扩展）等

**修改（Modify）：**
- `src/config/db/schema.sqlite.ts` — 新增 7 catalog export + `newApiKeyBinding.groupId/newapiGroup` 列
- `src/core/rbac/permission.ts` — 加 `CATALOG_READ/WRITE`
- `scripts/init-rbac.ts` — `defaultPermissions` 加 CATALOG + 授权 admin
- `src/features/api-catalog/lib/catalog.ts` — 删硬编码 `publicModels`/`*_FILTERS`/`isDealModel`，保留/改造纯函数
- `src/features/api-console/lib/key-input.ts` — `groupSlug` 必填、移除写死 allowedModels
- `src/features/newapi-bridge/server/client.ts` — `createKey` 增 `group?` 入参（L572）
- `src/features/newapi-bridge/server/portal.ts` — `createPortalApiKey` slug→id 解析；新增 `listBillingLedgerEntries`、`listKeysByPortalUser`、`listAdjustmentLedgerByPortalUser`
- `src/app/api/apipool/keys/route.ts` — 透传 `groupSlug`
- `src/features/api-console/components/api-key-manager.tsx` — 分组下拉 + 分组列 + 可调模型范围
- `src/app/[locale]/(landing)/dashboard/api-keys/page.tsx` — server 取分组列表
- `src/app/[locale]/(landing)/models/page.tsx` — 数据源切换 + 四层筛选 + 删 Deals 区
- `src/app/[locale]/(admin)/admin/settings/[tab]/page.tsx` — 删 redirect，接回 FormCard
- `src/app/[locale]/(landing)/dashboard/billing/page.tsx` — 充值记录新列
- `src/app/[locale]/(landing)/dashboard/*` — 余额不足提示
- `src/app/[locale]/(admin)/admin/users/page.tsx` — 加「查看详情」入口
- `src/config/locale/messages/{en,zh}/admin/sidebar.json` — 加 Catalog/Settings 菜单
- `src/config/locale/messages/{en,zh}/settings/billing.json` — 到账/余额不足文案
- `tests/public-content/locale-copy.test.ts` — 扩展守护（F8）
- `scripts/smoke-mvp.ts` — 建 Key 选分组闭环（F11）

---

## Step 依赖图

```
Step1(schema) ─┬─ Step2(seed) ──────────────┐
               ├─ Step4(crud-service) ─┬─ Step5(queries) ─┬─ Step6(/models)
               │                        │                   └─ Step8(建Key UI)
               ├─ Step7(建Key 服务层) ──┘ (依赖 Step1 加列 + Step5 queries)
Step3(权限) ───┴─ Step9/10/11(后台 CRUD UI，依赖 Step4 + Step3)
Step12(登录设置页) ── 独立
Step13(支付展示) ── 独立 ── Step14(余额不足)
Step15(额度运营) ── 独立
Step16(smoke 端到端) ── 依赖 Step7+Step8（建 Key 选分组链路）
```

**执行顺序（线性，dev-iteration 逐 step）**：1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10 → 11 → 12 → 13 → 14 → 15 → 16。

---

## Step 1：catalog schema 建表 + 单源守护

**对应 DESIGN：** §5.1（schema 行）、§6.1（DDL 草图全文）、§D6（sqlite-only）、§5.4（newApiKeyBinding 加列）。**覆盖：** F1（建表部分）、F8（编译期类型边界）、F24（status 行为标志列）。

**依赖：** 无（地基）。

**Files:**
- Modify: `src/config/db/schema.sqlite.ts`（新增 7 个 catalog export + `newApiKeyBinding` 加 `groupId`/`newapiGroup` 列）
- Test: `tests/db/catalog-schema-singlesource.test.ts`（Create）

**范围边界：**
- 只加表/列定义，**不写** seed（Step 2）、**不写**服务层（Step 4）。
- 7 个 export：`catalogVendor`、`catalogCapability`、`catalogStatus`、`catalogGroup`、`catalogModel`、`catalogModelCapability`、`catalogModelListing`。
- `schema.ts` barrel 已 `export * from './schema.sqlite'`，**不需改**（自动导出）。
- **禁止**在 `schema.postgres.ts`/`schema.mysql.ts` 添加任何 `catalog_` 表（D6 单源）。

**关键约束（DESIGN §6.1 DDL，逐表）：**
- `catalog_vendor`：`slug` unique、`name`、`sortOrder` default 0、`status` default 'active'、`idx_catalog_vendor_status`。
- `catalog_capability`：`slug` unique、`name`、`sortOrder`、`status`。
- `catalog_status`：`slug` unique、`name`、`isCallable`{boolean} default 0、`isPublicVisible`{boolean} default 1、`sortOrder`、`status`。
- `catalog_group`：`slug` unique、`name`、`userDescription`(可空)、`newapiGroup` default ''、`allowCreateKey`{boolean} default 1、`sortOrder`、`status`、`idx_catalog_group_status`。
- `catalog_model`：`modelId` unique、`displayName`、`vendorId` FK→vendor、`category` default 'llm'、`contextWindow`(可空)、`idx_catalog_model_vendor`。
- `catalog_model_capability`：`modelId` FK→model(cascade)、`capabilityId` FK→capability(cascade)、`uniqueIndex(modelId,capabilityId)`、`idx_cmc_capability(capabilityId)`。
- `catalog_model_listing`：`modelId` FK→model(cascade)、`groupId` FK→group(cascade)、`statusId` FK→status、`inputMicroUsd`/`outputMicroUsd` integer not null、`listInputMicroUsd`/`listOutputMicroUsd`(可空)、`discountNote`(可空)、`description`(可空)、`smokeTested`{boolean} default 0、`featured`{boolean} default 0、`sortOrder`、`uniqueIndex(modelId,groupId)`、`idx_listing_group(groupId)`、`idx_listing_status(statusId)`。
- `newApiKeyBinding` 加：`groupId text`（FK→catalogGroup，`onDelete: 'set null'`，可空）+ `newapiGroup text default ''`（快照）+ `idx_newapi_key_binding_group`。

**TDD（Codex 执行骨架）：**
1. 先写 `tests/db/catalog-schema-singlesource.test.ts`：
   - 断言 `src/config/db/schema.postgres.ts` 与 `schema.mysql.ts` 源码文本**不含** `catalog_`（读文件 + `assert(!content.includes('catalog_'))`）。
   - 从 barrel `@/config/db/schema` import，断言 7 个 catalog 表 export 均为 truthy（`catalogVendor`…`catalogModelListing`）。
   - 断言 `newApiKeyBinding` 含 `groupId` 列（`newApiKeyBinding.groupId !== undefined`）。
2. 跑测试 → 预期 FAIL（表未定义）。
3. 在 `schema.sqlite.ts` 按 DDL 加 7 表 + 2 列。
4. 跑测试 → 预期 PASS。
5. 验证迁移可生成：`npm run db:generate`（drizzle-kit 产出 SQL 到 `migrations_sqlite/`），确认无报错、生成含新表/列的迁移文件。**提交迁移文件**。
6. Commit：`feat(catalog): 新增 7 张 catalog 表与 newApiKeyBinding 分组列 + 单源守护`。

**验收：** 单源守护测试绿；`npm run db:generate` 产出迁移；`npm test` 全绿无回归。

---

## Step 2：init-catalog seed（幂等可重入）

**对应 DESIGN：** §5.1（seed 行）、§D9（onConflictDoNothing + 事务）、§3.7（init-rbac 骨架可借鉴但**不照抄先查后插**）、§10.1 F1（幂等 + 并发用例）。**覆盖：** F1（seed 部分）。

**依赖：** Step 1。

**Files:**
- Create: `scripts/init-catalog.ts`
- Modify: `package.json`（加 `catalog:init` script，仿 `rbac:init`）
- Modify: `deploy/entrypoint.sh`（若串接 seed；沿用运行时 migrator，不改 Dockerfile）
- Test: `tests/db/init-catalog.test.ts`（Create）

**范围边界：**
- seed 首批：供应商 OpenAI/Anthropic/Google；能力 text/vision/video/audio；状态 available(callable=1,visible=1)/coming_soon(callable=0,visible=1)/retired(callable=0,visible=0)；≥1 分组 official；≥1 模型 + ≥1 listing（`smokeTested=true`，满足 confirmed §0.2 首批真实调用验证）。
- 写入用 `insert(...).values(...).onConflictDoNothing()`（按 slug；关联表按 `(modelId,capabilityId)`；listing 按 `(modelId,groupId)`），需更新文案处用 `onConflictDoUpdate`。多表按依赖序在**一个事务**内。
- **不照抄** `init-rbac.ts:358-376` 的「先 select 后 insert」。

**TDD：**
1. 写 `tests/db/init-catalog.test.ts`（用临时 SQLite 库 + 跑 migrator）：
   - **幂等**：连跑 `initCatalog()` 两次，断言各表行数两次相等、第二次不抛错。
   - **数据完整**：断言 vendor≥3、capability≥4、status=3（且 available.isCallable=1）、group≥1（official）、model≥1、listing≥1 且存在 `smokeTested=1` 的 listing。
   - **并发（补充，DESIGN §10.1 F1）**：`await Promise.all([initCatalog(), initCatalog()])` 不抛唯一冲突、行数稳定。
2. 跑 → FAIL（脚本不存在）。
3. 写 `scripts/init-catalog.ts`：导出 `initCatalog()`（可被测试 import + 可 CLI 跑，仿 init-rbac 的 `loadSchemaTables()` 动态 import 骨架）。
4. 跑 → PASS。
5. Commit：`feat(catalog): init-catalog 幂等可重入 seed（onConflictDoNothing+事务）`。

**验收：** 幂等/完整/并发三组测试绿；`npx tsx scripts/init-catalog.ts` 在本地库可重复执行行数稳定。

---

## Step 3：CATALOG 权限

**对应 DESIGN：** §5.6、§0.2（CATALOG 权限）、§3.7（init-rbac defaultPermissions + 通配符展开）。**覆盖：** F2–F6 的权限前置（各 catalog admin 页 `requirePermission`）。

**依赖：** 无（可与 Step 1/2 并行，但排在 CRUD UI 之前）。

**Files:**
- Modify: `src/core/rbac/permission.ts`（PERMISSIONS 加 `CATALOG_READ:'admin.catalog.read'`、`CATALOG_WRITE:'admin.catalog.write'`）
- Modify: `scripts/init-rbac.ts`（`defaultPermissions` 加两条；授权给 admin/super_admin，沿用通配符 `admin.catalog.*` 或显式）
- Test: `tests/config/permission.test.ts`（若无则 Create；或并入现有 rbac 测试）

**TDD：**
1. 写测试：断言 `PERMISSIONS.CATALOG_READ === 'admin.catalog.read'`、`CATALOG_WRITE === 'admin.catalog.write'`；断言 `defaultPermissions`（从 init-rbac 导出或读取）含这两条 code。
2. 跑 → FAIL。
3. 加常量 + defaultPermissions 条目 + admin 授权。
4. 跑 → PASS；本地 `npm run rbac:init` 可重跑不报错（幂等沿用现有）。
5. Commit：`feat(rbac): 新增 CATALOG 读写权限并授权 admin`。

**验收：** 权限常量与 seed 测试绿。

---

## Step 4：catalog-service.ts（admin CRUD 服务层）

**对应 DESIGN：** §5.2（catalog-service 行）、§6.2（CRUD 服务层签名）。**覆盖：** F2/F3/F4/F5/F6 的**服务层**部分（UI 在 Step 9–11）。

**依赖：** Step 1。

**Files:**
- Create: `src/features/api-catalog/server/catalog-service.ts`
- Create: `src/features/api-catalog/lib/types.ts`（内部/公共类型边界）
- Test: `tests/api-catalog/catalog-service.test.ts`（Create，mock `db()`）

**范围边界：** 6 实体（vendor/capability/status/group/model/listing）各一组 `getX/getXById/createX/updateX/deleteX`（仿 `rbac.ts`）；额外 `getListingsByModel(modelId)`、`setModelCapabilities(modelId, capabilityIds[])`（关联表先删后插，仿 `assignPermissionsToRole`）、`getGroupNewapiMapping(groupId)`。类型用 `$inferSelect`/`$inferInsert`。**不**含缓存（缓存在 queries 层）；**不**含 UI。

**关键约束：**
- `setModelCapabilities` 先 `delete` 该 modelId 全部关联再批量 `insert`（空数组 = 清空），与 `rbac.ts:193-212` 同构。
- `getGroupNewapiMapping(groupId)` 返回 `newapiGroup`，**仅服务端/建 Key 服务调用**。
- 写操作在服务层不做权限校验（权限在页/路由层），但 deleteX 需考虑 FK 级联（listing/model_capability cascade，group/status 被 listing 引用时由 DB FK 约束兜底）。

**TDD（mock `db()`）：**
1. 写测试覆盖：`createVendor` 输入→insert 调用值；`updateVendor` patch；`getVendors` 返回；`setModelCapabilities([a,b])` 触发 1 delete + 1 insert(2 值)、`setModelCapabilities([])` 触发 1 delete + 0 insert；`getGroupNewapiMapping` 返回 newapiGroup。
2. 跑 → FAIL。
3. 实现服务层。
4. 跑 → PASS。
5. Commit：`feat(catalog): 模型目录 CRUD 服务层（6 实体 + 能力关联）`。

**验收：** 服务层单测绿，覆盖 6 实体核心方法 + setModelCapabilities 删插语义 + 空数组分支。

---

## Step 5：queries.ts（公共/建 Key 读层）+ 输出守护

**对应 DESIGN：** §5.2（queries 行）、§6.2（查询层签名 + ListingRow/FilterDimensions 类型）、§D7、§8.1（公共边界）、§10.1 F8。**覆盖：** F7（数据层）、F8（输出守护）、F9/F10（建 Key 读层）。

**依赖：** Step 1（+ Step 4 的类型可复用）。

**Files:**
- Create: `src/features/api-catalog/server/queries.ts`（`'server-only'`）
- Modify: `src/features/api-catalog/lib/types.ts`（加 `ListingRow`、`FilterDimensions`）
- Test: `tests/api-catalog/queries.test.ts`（Create，mock `db()`）

**范围边界（DESIGN §6.2 签名，逐函数）：**
- `getPublicListings(filters:{vendor?;group?;capability?;status?}): Promise<ListingRow[]>` — 默认仅 `isPublicVisible=true`；按四层过滤；按 sortOrder 排序；join vendor/group/status + 能力关联聚合（无 N+1）。
- `getFilterDimensions(): Promise<FilterDimensions>` — 四维选项（vendors/groups/capabilities/statuses，各 `{slug,name}`）从 DB 字典聚合（仅 status='active' 字典项）。
- `getCallableListingsByGroup(groupSlug): Promise<ListingRow[]>` — 该 group 下 `status.isCallable=true` 的 listing。
- `getGroupsForKeyCreation(): Promise<{slug;name;userDescription?}[]>` — 仅 `group.status='active' ∧ allowCreateKey=true`；**不含 id、不含 newapiGroup**。
- 全部用 `unstable_cache` + tag `'catalog'`；导出 `revalidateCatalog()`（包 `revalidateTag('catalog')`）供 admin 写后调用。

**关键约束（F1/F8 边界）：**
- `ListingRow` 类型**不含** `newapiGroup`、不含内部 `id`；含 `groupSlug/groupName`（门户分组）。**类型即边界**。
- 价格字段命名 `inputMicroUsd/outputMicroUsd/listInputMicroUsd?/listOutputMicroUsd?`（与 schema 一致）。

**TDD（mock `db()`）：**
1. 写测试：
   - `getPublicListings()` 默认过滤 `isPublicVisible=true`（喂含 visible/不可见两行的 mock，断言只返回 visible）。
   - 四层过滤：传 `{group:'official', status:'available'}` 断言 where 条件命中。
   - **F8 守护**：`JSON.stringify(await getPublicListings())` 不含字面 `'newapiGroup'`、`'newapi'`；`JSON.stringify(await getGroupsForKeyCreation())` 不含 `'id'`（指内部 id 字段名，注意避开合法字段）/`'newapiGroup'`。
   - `getGroupsForKeyCreation()` 只返回 active+allowCreateKey 的组。
   - `getCallableListingsByGroup('official')` 只返回 isCallable=true。
2. 跑 → FAIL。
3. 实现 queries.ts。
4. 跑 → PASS。
5. Commit：`feat(catalog): 公共/建 Key 查询层 + 缓存 + 公共边界守护`。

**验收：** queries 单测绿；F8 输出 JSON 不含后台痕迹的断言绿。

---

## Step 6：/models 公共页改造

**对应 DESIGN：** §5.3、§D7、§Q-B（删 Deals 区）、§7.2 step 3b、§10.1 F7/F8。**覆盖：** F7（四层筛选 UI）、F8（公共页守护）、F24（下线状态展示）。

**依赖：** Step 5。

**Files:**
- Modify: `src/app/[locale]/(landing)/models/page.tsx`（数据源 `publicModels` → `await getPublicListings(filters)`；filterGroups 增第 4 组「分组」；表格增「分组」列；删独立 Deals 区与 `isDealModel`；折扣行内 `discountNote`/划线价）
- Modify: `src/features/api-catalog/lib/catalog.ts`（改造 `buildModelFilterHref`/`parseModelFilters` 接受 4 维 + DB 形状；price 格式化改 micro-USD；**暂不删** `publicModels`（Step 11 末或保留为夹具，§7.2 step 3d/Q-C））
- Modify: `tests/public-content/locale-copy.test.ts`（扩展守护，F8）
- Test: `tests/api-catalog/models-filter.test.ts`（Create，测筛选纯函数 + 价格格式化）

**范围边界：** 保持「Server Component + 纯 `<Link>` 筛选、无 client JS」架构（DESIGN §3.1），只换数据源 + 加第 4 维 + 删 Deals 区。**不**触建 Key（Step 7/8）。

**关键约束：**
- 四层筛选：供应商/分组/能力/状态，选项来自 `getFilterDimensions()`，渲染为 `<Link>`（纯链接式，sortOrder 排序）。
- 状态展示读 `statusName` + `isCallable` 标注（非硬编码状态名）；`isPublicVisible=false`（retired）默认不展示。
- 表格「分组」列展示门户 `groupName`，**绝不**展示 `newapiGroup`。
- 价格展示：`formatMicroUsdPerMillion(micro)` = `$${(micro/1_000_000).toFixed(2)}`；有 `listInputMicroUsd` 时划线展示原价。

**TDD：**
1. 写 `models-filter.test.ts`：`buildModelFilterHref` 含 4 维（含 group）；`parseModelFilters` 解析 group；价格格式化 `150000 → "$0.15"`、`2500000 → "$2.50"`。
2. 扩展 `locale-copy.test.ts`：把 `group` 加入黑名单（公共页文案不应出现后台网关术语，DESIGN §8.1 建议）；确认现有 seed 文案仍过黑名单。
3. 跑 → FAIL。
4. 改 `catalog.ts` 纯函数 + `models/page.tsx` 数据源/筛选/表格/删 Deals。
5. 跑 → PASS（含 locale-copy 守护）。
6. **人工走查（补充，DESIGN §10.3 清单 5）**：四层筛选链接交互、折扣行内展示。记录一次。
7. Commit：`feat(catalog): /models 切 DB 数据源 + 四层筛选 + 删 Deals 区`。

**验收：** 筛选/价格纯函数测试绿；locale-copy 守护（含 group 黑名单）绿；访问 `/models?group=official&status=available` 返回匹配 listing（dev 服务器人工确认或 RSC props 断言）。

---

## Step 7：建 Key 服务层（slug→id 解析）

**对应 DESIGN：** §5.4（key-input/client/portal/route 行）、§6.2（建 Key 签名变更 F1）、§6.3（建 Key 状态流）、§8.1（建 Key 不被邮箱验证阻塞 U3）。**覆盖：** F9（服务层）、F14（落库 groupId）、F19（不校验 emailVerified）。

**依赖：** Step 1（newApiKeyBinding 加列）、Step 5（queries：按 slug 解析需读 catalogGroup）。

**Files:**
- Modify: `src/features/api-console/lib/key-input.ts`（`sanitizePortalApiKeyCreateInput` 返回 `{name, groupSlug}`，groupSlug 必填校验；移除写死 allowedModels；移除 `getDefaultCallableModelId` 依赖）
- Modify: `src/features/newapi-bridge/server/client.ts`（`createKey` 入参增 `group?:string`，L572 `group: ''` → `group: input.group ?? ''`）
- Modify: `src/features/newapi-bridge/server/portal.ts`（`createPortalApiKey` 公共入参 `{name, groupSlug}`；服务端按 slug 查 catalogGroup → 内部 id + newapiGroup；校验 `status='active' ∧ allowCreateKey=true`；`client.createKey({group:newapiGroup})`；写 `binding.groupId=内部id` + `newapiGroup` 快照）
- Modify: `src/app/api/apipool/keys/route.ts`（透传 `groupSlug`；slug 浅校验；未知/disabled/allowCreateKey=false 返回明确错误；**不**校验 emailVerified）
- Test: `tests/api-console/key-input.test.ts`（扩展）、`tests/newapi-bridge/create-portal-key.test.ts`（Create/扩展，mock db + mock client）

**范围边界：** 只改服务层 + 路由，**不**改 UI 组件（Step 8）。

**关键约束（F1，关键防线）：**
- 浏览器/路由只接收 `groupSlug`；**绝不**接收/返回 `catalog_group.id` 或 `newapiGroup`。
- slug→id+newapiGroup 解析在 `createPortalApiKey` **服务端**完成。
- 落库 `newApiKeyBinding.groupId` = 内部 id（非 slug）；`client.createKey` 收到的 `group` = newapiGroup（非 slug、非 id）。
- 公共 API 响应（POST /api/apipool/keys 返回的 binding 视图）**不含** id/newapiGroup。

**TDD：**
1. `key-input.test.ts`：缺 `groupSlug` → 抛/返回校验错误；含 `{name:'k', groupSlug:'official'}` → 返回 `{name:'k', groupSlug:'official'}`（无 allowedModels）。
2. `create-portal-key.test.ts`（mock db 返回 group 行、mock client.createKey）：
   - 正常：传 groupSlug='official'（mock group active+allowCreateKey）→ 断言 `client.createKey` 收到的 `group` === mock 的 newapiGroup 值；断言写 binding 的 `groupId` === mock 内部 id；断言返回值 JSON 不含 newapiGroup/内部 id。
   - 拒绝：group disabled / allowCreateKey=false / slug 不存在 → 抛明确错误，不调 client.createKey。
3. 跑 → FAIL。
4. 实现四处改动。
5. 跑 → PASS。
6. Commit：`feat(api-key): 建 Key 选分组服务层（slug→id 服务端解析，内部 id 不外泄）`。

**验收：** key-input + create-portal-key 单测绿；slug↔内部 id 边界断言绿（F1）；拒绝分支绿。

---

## Step 8：建 Key UI（下拉 + 分组列 + 可调模型范围）

**对应 DESIGN：** §5.4（api-key-manager/api-keys 行）、§6.2、§10.1 F9/F10/F14、§10.3（UI 兜底策略）。**覆盖：** F9（UI）、F10（可调模型范围展示）、F14（Key 列表分组列）。

**依赖：** Step 5（getGroupsForKeyCreation/getCallableListingsByGroup）、Step 7（服务层）。

**Files:**
- Modify: `src/features/api-console/components/api-key-manager.tsx`（建 Key 表单加分组下拉 option value=`slug` label=`name`；选分组后展示「该分组可调模型范围」；列表加「分组」列）
- Modify: `src/app/[locale]/(landing)/dashboard/api-keys/page.tsx`（server 取 `getGroupsForKeyCreation()` 传组件；列表 join 分组名，server 侧 binding.groupId→门户 name，不下发 id）
- Test: `tests/api-console/api-key-manager.test.ts`（Create，对组件数据契约/纯函数断言，DESIGN §10.3 兜底②）

**范围边界：** 遵循 DESIGN §10.3 UI 兜底策略——测**数据契约 + 纯展示逻辑**（不依赖浏览器）；纯视觉交互记人工走查。

**关键约束：** 下拉 option value=`slug`（**非 id**）；提交 payload 不含 id/newapiGroup；未选分组禁用提交/报错。

**TDD：**
1. 写测试（对组件抽出的纯函数/props 映射断言）：分组下拉 option 映射 `{slug,name}[]` → `<option value=slug>name</option>` 契约（value=slug、不含 id）；列表行 `groupId→groupName` 映射；「可调模型范围」由 `getCallableListingsByGroup` 结果渲染、空时「暂无可调模型」。
2. 跑 → FAIL。
3. 改组件 + 页面。
4. 跑 → PASS。
5. **人工走查（DESIGN §10.3 清单 1）**：下拉展开样式、未选必选校验提示、key 一次性展示+复制反馈。记录一次。
6. Commit：`feat(api-key): 建 Key 分组下拉 + Key 列表分组列 + 可调模型范围展示`。

**验收：** 组件数据契约测试绿（value=slug、payload 无 id/newapiGroup）；人工走查记录。

---

## Step 9：后台 CRUD — 字典三表（vendors/capabilities/statuses）

**对应 DESIGN：** §5.5（vendors/capabilities/statuses 行）、§3.7（roles CRUD 范式）。**覆盖：** F2、F4，及 F3 的能力字典 CRUD 部分。

**依赖：** Step 3（权限）、Step 4（服务层）。

**Files:**
- Create: `src/app/[locale]/(admin)/admin/catalog/vendors/{page.tsx, new/page.tsx, [id]/edit/page.tsx}`
- Create: `.../catalog/capabilities/{page,new,[id]/edit}.tsx`
- Create: `.../catalog/statuses/{page,new,[id]/edit}.tsx`（状态含 `isCallable`/`isPublicVisible` switch 字段）
- Create: `src/config/locale/messages/{en,zh}/admin/catalog.json`（这三实体的 label）
- Test: `tests/api-catalog/catalog-pages.test.ts`（Create，对页面 Table/Form 配置纯数据断言）

**范围边界：** 三个字典实体的 列表+新增+编辑 页，全仿 roles 范式。页首 `requirePermission({code: PERMISSIONS.CATALOG_READ})`（列表）/ `CATALOG_WRITE`（编辑/新增）。写操作 handler 内调 `catalog-service` + `revalidateCatalog()`，返回 `{status:'success', redirect_url:'/admin/catalog/<entity>'}`。

**关键约束：** 状态实体表单必须有 `isCallable`/`isPublicVisible` 两个 switch（DESIGN §5.5/§D3）。所有用户可见 label 双语（en/zh）。

**TDD：**
1. 写 `catalog-pages.test.ts`：对各列表页导出的 `Table.columns` 断言含预期列；状态编辑 `Form.fields` 含 isCallable/isPublicVisible（type=switch）；handler 存在性。（页面是 async RSC，可抽出 buildTable/buildForm 纯函数测，或断言导出结构。）
2. 跑 → FAIL。
3. 实现三实体 9 个页面 + i18n。
4. 跑 → PASS。
5. **人工走查**：列表 TableCard 渲染、FormCard 提交回跳。
6. Commit：`feat(catalog-admin): 供应商/能力/状态字典后台 CRUD`。

**验收：** 页面配置测试绿；本地 `/admin/catalog/vendors` 等可渲染列表+表单（人工）；重复 slug 拒绝（服务层已测，UI 透传错误）。

---

## Step 10：后台 CRUD — 分组（含 newapiGroup/allowCreateKey）

**对应 DESIGN：** §5.5（groups 行）、§D5、§10.1 F5/F24。**覆盖：** F5（分组 CRUD + 映射）、F24（下线分组）。

**依赖：** Step 3、Step 4。

**Files:**
- Create: `.../catalog/groups/{page,new,[id]/edit}.tsx`（字段：slug/name/userDescription/`newapiGroup`/`allowCreateKey`(switch)/sortOrder/status）
- Modify: `src/config/locale/messages/{en,zh}/admin/catalog.json`（加 groups label）
- Test: 并入 `tests/api-catalog/catalog-pages.test.ts`

**关键约束：** `newapiGroup` 字段**仅 admin 页可见可编辑**（这是后台网关映射，DESIGN §D5）；`allowCreateKey` switch 控制能否被用户建 Key 选中；status=disabled = 下线分组（不进 `getGroupsForKeyCreation`，F24）。

**TDD：**
1. 写测试：groups 编辑 `Form.fields` 含 `newapiGroup`(text) + `allowCreateKey`(switch)；列表列含 newapiGroup（admin 可见）。
2. 跑 → FAIL。 3. 实现。 4. 跑 → PASS。
5. Commit：`feat(catalog-admin): 分组后台 CRUD（newapiGroup 映射 + allowCreateKey）`。

**验收：** 分组页配置测试绿；本地配 newapiGroup 后建 Key 链路收到该值（与 Step 7 联动，人工或 smoke 在 Step 16 验）。

---

## Step 11：后台 CRUD — 模型本体 + 能力打标 + listings 子表

**对应 DESIGN：** §5.5（models/listings 行 + categories 桩 + sidebar/i18n）、§D4、§10.1 F3/F6、§7.2 step 3d（删硬编码时机）。**覆盖：** F3（模型打标）、F6（同 modelId 跨分组多 listing）。

**依赖：** Step 3、Step 4、Step 9（能力字典存在才能打标）、Step 10（分组存在才能建 listing）。

**Files:**
- Create: `.../catalog/models/{page,new,[id]/edit}.tsx`（modelId/displayName/vendor 下拉/contextWindow + 能力多选）
- Create: `.../catalog/models/[id]/listings/{page,new,[id]/edit}.tsx`（某模型的分组售卖项子表：group 下拉/inputMicroUsd/outputMicroUsd/划线价/statusId 下拉/discountNote/description/smokeTested/sortOrder）
- Modify: `src/app/[locale]/(admin)/admin/categories/page.tsx`（redirect 桩 → 改向 `/admin/catalog/models`）
- Modify: `src/config/locale/messages/{en,zh}/admin/sidebar.json`（加「Model Catalog」菜单组：Vendors/Groups/Capabilities/Statuses/Models）
- Modify: `src/config/locale/messages/{en,zh}/admin/catalog.json`（models/listings label）
- Modify（可选，§7.2 step 3d/Q-C）: `src/features/api-catalog/lib/catalog.ts`（确认 `publicModels` 在 src 下零运行时引用后，删除或保留为单测夹具）
- Test: 并入 `tests/api-catalog/catalog-pages.test.ts`；`tests/api-catalog/catalog-cleanup.test.ts`（可选，grep 守护零引用）

**关键约束：**
- 能力多选 → `setModelCapabilities`（Step 4）。
- listing 子表受 `(modelId,groupId)` 唯一约束：同模型同分组重复被拒（F6 失效路径）；同 modelId 不同分组允许（F6 正路）。
- 价格输入校验非负整数 micro-USD（DESIGN §8.1）。
- 删 `publicModels` 前 grep 确认 `src` 下零运行时 import（DESIGN §7.2 守护）。

**TDD：**
1. 写测试：models 编辑 Form 含能力多选字段；listings 编辑 Form 含 group/价/status/smokeTested；sidebar.json 含 catalog 菜单组；（可选）grep `publicModels` 在 `src/app`/`src/features` 运行时引用为 0。
2. 跑 → FAIL。 3. 实现页面 + sidebar + i18n + categories 改向 + （确认后）删硬编码。 4. 跑 → PASS（全量 `npm test` 确认删硬编码无回归）。
5. **人工走查**：模型能力多选、listing 子表 CRUD、`/models` 同模型多行不同价（F6）。
6. Commit：`feat(catalog-admin): 模型本体+能力打标+分组售卖项子表 + 菜单 + 清理硬编码`。

**验收：** 页面配置测试绿；`npm test` 全绿（删硬编码后无回归）；同 modelId 跨分组两行不同价（人工/smoke）。**至此模型目录体系（M5）闭环。**

---

## Step 12：接回登录设置页

**对应 DESIGN：** §5.7、§D8、§3.5（Better Auth/Resend 就绪）、§10.1 F16–F20、§10.3。**覆盖：** F16（Google）、F17（GitHub）、F18（邮箱验证）、F20（设置页接回），间接 A6。

**依赖：** 无（独立）。

**Files:**
- Modify: `src/app/[locale]/(admin)/admin/settings/[tab]/page.tsx`（删 redirect；`requirePermission(SETTINGS_READ)` → `getSettingTabs()` 校验 tab → `getSettings()` 过滤当前 tab → 按 SettingGroup 渲染 `FormCard`；`submit.handler` `'use server'` 调 `saveConfigs()`；至少保 `auth`、`email` 两 tab）
- Modify: `src/config/locale/messages/{en,zh}/admin/sidebar.json`（加「Settings」菜单指向 `/admin/settings/auth`）
- Modify/Create（如缺）: `src/config/locale/messages/{en,zh}/admin/settings.json`
- Test: `tests/config/settings-page.test.ts`（Create，mock db，DESIGN §10.3 兜底）

**关键约束（DESIGN §3.5）：** 复用现有 `settings.ts`（字段定义已就绪：google_client_id/secret、github_client_id/secret、email_verification_enabled、resend_api_key、resend_sender_email）+ `config.ts`（`saveConfigs` 已 `revalidateTag('configs')`）。**无新 HTTP 路由、无新配置字段**。password 字段 type=password 掩码。空值不覆盖 env 优先级（§3.5 `getAllConfigs` env>db）。

**TDD（mock db）：**
1. 写测试：`getSettings()` 按 tab='auth' 过滤返回含 google_client_id 等字段集；`saveConfigs(formData)` upsert 后 `getAllConfigs` 读到新值；空值不覆盖 env 优先级分支。
2. 跑 → FAIL。 3. 改 settings/[tab]/page.tsx + sidebar + i18n。 4. 跑 → PASS。
5. **人工走查（DESIGN §10.3 清单 2）**：auth/email 两 tab 渲染、password 掩码、保存 toast。
6. Commit：`feat(auth): 接回 admin 设置页（FormCard + saveConfigs，auth/email tab）`。

**验收：** 设置页 server 逻辑测试绿；本地填 OAuth/Resend 密钥保存→`getAllConfigs` 读到→Better Auth 动态装载生效（人工，F16/F17/F18 端到端依赖真实密钥，标注外部依赖）。

---

## Step 13：充值记录展示（listBillingLedgerEntries + billing 页）

**对应 DESIGN：** §5.8（portal/billing 行）、§6.2（listBillingLedgerEntries 签名 + 展示映射）、§10.1 F21、§3.2 F2 核对（amountUsd 是美元数值非美分）。**覆盖：** F21（充值到账状态），A7。

**依赖：** 无（独立；Step 12 接回设置页后支付密钥可填，但展示不依赖）。

**Files:**
- Modify: `src/features/newapi-bridge/server/portal.ts`（新增只读投影 `listBillingLedgerEntries(portalUserId)`，join `order` on `ledger.orderNo=order.orderNo`；**不改** `toPublicLedgerEntry`）
- Modify: `src/app/[locale]/(landing)/dashboard/billing/page.tsx`（充值历史改用 `listBillingLedgerEntries`；4 列→订单时间/金额/支付状态/到账状态；加「到账处理中」态）
- Modify: `src/config/locale/messages/{en,zh}/settings/billing.json`（到账处理中/到账失败文案）
- Test: `tests/newapi-bridge/billing-ledger.test.ts`（Create，mock db）

**关键约束（F2 单位陷阱）：** `amountUsd` 是**美元数值整数**（5 表示 $5），billing 展示 `formatUsdAmount(amountUsd)` **直接格式化、不再 ÷100**。投影返回 `{orderNo, amountUsd, ledgerStatus, orderStatus, paymentProvider, paidAt, createdAt}`。展示映射：orderStatus(paid→已支付/created→待支付/failed→支付失败/null→无关联订单)、ledgerStatus(applied→已到账/pending→到账处理中/failed→到账失败)。

**TDD（mock db）：**
1. 写测试：`listBillingLedgerEntries` join order 返回全字段；**`amountUsd=5 → "$5.00…"` 不被 ×100**；ledger 无 orderNo（手工调额条目）→ orderStatus=null 不报错；展示映射函数 `(orderStatus,ledgerStatus)→文案` 全分支（含 processing/failed）。
2. 跑 → FAIL。 3. 实现投影 + billing 页 + i18n。 4. 跑 → PASS。
5. **人工走查（DESIGN §10.3 清单 3）**：充值记录四列视觉、「到账处理中」态可视化。
6. Commit：`feat(billing): 充值记录展示支付状态+到账状态（join order，amountUsd 美元数值）`。

**验收：** billing 投影 + 映射测试绿；amountUsd 单位断言绿（不 ×100）；无 orderNo 条目不报错。

---

## Step 14：余额不足提示

**对应 DESIGN：** §5.8（余额不足行）、§10.1 F13、§10.3。**覆盖：** F13。

**依赖：** Step 13（同属 billing 块，可同 step 但拆开更聚焦）。

**Files:**
- Modify: `src/app/[locale]/(landing)/dashboard/*`（概览/建 Key/调用相关位置：`balanceUsd <= 阈值` 时展示「余额不足，请充值」+ Add credit 入口）
- Modify: `src/config/locale/messages/{en,zh}/settings/billing.json`（余额不足文案）
- Test: `tests/api-console/balance-warning.test.ts`（Create）

**关键约束：** 阈值判断纯函数（如 `isLowBalance(balanceUsd, threshold=0)`）；余额数据获取失败时**不误报**（fallback 不显示，DESIGN §10.1 F13 失效路径）。

**TDD：**
1. 写测试：`isLowBalance(0) === true`、`isLowBalance(5) === false`；提示组件按 prop 渲染/不渲染契约；余额为 null/undefined → 不显示。
2. 跑 → FAIL。 3. 实现阈值函数 + 提示组件接入。 4. 跑 → PASS。
5. **人工走查（DESIGN §10.3 清单 4）**：横幅位置、跳 billing 链接。
6. Commit：`feat(billing): 余额不足提示 + 充值入口`。

**验收：** 阈值函数 + 渲染契约测试绿；null 余额不误报。

---

## Step 15：管理员额度运营（用户详情聚合只读视图）

**对应 DESIGN：** §5.9、§6.2（用户详情签名）、§10.1 F22/F23、§3.6（adjust-quota 沿用）。**覆盖：** F23（详情聚合）、F22（调额沿用展示），A8/A9。

**依赖：** 无（独立）。

**Files:**
- Create: `src/app/[locale]/(admin)/admin/users/[id]/detail/page.tsx`（只读聚合：余额/用量(`getPortalUsage`) + Key 列表 + 调额历史；`requirePermission(USERS_READ)`）
- Modify: `src/features/newapi-bridge/server/portal.ts`（按需新增 `listKeysByPortalUser(id)`、`listAdjustmentLedgerByPortalUser(id)`，后者查 `apipoolLedgerEntry` source=manual_adjustment join operator）
- Modify: `src/app/[locale]/(admin)/admin/users/page.tsx`（action 加「查看详情」→ `/admin/users/[id]/detail`）
- Test: `tests/newapi-bridge/admin-user-detail.test.ts`（Create，mock db）

**关键约束：** 纯只读，调额仍走现有 `POST /api/apipool/admin/adjust-quota`（不改，F22）。用户无 binding → 余额区显空/未初始化，不报错（F23 失效路径）。

**TDD（mock db）：**
1. 写测试：`listKeysByPortalUser('u1')` by portalUserId 返回该用户 Key 集；`listAdjustmentLedgerByPortalUser('u1')` 只返回 source=manual_adjustment 条目、含 operator；用户无 binding → 返回空数组不抛。
2. 跑 → FAIL。 3. 实现查询 + 详情页 + 入口。 4. 跑 → PASS。
5. **人工走查**：详情页四区块渲染、从用户列表进入。
6. Commit：`feat(admin): 用户详情聚合只读视图（余额/用量/Key/调额历史）`。

**验收：** 聚合查询测试绿；无 binding 优雅降级；详情页可渲染（人工）。

---

## Step 16：smoke-mvp 端到端（建 Key 选分组闭环）

**对应 DESIGN：** §10.1 F11/F12/F15、§10.3（smoke 扩展）。**覆盖：** F11（复制 Key 真实调用）、F12（调用后余额/用量）、F15（禁用 Key 不能调用）端到端。

**依赖：** Step 7、Step 8（建 Key 选分组链路完整）；需 Step 2 seed 的 official 分组 newapiGroup 对齐烟测环境。

**Files:**
- Modify: `scripts/smoke-mvp.ts`（建 Key 改传 `groupSlug`，经真实 group 路由调用 `/v1` → 200 → 用量可见；保留现有禁用→401 闭环）
- Test: 复用 `npm run smoke:mvp`（端到端脚本本身即验证）

**关键约束：** 连真实 New API 烟测环境（confirmed §0.2 首批真实调用验证）；official 分组的 `newapiGroup` 必须与烟测环境实际 group 对齐（手动，DESIGN §9.1）。

**执行步骤：**
1. 改 `smoke-mvp.ts`：建 Key 步骤传 `groupSlug:'official'`（而非旧 allowedModels 路径）。
2. 跑 `npm run smoke:mvp`：预期建 Key→`client.createKey` 收到 official 的 newapiGroup→真实 `/v1` 调用 200→用量可见→禁用→401。
3. 若烟测环境 group 未对齐，先在 New API 后台建 group 并回填 official 分组 newapiGroup。
4. Commit：`test(smoke): 建 Key 选分组端到端闭环（groupSlug→真实调用→用量）`。

**验收：** `npm run smoke:mvp` 全步通过（建 Key 选分组→真实调用 200→用量可见→禁用 401）。**至此 user-mvp 全闭环。**

---

## 自审清单（writing-plans Self-Review）

**1. Spec 覆盖（F1–F24 → Step 映射）：**

| F | Step | F | Step | F | Step |
|---|---|---|---|---|---|
| F1 | 1,2 | F9 | 7,8 | F17 | 12 |
| F2 | 4,9 | F10 | 5,8 | F18 | 12 |
| F3 | 4,9,11 | F11 | 16 | F19 | 7 |
| F4 | 4,9 | F12 | 16 | F20 | 12 |
| F5 | 4,10 | F13 | 14 | F21 | 13 |
| F6 | 4,11 | F14 | 8 | F22 | 15 |
| F7 | 5,6 | F15 | 16 | F23 | 15 |
| F8 | 5,6 | F16 | 12 | F24 | 6,10,11 |

18 条验收（U1–U9/A1–A9）经 DESIGN §10.2 映射到 F1–F24，全部有 Step 承载。**无 spec 缺口。**

**2. 占位符扫描：** 无 TBD/TODO；每个 Step 有具体文件路径、测试断言、DESIGN 引用、commit。实现代码由 Codex TDD 自主产出（dev-iteration 机制），非占位符。

**3. 类型/命名一致性：** 价格字段全程 `inputMicroUsd/outputMicroUsd`（schema=service=queries=UI 一致）；公共形状 `ListingRow`（不含 newapiGroup）贯穿 Step 5/6/8；建 Key 公共入参全程 `groupSlug`、内部 `groupId`、网关 `newapiGroup` 三者命名严格区分（Step 7/8/10/16）；`getGroupsForKeyCreation`/`getCallableListingsByGroup`/`getPublicListings`/`getFilterDimensions` 签名与 DESIGN §6.2 一致。

---

## dev-iteration 执行交接

本计划共 **16 个 Step**，每个 Step 为一个 dev-iteration 迭代单元。Orchestrator 将按序：
1. 记录 `STEP_BASE`，把「本 Step 计划条目 + 对应 DESIGN 章节」写入 `.author/step-<N>-prompt.md`，分发看门狗 subagent 跑 Codex TDD 主笔；
2. 分发独立 Claude 评审 subagent，输出符合 review-schema 的 JSON；
3. 收敛判定（K=2/M=5），GO 则进下一 Step，escalate 则上交人类；
4. 全 16 Step GO 后 → 人类检查点②（合回主干）。

**阈值按 Step 分别计，互不累加。**
