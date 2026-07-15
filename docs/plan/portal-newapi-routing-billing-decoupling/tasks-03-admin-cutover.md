# 批次三：发布管线、管理面与切流（Task 22–28）

> 隶属 [PLAN.md](PLAN.md)。全局约束、共享接口契约、通用工序见 PLAN.md。

---

### Task 22: 发布管线 —— `route-service.ts` + 方向校验 + worst-case

**Files:**
- Create: `src/features/routing-admin/server/route-service.ts`、`src/features/routing-admin/server/worst-case.ts`
- Test: `tests/routing-admin/publish.test.ts`

**Interfaces:**
- Consumes: Task 1 schema、Task 8 `recordPortalAdminAudit`、Task 5 `ceilDiv`、`getPricingSnapshot`（`client.ts:988-1010`，deps 注入 mock）、`catalogGroup.{newapiGroupRatioBps,pricingSyncStatus}`（`schema.sqlite.ts:497-502`）、`catalogModelPrice.{baseInputMicroUsd,baseOutputMicroUsd,baseCached*,syncStatus,reviewedAt,sourceSupportedEndpointTypes}`、`catalogModel.{contextWindow,maxOutputTokens}`。
- Produces: PLAN.md 契约 `publishModelRoute/publishPriceVersion/retireModelRoute/computeWorstCaseMicroUsd/PublishResult`。
- deps 注入：`publishModelRoute(input, deps?: { getUsableGroups?: () => Promise<string[]> })`——默认 `createNewApiClient().getPricingSnapshot()` 取 `usableGroups`。

**校验规格：**

`publishPriceVersion`（设计 §5.3，发布硬门禁、逐维整数精确比较、失败结构化返回全部未过项）:
1. 前置：group `pricingSyncStatus === 'synced'`；模型基准价 `syncStatus === 'synced'` 或（`'manual'` 且 `reviewedAt` 非空）；
2. **倍率取自路由目标分组**（勘误 E8 / 评审 R4-F2：倍率挂在门户分组行、而路由可指向别的 New API 分组——方向门禁必须跟随实际路由目标）：`targetGroup = 当前 active model_route.newapiGroup ?? catalogGroup.newapiGroup`，`ratioBps = getPricingSnapshot().groupRatios[targetGroup].bps`（deps 注入 mock）；取不到该分组倍率 → 拒绝（check `target_group_ratio`）；`targetGroup` 随版本落 `refNewapiGroup` 列；
3. 五维单价全部为正整数（空值不许发布）；
4. input/output 方向：`portal ≥ Number(ceilDiv(BigInt(base) * BigInt(ratioBps), 10_000n))`（参照价向成本侧取整）；
5. cache 三维：参照价 = `catalogModelPrice.baseCached*`（管理员锁定 + 复核的成本快照）；**base cache 列为空 → 拒绝**（证据不足的模型 v1 不卖）；同款方向校验 `portal ≥ ceil(baseCache × ratioBps)`；
6. 通过 → 事务：retire 旧 active（条件 UPDATE）→ `version = max(version)+1` → INSERT（含**五维 New API 成本参照快照**：`newapiRefInput/Output = ceil(base×ratioBps)`、`newapiRefCachedInput/CacheWrite5m/CacheWrite1h = ceil(baseCached*×ratioBps)` + `refNewapiGroup = targetGroup`——勘误 E7/E8：金额层对账按五桶×ref 重算，参照必须随版本锁定且绑定实际路由目标分组，发布后 catalog 基准价/倍率漂移不得影响历史请求重算；`sourceNote` 一并落库）→ **同步写 listing 展示缓存**（`UPDATE catalog_model_listing SET inputMicroUsd/outputMicroUsd = 新价 WHERE modelId=<catalog_model.id>, groupId`，portalModelId→内部 id 需经 `catalogModel.modelId` 转换）→ `recordPortalAdminAudit(action:'price.publish', before/after=新旧版本号+五维)` → 事务外 `revalidateCatalog()`。

`publishModelRoute`（设计 §9.1 按序校验、任一失败拒绝）:
1. 目标分组存在、倍率有效（同上前置①）；
2. `newapiGroup ∈ usableGroups`（否则运行 Key 能建但推理 403——16.2 实测）；
3. 模型调用形态 ∩ 白名单端点 ≠ ∅：解析 `sourceSupportedEndpointTypes`（JSON 数组），与集合 `{chat, responses, messages, embedding, embeddings}` 有交集即过；
4. active `model_price_version` 存在（其发布时已过方向校验，此处不重复算）；
5. 目标模型 `contextWindow` 与 `maxOutputTokens` 非空（worst-case 计算前置，设计 §9.2）；
6. **v1 模型 ID 恒等（评审 F4）**：`newapiModelId` 若提供必须 `=== portalModelId`，否则拒绝（failures check `model_id_identity`）——网关请求体只读不写（设计 §2.1），rawBody 原样转发，重映射模型名依赖 New API 渠道"模型重定向"能力（设计 §17 S3 非一期）；不加此校验会产生"账本记 B、上游收 A"的归因谎言。字段与表结构保留给未来；
7. **价格-路由分组互锁 = 重映射原子双发（勘误 E8 / 评审 R4-F2 + R5-F1）**：若目标 `newapiGroup ≠ active price 的 refNewapiGroup`——
   - `remapPrice` **必填**（未携带 → 拒绝，check `remap_requires_price`；"先单独重发价格"不可行：价格发布按当前 route 取分组，存在鸡生蛋死锁；分开提交则留下 ref=旧组、route=新组 的错绑窗口）；
   - `remapPrice` 按**目标分组倍率**（`groupRatios[目标分组].bps`）过完整五维方向校验（复用 publishPriceVersion 校验 3–5，check `price_direction_on_target_group`）；
   - 通过 → **同一事务**原子完成：retire 旧 price + insert 新 price（五维 ref 按目标分组倍率锁定、`refNewapiGroup=目标分组`）+ retire 旧 route + insert 新 route——网关任意时刻读到的 active 对（route,price）分组一致（Task 15 的 fail-closed 断言封并发残余窗口）+ 双审计（`price.publish` + `routing.publish`）；
   - 目标分组不变的普通路由重发：`remapPrice` 禁止携带（避免歧义），走原有单发路径；
8. 通过 → 事务 retire+insert（version 递增、部分唯一兜底并发）+ 审计 `routing.publish`；返回 `{ ok: true, version }` 并附 `worstCaseMicroUsd`（展示用，不入表、不做门禁）。

`retireModelRoute`：条件 UPDATE active→retired + 审计 `routing.retire`（reason 必填）。

**发布并发 CAS（评审 R6-F2，全部发布事务通用）**：事务前读取的 active route/price（用于 targetGroup 判定、互锁校验、worst-case）在**事务内按捕获的行 ID 条件 retire**——`UPDATE … SET status='retired' WHERE id = :capturedActiveId AND status='active'`（无 active 时事务内断言仍无）；affected 与预期不符 = 校验依据已被并发发布改变 → 抛 `ConcurrentPublishError` 整体回滚，API 返回"配置已变更，请刷新重试"。否则"独立价格发布 ∥ A→B 重映射"交错可留下 route=B/price(ref=A)（resolveActiveRoute fail-closed 只保不资损，模型会持续 404 需人工修）。既有条件 UPDATE 判空范式，零新机制。

```ts
// src/features/routing-admin/server/worst-case.ts —— 设计 §9.2：只算不存
import { ceilDiv, type PriceVector } from '@/features/gateway/lib/billing';

export function computeWorstCaseMicroUsd(input: { contextWindow: number; maxOutputTokens: number; price: PriceVector }): bigint {
  const maxInputSide = Math.max(
    input.price.inputMicroUsdPerM, input.price.cachedInputMicroUsdPerM,
    input.price.cacheWrite5mMicroUsdPerM, input.price.cacheWrite1hMicroUsdPerM
  );
  return ceilDiv(
    BigInt(input.contextWindow) * BigInt(maxInputSide) +
    BigInt(input.maxOutputTokens) * BigInt(input.price.outputMicroUsdPerM),
    1_000_000n
  );
}
```

- [ ] **Step 1: 写失败测试**（setupDb + mock usableGroups；播种 group(synced, ratioBps=12000)/model(price base 齐/缺 cache 两形态)）

```ts
// tests/routing-admin/publish.test.ts —— 关键用例（完整写全）：
test('价格发布：全维过门禁 → 新版 active、旧版 retired、五维 ref 快照=ceil(base×ratio)、listing 展示价同步、审计一条', ...);
test('ref 快照不可变（评审 R3-F7）：发布后修改 catalog 的 cache 基准价 → 已发布版本五维 ref 不变、按其重算历史请求金额结果不变', ...);
test('方向校验拒绝：input 低于 ceil(base×ratio) 1 micro → failures 含 direction:input', ...);
test('cache 基准价缺失 → 拒绝（v1 不卖证据不足模型）', ...);
test('group 未 synced / 基准价 manual 未 review → 拒绝', ...);
test('路由发布：usableGroups 外 → 拒绝；无端点交集 → 拒绝；无 active price → 拒绝；缺 contextWindow/maxOutputTokens → 拒绝', ...);
test('v1 模型 ID 恒等（评审 F4）：newapiModelId ≠ portalModelId → 拒绝（model_id_identity）；缺省/相等 → 通过', ...);
test('倍率取路由目标分组（评审 R4-F2）：active route 指向分组 B（倍率 0.8）而 catalog_group 默认 A（1.2）→ 价格发布按 B 倍率校验并落 refNewapiGroup=B', ...);
test('重映射缺价格 → 拒绝（评审 R5-F1）：目标分组 ≠ 现 refNewapiGroup 且未携带 remapPrice → remap_requires_price', ...);
test('重映射原子双发（评审 R5-F1）：携带合规 remapPrice 切组 → 同事务四写（新旧 price/route）、refNewapiGroup=新组、双审计；remapPrice 方向不过 → 整体拒绝零写入', ...);
test('重映射事务回滚（评审 R5-F1）：注入路由 insert 唯一冲突（并发）→ 价格写入一并回滚、active 对保持旧组一致', ...);
test('同分组重发携带 remapPrice → 拒绝（歧义防呆）', ...);
test('发布 CAS（评审 R6-F2）：模拟"独立价格发布 ∥ A→B 重映射"交错——后提交方条件 retire affected=0 → ConcurrentPublishError 整体回滚、active 对分组恒一致、重试后成功', ...);
test('路由发布成功：version 递增、旧版 retired、响应含 worstCaseMicroUsd', ...);
test('并发双发布：部分唯一索引兜底、恰一个成功', ...);
test('worst-case：ceilDiv((ctx×max输入价 + maxOut×输出价), 1e6) 精确值', ...);
```

- [ ] **Step 2: 跑测试确认失败**。
- [ ] **Step 3: 实现两个文件**（按校验规格；`PublishResult.failures` 每项 `{ check: 'group_sync'|'usable_groups'|'endpoint_intersection'|'price_missing'|'direction:input'|…, message }`）。
- [ ] **Step 4: 跑测试确认通过**。
- [ ] **Step 5: Commit** `feat(routing-admin): 路由与价格版本发布管线（方向校验+worst-case 展示）`

---

### Task 23: RBAC 权限 + admin API 全套

**Files:**
- Modify: `src/core/rbac/permission.ts:16-74`（PERMISSIONS 常量）、`scripts/init-rbac.ts:35-290`（种子数组）
- Create: `src/app/api/apipool/admin/gateway/routing/route.ts`（GET 矩阵 / POST 发布）、`.../gateway/routing/retire/route.ts`、`.../gateway/requests/route.ts`（GET 检索）、`.../gateway/wallet/route.ts`（GET 余额+流水）、`.../gateway/wallet/adjust/route.ts`（POST 调整/冲正）、`.../gateway/wallet/freeze/route.ts`（POST 冻结/解冻）、`.../gateway/reconciliation/route.ts`（GET 差异分列）、`.../gateway/reconciliation/resolve/route.ts`（POST explained/人工闭环）、`.../gateway/metrics/route.ts`（GET 指标聚合）、`.../gateway/audit/route.ts`（GET `portal_admin_audit_log` 倒序分页，权限 `APIPOOL_ROUTING_READ`）
- Test: `tests/gateway/admin-api.test.ts`

**Interfaces:**
- Consumes: Task 8 `applyManualAdjustment/reverseRequestCharge/freezeWallet/unfreezeWallet/recordPortalAdminAudit`、Task 14 `rotateRuntimeCredential`、Task 22 发布函数。
- Produces 权限常量（permission.ts + init-rbac 种子双写；`admin`/`operator` 角色已有 `admin.apipool.*` 通配自动覆盖，无需改角色映射）：

```ts
  APIPOOL_ROUTING_READ: 'admin.apipool.routing.read',
  APIPOOL_ROUTING_WRITE: 'admin.apipool.routing.write',
  APIPOOL_WALLET_READ: 'admin.apipool.wallet.read',
  APIPOOL_WALLET_ADJUST: 'admin.apipool.wallet.adjust',
  APIPOOL_WALLET_FREEZE: 'admin.apipool.wallet.freeze',
  APIPOOL_RECONCILIATION_READ: 'admin.apipool.reconciliation.read',
  APIPOOL_RECONCILIATION_RESOLVE: 'admin.apipool.reconciliation.resolve',
```

- Handler 模式一律照 `src/app/api/apipool/admin/adjust-quota/route.ts:16-29`：`force-dynamic` + `getUserInfo()` + `hasPermission` + 手写清洗 + `respData/respErr` + `withNoStore`；需要可测性的路由用 `routeDeps + __setDepsForTest`（`catalog/pricing/sync/route.ts:15-56` 先例）。

**各 API 行为要点：**
- `wallet/adjust` POST：`{ userId, signedAmountMicroUsd, reason, operationId }`——**`operationId` 调用方必填**（格式 `^[A-Za-z0-9_-]{8,64}$`，评审 F1：幂等键必须跨重试稳定，服务端每次新造 uuid 会让重试重复入账），`idempotencyKey = manual:{operationId}`；或 `{ reverseWalletLedgerId }` → `reverseRequestCharge`（**不收金额入参**——冲正金额恒取原流水绝对值；幂等键 `reverse:<原流水id>` 天然稳定）。审计**不在 API 层单独补**——经 `applyManualAdjustment` 的 `audit` 参数在资金事务内原子写入（评审 F1）：`audit: { action: 'wallet.adjust', targetType: 'wallet_account', targetId: userId, afterJson: { signedAmountMicroUsd, operationId } }`。捕获 `IdempotencyConflictError`（评审 R5-F6：同 operationId 不同载荷）→ `respJson(409, 'idempotency_conflict: operationId 已被不同载荷使用')`，绝不谎报成功。
- `wallet/freeze` POST：`{ userId, action: 'freeze'|'unfreeze', reason }`（reason 必填）→ `freezeWallet(manual)`（成功补审计 `wallet.freeze`）/ `unfreezeWallet`（函数内已审计）。
- `requests` GET：`?id=preq_…` 或 `?newapiRequestId=` 精确查（返回 request_ledger 全字段），或 `?userId=&page=` 分页。
- `reconciliation` GET：分列返回——`mismatches`（token_mismatch/amount_mismatch）、`waived`（**双源 union**：`request_ledger.reconcile_status='waived_by_failure'` 的失败豁免行 + `reconcile_orphan_observation` 未 resolved 的孤儿观测行，带 `source: 'ledger'|'orphan'` 标记——勘误 E6，孤儿不在主账本）、`stuck`（pending_backfill 且 next_backfill_at IS NULL 且 resolved_at IS NULL）、`invariant`（runWalletInvariantCheckOnce 现算）。孤儿行的人工闭环：`resolve` 接受 `{ orphanId, resolution: 'orphan_acknowledged', note }` → 置观测表 `resolved_at`（核实为应收时管理员另行手工 `manual_adjustment` 扣款——默认不扣，policy B）。
- `reconciliation/resolve` POST：`{ ledgerId, resolution: 'explained'|'manual_closed', note }` + 审计 `ledger.waive`——
  - `explained`：条件 UPDATE `reconcile_status='explained'`（金额差异复核，不涉占槽）；
  - `manual_closed`（评审 F9 + 设计 §3.6 "resolved_at 置位释放占用"）：**原子迁移** `UPDATE request_ledger SET status='failed_unbilled', resolved_at=now, reconcile_note=note WHERE id=? AND status='pending_backfill'`——终态即释放风险槽（policy B 语义：结局未知不扣用户）；只写 resolved_at 不改 status 会让该行永久占槽、用户最终全 429。
- `metrics` GET：SQL 聚合（设计 §11.3）——网关近 24h 成功率（settled vs failed_unbilled 计数）、待回填积压（pending_backfill 计数）、负余额用户数与透支敞口（`SUM(min(balance,0))`）、冻结数、waived 计数、credential pending/invalid 计数。纯 `db().select` 聚合，无新表。

- [ ] **Step 1: 写失败测试**（setupDb + `__setDepsForTest` 注入伪 auth：`{ getUserInfo: () => ({id:'op1'}), hasPermission: async () => true/false }`）

```ts
// tests/gateway/admin-api.test.ts —— 关键用例：
test('无权限 → respErr（每路由跑一遍 permission=false）', ...);
test('adjust：operationId 缺失/格式非法 → 拒绝（评审 F1）', ...);
test('adjust 重试幂等（评审 F1）：同 operationId 同载荷二次 POST → 余额只变一次、审计只一条', ...);
test('adjust 幂等冲突（评审 R5-F6）：同 operationId 改金额/改 userId 二次 POST → 409 idempotency_conflict、余额不变', ...);
test('adjust：manual 调整入账+审计同事务；reverse 不收金额、金额=原流水绝对值', ...);
test('freeze/unfreeze：reason 缺失拒绝；解冻走审计', ...);
test('requests 双键检索命中', ...);
test('reconciliation 分列 + resolve：explained 只改 reconcile_status', ...);
test('manual_closed 释放占槽（评审 F9）：穷尽回填行 resolve 后 status=failed_unbilled、该用户立即可再准入', ...);
```

- [ ] **Step 2: 跑测试确认失败**。
- [ ] **Step 3: 实现权限常量+种子+九个 route 文件**（种子跑 `pnpm rbac:init` 验证幂等）。
- [ ] **Step 4: 跑测试确认通过**。
- [ ] **Step 5: Commit** `feat(admin): 网关管理 API 与 RBAC 权限`

---

### Task 24: `/admin/apipool` 工作台 UI + 导航 + i18n

**Files:**
- Create: `src/app/[locale]/(admin)/admin/apipool/page.tsx`、`src/features/routing-admin/components/workbench.tsx`（'use client' 容器）及分 tab 组件 `routing-tab.tsx / requests-tab.tsx / wallet-tab.tsx / reconciliation-tab.tsx / metrics-tab.tsx / audit-tab.tsx`
- Create: `src/config/locale/messages/en/admin/apipool.json`、`src/config/locale/messages/zh/admin/apipool.json`
- Modify: `src/config/locale/index.ts:18-43`（`localeMessagesPaths` 加 `'admin/apipool'`）、`src/config/locale/messages/{en,zh}/admin/sidebar.json`（Operations 组加条目）

**Interfaces:**
- Consumes: Task 23 全部 admin API（客户端组件原生 `fetch`，先例 `api-key-manager.tsx:170-264`）、`requirePermission`（页面级，code=`APIPOOL_ROUTING_READ`）。
- UI 范式：页面壳照 `admin/catalog/vendors/page.tsx`（`setRequestLocale` + `requirePermission` + `Header crumbs` + `Main`）；tab 用 `@/shared/components/ui/tabs`；表格用 `TableCard`/原子 `table`；表单/对话框用 `FormCard`/`dialog`。
- 六标签页内容（设计 §11.2）：
  - **路由**：分组×模型矩阵（GET routing）、当前 route/price 版本（含 refNewapiGroup）、可调用性、发布向导（表单五维价格默认值=基准价×分组折扣、可改；提交后逐条展示校验 failures；显示 worstCaseMicroUsd 与"槽上限×worst=理论敞口"心算提示；**不开放 newapiModelId 输入**——v1 强制恒等，评审 F4；**切组重映射时向导强制进入携带新五维价格的原子双发流程**——评审 R5-F1，UI 检测目标分组 ≠ 现 refNewapiGroup 即展开价格区块并必填）、retire 按钮（reason 必填）。
  - **请求**：按门户 ID / 真实请求 ID 双向检索，全字段详情卡。
  - **钱包**：按 user 查余额/流水分页；冻结/解冻（reason 必填 + 二次确认 dialog）；人工调整（金额+reason；**表单打开时 `crypto.randomUUID()` 生成 `operationId` 存入组件 state，提交与重试复用同一值**——评审 F1 的调用方稳定幂等键）；冲正（选中扣费流水一键冲正，**无金额输入框**）。
  - **对账**：四分列表格（差异/失败豁免【双源：账本豁免 + 孤儿观测，带来源标记】/卡住队列/不变量）+ resolve 操作（note 必填；孤儿行为 `orphan_acknowledged` 闭环）。
  - **指标**：GET metrics 数值卡片（`stat-card.tsx` 复用）。
  - **审计**：`portal_admin_audit_log` 倒序分页（新增只读 GET——并入 Task 23 的 `requests` 同款轻量路由 `.../gateway/audit/route.ts`，权限 `APIPOOL_ROUTING_READ`）。
- i18n：文案全走 `getTranslations('admin.apipool')`；en/zh 双写；人工资金操作按钮文案含"需填写原因"。

- [ ] **Step 1: 建 messages 双语言文件 + localeMessagesPaths + sidebar 条目**（sidebar：`{ "title": "APIPool Gateway", "url": "/admin/apipool", "icon": "Waypoints" }` 进 Operations 组，zh 对应"网关运营"）。
- [ ] **Step 2: 页面壳 + workbench 容器 + 六 tab 逐个实现**（每 tab 对接 Task 23 API；先路由/钱包/对账三个核心 tab，请求/指标/审计随后）。
- [ ] **Step 3: 验证**：`pnpm build` 通过；`pnpm dev` 手动冒烟清单——发布一条路由+价格全流程、钱包调整+冲正+冻结解冻、对账列表可见、无权限用户访问被拒。
- [ ] **Step 4: Commit** `feat(admin): /admin/apipool 网关运营工作台`

---

### Task 25: Dashboard 数据源切换 + 公开目录 callable 过滤

**Files:**
- Create: `src/features/wallet/server/usage-view.ts`
- Modify: `src/app/api/apipool/usage/route.ts:10-33`、`src/app/api/apipool/billing/route.ts:14-46`、`src/features/api-catalog/server/queries.ts`（callable 叠加）、`src/app/[locale]/(landing)/dashboard/usage/page.tsx` 与 `billing/page.tsx`（形状兼容微调）
- Test: `tests/wallet/usage-view.test.ts`

**Interfaces:**
- Consumes: Task 3 `walletDisplayEnabled()`、Task 15 `getCallableModelIds`、schema `requestLedger/walletAccount/walletLedger`。
- Produces:

```ts
// src/features/wallet/server/usage-view.ts
export async function getWalletUsageView(userId: string, range: '7d' | '30d' | 'month'): Promise<{
  summary: { balanceUsd: number; requestCount: number; inputTokens: number; outputTokens: number;
    spendUsd: number; byModel: { modelId: string; requestCount: number; spendUsd: number }[];
    status: 'ok'; syncedAt: string };
  logs: { id: string; modelId: string; status: 'settled' | 'billing' | 'failed_unbilled';
    chargedUsd: number | null; inputTokens: number | null; outputTokens: number | null; createdAt: string }[];
}>
export async function getWalletBillingView(userId: string): Promise<{
  balance: { balanceUsd: number; frozen: boolean };
  ledger: { id: string; entryType: string; signedAmountUsd: number; balanceAfterUsd: number;
    orderNo: string | null; reason: string | null; createdAt: string }[];
}>
```

- 行为（设计 §10.3）：`WALLET_DISPLAY_ENABLED=false` → 两个 route 走现状（`getPortalUsage`/`listBillingLedgerEntries`，零行为变化）；`true` → 切上述新视图。金额换算展示：`micro-USD / 1e6` 保留 6 位。`open/pending_backfill` 显示 `billing`（"计费中"）、`failed_unbilled` 显示失败不计费。`usage_snapshot`/`usage_log_snapshot` 的"停写"随 display 切换自然达成——写入只发生在 `getPortalUsage` 被 dashboard 调用时，切走后不再触发；`getPortalUsage` 本体保留（`usage_snapshot` 余额镜像供阶段一对账，设计 §3.9），不做代码删除。
- 公开目录 callable 叠加（需求决策 14 + 评审 R5-F7）：`queries.ts` 的 `mapListingRows` 产出后，用一次批量查询（active `model_route` ∧ active `model_price_version` 的 `(groupId, portalModelId)` 集合）修正每行 `isCallable = statusIsCallable && hasActiveRouteAndPrice`；`getCallableListingsByGroup`（建 Key 页）同样收紧。目录侧完整 active 链（vendor/group/category/status/capability）由 `queryListingRows` 天然携带，与 Task 15 的共享谓词 `isListingCallable` **保持同一实现来源**——两处判定永不分叉。缓存失效：路由/价格发布已调 `revalidateCatalog()`（Task 22）。

- [ ] **Step 1: 写失败测试**（setupDb 播种 request_ledger settled/pending/failed 各态 + wallet 流水）

```ts
// tests/wallet/usage-view.test.ts —— 关键用例：
test('usage 聚合：spend=Σsettled charged、请求数含全部状态、byModel 分组正确', ...);
test('logs 状态映射：open/pending_backfill→billing、failed_unbilled→failed_unbilled、settled 带金额', ...);
test('billing 视图：balance 换算、ledger 倒序、冻结标记', ...);
test('range 过滤：7d 窗口外的行不计入', ...);
```

- [ ] **Step 2: 跑测试确认失败** → 实现 `usage-view.ts` → 通过。
- [ ] **Step 3: 两个 route 加 `walletDisplayEnabled()` 分支**（false 路径 diff 为零）；dashboard 页面对新形状做最小适配（字段名对齐现有渲染，`logs` 状态标签 i18n `dashboard/usage` 补 en/zh"计费中/失败不计费"）。
- [ ] **Step 4: queries.ts callable 叠加 + 既有 `tests/`（catalog 相关）回归**。
- [ ] **Step 5: 全量 `pnpm test` + `pnpm build`。**
- [ ] **Step 6: Commit** `feat(wallet): dashboard 切换钱包数据源与公开目录可调用性收紧`

---

### Task 26: compose allowlist + Caddy 三态 + fixture 测试

**Files:**
- Modify: `docker-compose.prod.yml:7-22`、`docker-compose.yml:18-33`（environment allowlist）、`deploy/configure-caddy.sh`、`.github/workflows/*`（评审 R12-F1：跑 caddy adapt 断言的 CI job 固定安装 caddy——`caddy-server/setup` 或 apt，缺二进制时 fail 而非 skip）
- Test: `tests/deploy/deploy-automation.test.ts`（扩展）、`tests/deploy/compose-allowlist.test.ts`（新增）、`tests/deploy/caddy-adapt.test.ts`（新增，真实 `caddy adapt`/`caddy validate`）

**Interfaces:**
- Consumes: 既有 `read_env_value()`（`configure-caddy.sh:17-40`）、`--print-config` 干跑（`configure-caddy.sh:4-7,131-134`）、测试骨架 `printCaddyConfig`（`deploy-automation.test.ts:153-157`）。
- Produces: Caddy 三态 `APIPOOL_API_MODE ∈ {legacy, maintenance, portal}`。**deploy.sh 无需改**——模式经 `read_env_value` 从 `.env.deploy` 读，`deploy.sh:48` 已传 `APIPOOL_DEPLOY_ENV_FILE`（这正是设计 §13.2 选文件读的原因）。
- 同时改（评审 R7-F3 + R8-F2 + R9-F2）：`deploy/env.production.example` 显式写 `APIPOOL_API_MODE=legacy`、`.env.deploy.example`（本地）同写；`deploy/server-bootstrap.sh` **不再设任何 bypass 变量**。初始化判据统一到**文件级**（评审 R9-F2：任何"文件已存在但缺行"的修复分支都会给损坏态补 legacy 重开后门、与下方回归测试冲突）：**仅当 `.env.deploy` 文件【整体不存在】时**才原子创建并写入含 `APIPOOL_API_MODE=legacy` 的初始文件（首次引导）；**文件已存在 → bootstrap 绝不触碰 API_MODE**（不 grep、不追加、不修复）。文件存在但 API_MODE 缺失/空/非法一律交给 configure-caddy 无条件 exit 78。这样 `deploy.sh` 普通部署与 bootstrap 重跑（portal 后状态行损坏）都不会静默重开后门。

- [ ] **Step 1: 写失败测试**

`tests/deploy/compose-allowlist.test.ts`（文本断言，不依赖 docker）：

```ts
// 对两个 compose 文件 readFile，断言 environment 段含下列每个键（`KEY: ${KEY}` 形式）：
const REQUIRED = ['GATEWAY_RISK_SLOT_LIMIT','GATEWAY_OVERDRAFT_FREEZE_MICRO_USD','GATEWAY_MAX_BODY_BYTES',
  'GATEWAY_MAX_INFLIGHT','GATEWAY_PARSE_BUFFER_MAX','GATEWAY_FIRST_BYTE_TIMEOUT_MS',
  'GATEWAY_NONSTREAM_TOTAL_TIMEOUT_MS','GATEWAY_STREAM_IDLE_TIMEOUT_MS','GATEWAY_HARD_TIMEOUT_MS',
  'GATEWAY_JOBS_ENABLED','WALLET_LEDGER_WRITE_ENABLED','WALLET_DISPLAY_ENABLED',
  'APIPOOL_CHECKOUT_ENABLED','APIPOOL_API_MODE'];
```

`deploy-automation.test.ts` 追加三态用例（沿用 `printCaddyConfig` + 站点块切分断言）：

```ts
// 三态用例改经【临时 .env.deploy + APIPOOL_DEPLOY_ENV_FILE】注入 API_MODE（评审 R10-F1：不再走 env）
test('API_MODE=legacy（.env.deploy）：api2 /v1* → 3001，newapi 无 /v1 封锁（现状回归）', ...);
test('API_MODE=maintenance（.env.deploy）：api2 /v1* respond 503；newapi handle /v1* respond 404 且 guards 移入 fallback handle', ...);
test('API_MODE=portal（.env.deploy）：api2 /v1* → 127.0.0.1:3000；newapi /v1* 404 保持', ...);
// 评审 R11-F1/R12-F1：字符串断言测不出 Caddy 运行语义与换行合法性，必须真实 `caddy adapt`+`caddy validate`。
// 本地无 caddy 时 test.skip（不阻断贡献者）；【但 CI/release gate 固定装 caddy——见 Files 的 workflow 改动——
// 缺二进制时 fail 而非 skip】，默认 CI 必须能发现非法 Caddyfile（评审 R12-F1）。
// 三种 guards 配置强制覆盖：空 / basic_auth / IP 白名单。
test('Basic Auth 下 /v1* 仍 404 不被 401 抢先（评审 R11-F1）：portal + basic_auth，对 `--print-config` 产出跑 `caddy adapt --config -`，断言 newapi host 的 /v1* 终结于 static_response(404)、route 排序先于/独立于 authentication handler；管理路径（非 /v1）仍在受 auth 的 fallback handle 内', ...);
test('非空 guards Caddyfile 合法（评审 R12-F1，回归根因）：basic_auth 与 IP 白名单两种配置各跑 `caddy validate`——断言 guards 末行（闭合 } / respond 403）与 reverse_proxy 分处独立行、验证通过（换行未被命令替换吞掉）', ...);
test('回归（评审 R11-F1）：guards 为空（无 basic_auth/IP）时两 handle 结构仍合法、/v1*=404、fallback 裸反代、caddy validate 通过', ...);
test('非法 API_MODE → exit 非 0（fail-closed）', ...);
test('缺失/空 API_MODE → exit 78 零副作用（评审 R7-F3/R8-F2：无条件、无 bypass、不重开后门）', ...);
test('env 旁路封堵（评审 R10-F1）：文件=portal 而 env APIPOOL_API_MODE=legacy → exit 78 零副作用（不生成 legacy Caddy）', ...);
test('env 旁路封堵（评审 R10-F1）：文件缺 API_MODE 行 而 env=legacy → exit 78 零副作用', ...);
test('env 与文件一致放行（评审 R10-F1）：文件=portal ∧ env=portal → 正常生成 portal 配置', ...);
test('env.production.example 与 .env.deploy.example 显式含 APIPOOL_API_MODE=legacy（评审 R7-F3 模板不留空）', ...);
test('server-bootstrap 文件级初始化（评审 R9-F2）：.env.deploy 不存在 → 原子创建且含 APIPOOL_API_MODE=legacy；文件已存在（无论缺不缺 API_MODE 行）→ bootstrap 绝不触碰 API_MODE', ...);
test('bootstrap 重跑不重开后门（评审 R8-F2/R9-F2）：portal 态删 API_MODE 行后跑 bootstrap→configure-caddy → exit 78、Caddyfile 不变（不回 legacy、不撤 newapi 404）', ...);
```

- [ ] **Step 2: 跑测试确认失败**。
- [ ] **Step 3: 实现**

compose 两文件 environment 段各追加 14 行 `KEY: ${KEY}` 映射。

`configure-caddy.sh` 改动（在 42-47 变量区之后）：

```bash
# 切流三态：环境变量优先，其次 .env.deploy 字面量（read_env_value），默认 legacy。
# API_MODE 单一事实源 = .env.deploy（评审 R10-F1：env 优先会让 deploy/bootstrap 继承的
# shell 残留/导出 legacy 盖过文件 portal 值 → 重开后门）。只从文件读；env 若也设了且与文件
# 不符则 fail-loud exit 78（操作员混淆）。这与既有 APIPOOL_API_UPSTREAM 的 env-first 范式有意不同——
# API_MODE 是安全攸关的状态标志，不容 env 旁路。
FILE_API_MODE="$(read_env_value APIPOOL_API_MODE)"
ENV_API_MODE="${APIPOOL_API_MODE:-}"
if [ -n "$ENV_API_MODE" ] && [ "$ENV_API_MODE" != "$FILE_API_MODE" ]; then
  echo "configure-caddy: APIPOOL_API_MODE env ('$ENV_API_MODE') != .env.deploy ('$FILE_API_MODE') — refusing (env must not override state file)" >&2
  exit 78
fi
API_MODE="$FILE_API_MODE"
# 缺失/空 API_MODE：【无条件】exit 78，无任何逃生口（评审 R7-F3 + R8-F2）：
# deploy.sh 每次普通部署直连本脚本、不过 cutover 的 require_state；若这里默认 legacy 或留
# bypass 变量，则损坏 env / 模板漏项 / 恢复旧 env / 重跑 server-bootstrap 都会静默恢复
# api2→New API 直连并取消 /v1 封锁 = 重开后门、旧 Key 绕过钱包账本。
# 首次引导不靠 bypass——server-bootstrap 首次初始化时【原子写显式 APIPOOL_API_MODE=legacy 到
# .env.deploy】（见 T26 bootstrap 改动），此后本脚本读到的永远是显式值。
if [ -z "$API_MODE" ]; then
  echo "configure-caddy: APIPOOL_API_MODE missing/empty in .env.deploy — refusing (would silently reopen legacy backdoor)" >&2
  exit 78
fi
case "$API_MODE" in
  legacy|maintenance|portal) ;;
  *)
    echo "configure-caddy: invalid APIPOOL_API_MODE '$API_MODE' (expect legacy|maintenance|portal)" >&2
    exit 78
    ;;
esac

# api2 /v1* 的按态指令块
case "$API_MODE" in
  legacy)     api_v1_directive="		reverse_proxy $API_UPSTREAM" ;;
  maintenance) api_v1_directive="		respond \"service maintenance\" 503" ;;
  portal)     api_v1_directive="		reverse_proxy $PORTAL_UPSTREAM" ;;
esac

# newapi /v1* 封锁（maintenance/portal 态注入且此后保持——防绕计费后门，设计 §12.2 / 勘误 E9）。
# 【关键，评审 R11-F1】必须用两个互斥 handle，不能靠文本顺序：Caddy 按固定指令顺序执行，
# 顶层 basic_auth 会先于 handle → Basic Auth 部署下 /v1* 探测得 401 而非 404、卡死切流。
# 结构：handle /v1* { respond 404 }（块内【无】任何 auth 指令）+ 无 matcher fallback handle
# { <guards> reverse_proxy }。handle 组互斥 → /v1* 命中 404 块后不进 fallback 的 auth。
# 因此 guards（basic_auth/IP 白名单）从 vhost 顶层【移入 fallback handle 内】（再缩进一级）。
if [ "$API_MODE" = "legacy" ]; then
  # legacy：维持现状——顶层 guards + 单反代（/v1 仍受保护地反代到 New API），无 /v1 特殊处理
  newapi_site_body="$newapi_guards	reverse_proxy $NEWAPI_UPSTREAM"
else
  # maintenance/portal：两互斥 handle，guards 进 fallback handle。
  # 【评审 R12-F1】禁止依赖变量尾换行——命令替换 $(…) 会吞掉尾换行，导致 guards 末行（如 basic_auth
  # 的闭合 `}` 或 IP guard 的 `respond … 403`）与 reverse_proxy 挤到同一行 → Caddyfile 非法、
  # caddy validate 失败保留旧路由 → 切流卡死。因此 reverse_proxy 由模板【独占一行显式输出】，
  # 不拼在 guards 变量后面：
  newapi_fallback_inner="		reverse_proxy $NEWAPI_UPSTREAM"
  if [ -n "$newapi_guards_indented" ]; then
    # guards 各行已含 \t\t 缩进，逐行在前；reverse_proxy 另起一行（printf 显式换行，不靠变量尾换行）
    newapi_fallback_inner="$(printf '%s\n%s' "$newapi_guards_indented" "		reverse_proxy $NEWAPI_UPSTREAM")"
  fi
  newapi_site_body="	handle /v1* {
		respond \"not found\" 404
	}
	handle {
$newapi_fallback_inner
	}"
fi
```

heredoc 模板（106-129）中 api2 块的 `reverse_proxy $API_UPSTREAM` 行替换为 `$api_v1_directive`；newapi 块的 `$newapi_guards\treverse_proxy $NEWAPI_UPSTREAM` 整段替换为 `$newapi_site_body`（顶层不再直接放 guards——legacy 由 body 内含、非 legacy 移入 fallback handle）。`$newapi_guards_indented` 由现有 guards 生成逻辑（configure-caddy.sh:90-102）在其**普通字符串赋值**（非命令替换）基础上，把每行加 `\t\t` 缩进得到（空 guards 时为空）；**关键：guards 与 reverse_proxy 之间的换行由上方 `printf '%s\n%s'` 显式产生，不复用任何变量的尾换行**（这是 R12-F1 的根因）。

- [ ] **Step 4: 跑测试确认通过**（含既有 legacy 用例零回归——`deploy-automation.test.ts` 全部旧断言仍绿）。
- [ ] **Step 5: Commit** `feat(deploy): Caddy 三态切流与容器 env allowlist`

---

### Task 27: `deploy/cutover.sh` + Live 冒烟扩展

**Files:**
- Create: `deploy/cutover.sh`、`scripts/smoke-gateway.ts`、`scripts/smoke-recharge.ts`（设计 §461/评审 R14-F2 首笔充值双写 smoke）
- Modify: `deploy/live-smoke.sh`（加 `--gateway` 与 `--recharge` 模式）、`deploy/deploy.sh`（评审 R15-F1：部署后 recharge-smoke fail-closed 门禁——见下）、`Dockerfile`（把 smoke-gateway/smoke-recharge 编译产物一并打包，参照 smoke-mvp.cjs 现有打包方式）
- Test: `tests/deploy/cutover.test.ts`

**Interfaces:**
- Consumes: Task 26 三态、既有 flock 锁模式（`deploy.sh:8,17-21`）、`read_env_value` 语义。
- Produces: `cutover.sh <preflight|maintenance|activate-wallet|portal|finalize|status>`，逐态原子推进（设计 §13.2 序列 0–7 的工装）。
- **前态状态机（评审 F3）**：每个子命令执行前用 `read_env_value` 读取 `.env.deploy` 四开关现值做前态断言，不满足 → `exit 78` + 明确指出当前态与要求态，**顺序不可跳级**：

| 子命令 | 要求前态（全部满足） | 动作后态 |
| --- | --- | --- |
| `maintenance` | `API_MODE ∈ {legacy, maintenance, portal}`（幂等重入允许；**portal→maintenance = 设计 §13.2 的故障收敛路径**，评审 R2-F2） | `API_MODE=maintenance` + `CHECKOUT=false` |
| `activate-wallet` | `API_MODE=maintenance` ∧ `CHECKOUT=false` ∧ **实时隔离探测通过**（评审 R5-F5：`api2/v1/models=503 ∧ newapi/v1/models=404`——maintenance 写文件后、recreate/recaddy/探测前崩溃时，文件已是 maintenance 但 Caddy 仍 legacy、旧数据面还在接单；文件态不可信，激活钱包前必须复核真实隔离，失败提示重跑 maintenance）∧ `--evidence` 文件存在 + 交互确认。半状态（两开关仅其一 true——写入中断产物，评审 R3-F6）允许重跑：重新确认证据后**幂等收敛补齐**；**已全激活重跑 → 不跳过**：仍幂等执行 recreate + 容器运行态验证（评审 R4-F5：文件已写但 recreate 前崩溃 = 文件 true、容器旧值，只看文件会误判成功） | `WALLET_LEDGER=true` + `WALLET_DISPLAY=true`（**单次原子批量写 → recreate → 容器运行态验证**） |
| `portal` | `API_MODE=maintenance` ∧ `CHECKOUT=false` ∧ `WALLET_LEDGER=true` ∧ `WALLET_DISPLAY=true`（**全四开关**，评审 R3-F6：半激活切流 = 扣真钱但页面展示旧余额）∧ **实时隔离探测通过**（评审 R5-F5，同 activate-wallet：503/404 双探测）∧ **容器运行态验证**（评审 R4-F5：`docker compose exec apipool-v2 printenv` 断言两钱包键实际为 true——文件与运行态之间的崩溃窗口只能靠验证运行态覆盖）；**切换后探测失败 → 自动执行 maintenance 收敛 + exit 非 0**（评审 R2-F2：不能把外部流量留在故障网关上） | `API_MODE=portal` |
| `activate-wallet`（尾） | 上述开关+运行态通过后 → 跑**首笔充值双写 smoke**（设计 §461/评审 R14-F2，checkout 仍冻结），成功写 `.cutover-recharge-ok`（含 IMAGE_TAG） | 钱包激活 + 充值 smoke 在案 |
| `portal` | 追加前态 `.cutover-recharge-ok` 存在且 IMAGE_TAG 匹配当前发布（评审 R14-F2：未验证首笔充值双写不得切流开放收款路径）——其余同上 | `API_MODE=portal` |
| `finalize` | `API_MODE=portal` ∧ `WALLET_LEDGER=true` ∧ `WALLET_DISPLAY=true` ∧ `.cutover-smoke-ok` ∧ `.cutover-recharge-ok`（IMAGE_TAG 匹配）+ 交互确认（在 portal 态后跑过）∧ 三探测全过 | `CHECKOUT=true` |

  跳级的真实危害（评审 F3 构造的场景）：legacy 下先开钱包 → 充值同时进钱包与 New API，旧数据面消费只扣 New API quota，切流后钱包余额可再消费一遍——前态断言使该路径在脚本层不可达。**回 legacy 在任何子命令中都不可达**（legacy 不是任何命令的目标态——重开 newapi 后门被结构性禁止）；唯一后退方向是 `portal → maintenance`（fix-forward 隔离，评审 R2-F2 修正了第一轮把它误封死的回归）。`.cutover-smoke-ok` 由 `live-smoke.sh --gateway` 成功时写入（内容=ISO 时间戳），跑 smoke 前 finalize 必然被拒。演练证据的**结构化机器解析不做**（证据格式属备份 feature、v1 单运营尺度），保持"文件存在 + 交互确认"。

**`deploy/cutover.sh` 规格（完整脚本按此写）：**

```bash
#!/bin/sh
# 网关切流逐态推进。故障处理 = fix-forward：保持/收敛 maintenance，不回 legacy（设计 §13.2）。
set -eu
APP_DIR="${APIPOOL_DEPLOY_DIR:-/opt/apipool-v2}"
ENV_FILE="$APP_DIR/.env.deploy"
LOCK_FILE="${APIPOOL_DEPLOY_LOCK:-/run/apipool-v2-deploy.lock}"
# flock 独占（同 deploy.sh），防与部署并发

# 批量幂等写 KEY=VALUE…（评审 R3-F6 + R6-F4）：全部键在【同目录】临时文件上逐个替换/追加，
# 最后 mv 原子替换（rename 系统调用）——install/cp 是复制语义，中断可截断 .env.deploy，
# 而 configure-caddy 对缺失 API_MODE 默认 legacy = 损坏文件会静默重开 newapi 后门。
# rename 保证任意时刻只能观察到完整旧文件或完整新文件。单键场景同样走本函数。
set_env_values() {
  tmp="$(mktemp "$(dirname "$ENV_FILE")/.env.deploy.XXXXXX")"  # 同文件系统，rename 才原子
  trap 'rm -f "$tmp"' EXIT
  cp "$ENV_FILE" "$tmp"
  for kv in "$@"; do
    key="${kv%%=*}"; value="${kv#*=}"
    if grep -q "^${key}=" "$tmp"; then
      tmp2="$(mktemp)"
      awk -v k="$key" -v v="$value" 'index($0, k"=")==1 { $0 = k"="v } { print }' "$tmp" > "$tmp2"
      cat "$tmp2" > "$tmp"; rm -f "$tmp2"
    else
      printf '%s=%s\n' "$key" "$value" >> "$tmp"
    fi
  done
  chmod 600 "$tmp"
  sync                      # 掉电兜底（v1 尺度：sync 全局刷盘代替逐文件 fsync）
  mv -f "$tmp" "$ENV_FILE"  # rename 原子替换
  trap - EXIT
}

probe() {  # probe <url> <expected_status> [header...]
  status="$(curl -s -o /dev/null -w '%{http_code}' "$@" 2>/dev/null || echo 000)"
  ...
}

recreate() { (cd "$APP_DIR" && docker compose --env-file .env.deploy --env-file release.env -f docker-compose.prod.yml up -d); }
recaddy()  { APIPOOL_DEPLOY_ENV_FILE="$ENV_FILE" "$APP_DIR/deploy/configure-caddy.sh"; }

current() { read_env_value "$1"; }   # 复用 configure-caddy.sh 同款 read_env_value 实现（内嵌一份）

require_state() {  # 前态断言（评审 F3 + R6-F4）：require_state <KEY> <expected...>；不符 exit 78
  key="$1"; shift
  val="$(current "$key")"
  # 空值默认失败（评审 R6-F4）：切流期间行缺失 = 状态文件可能损坏，绝不沿用 configure-caddy
  # 的 legacy 默认（那只服务首次部署）；仅当 expected 显式含 ''（如 maintenance 允许
  # "首次切流、API_MODE 尚未写入"）才放行空值。
  for want in "$@"; do [ "$val" = "$want" ] && return 0; done
  if [ -z "$val" ]; then
    echo "cutover: $key 在 .env.deploy 中缺失或为空——状态文件可能损坏，禁止继续" >&2
  else
    echo "cutover: $key='$val' 不满足前态要求（需要: $*）——切流不可跳级，先执行上一步" >&2
  fi
  exit 78
}
# maintenance 前态调用形如：require_state APIPOOL_API_MODE legacy maintenance portal ''
# （'' = 首次切流；其余子命令一律不含 ''——空值必须先重跑 maintenance 重建状态）

case "${1:-}" in
  preflight)   # 序列 1：内网直打 live 冒烟 + 路由/价格已发布自检（curl 127.0.0.1:3000/v1/models 无 Key 期待 401）
  maintenance) # 序列 2 + 故障收敛入口（前态：legacy|maintenance|portal——portal→maintenance 是
               #   设计 §13.2 "保持/收敛到 maintenance" 的唯一后退方向，评审 R2-F2；幂等重入允许）
               #   require_state APIPOOL_API_MODE legacy maintenance portal ''
               #   set APIPOOL_API_MODE=maintenance + APIPOOL_CHECKOUT_ENABLED=false → recreate → recaddy
               #   → probe api2/v1/models=503 ∧ newapi/v1/models=404，双过才报成功
  activate-wallet) # 序列 4（①.5）（前态：maintenance ∧ checkout 已冻结——评审 F3/R3-F6/R4-F5：
               #   legacy 下先开钱包 = 同一笔充值买两份消费，脚本层封死；半状态允许重跑收敛；
               #   已全激活重跑不跳过——文件≠运行态）
               #   require_state APIPOOL_API_MODE maintenance
               #   require_state APIPOOL_CHECKOUT_ENABLED false
               #   probe api2/v1/models=503 ∧ newapi/v1/models=404（评审 R5-F5：文件态不可信，
               #     激活钱包前复核真实隔离；失败 → exit 非 0 + 提示重跑 maintenance）
               #   --evidence <备份演练证据文件路径> 必填且存在 + 交互确认（printf 摘要 + read -r 确认；
               #     半状态/已全激活重跑同样重新确认证据，评审 R3-F6/R4-F5）
               #   set_env_values WALLET_LEDGER_WRITE_ENABLED=true WALLET_DISPLAY_ENABLED=true（单次原子落盘）
               #   → recreate（幂等；文件已 true 时同样执行——覆盖"写文件后 recreate 前崩溃"窗口，评审 R4-F5）
               #   → verify_container_env WALLET_LEDGER_WRITE_ENABLED true ∧ WALLET_DISPLAY_ENABLED true
               #     （docker compose exec -T apipool-v2 printenv <KEY>，不符 exit 非 0）
               #   → 首笔充值双写 smoke（设计 §461 / 评审 R14-F2；checkout 仍冻结、走内部受控路径）：
               #     live-smoke.sh --recharge → smoke-recharge.ts 断言（下方清单）→ 成功写
               #     .cutover-recharge-ok（内容=ISO 时间戳 + IMAGE_TAG，绑定当前发布）；失败 exit 非 0
  portal)      # 序列 5（前态：maintenance ∧ checkout 冻结 ∧ 钱包完整激活 + 首笔充值 smoke 在案——评审 R3-F6/R4-F5/R14-F2）
               #   require_state APIPOOL_API_MODE maintenance
               #   require_state APIPOOL_CHECKOUT_ENABLED false
               #   require_state WALLET_LEDGER_WRITE_ENABLED true
               #   require_state WALLET_DISPLAY_ENABLED true
               #   [ -f .cutover-recharge-ok ] 且其 IMAGE_TAG == 当前 release.env IMAGE_TAG || exit 78
               #     （评审 R14-F2：未验证首笔充值双写不得开放收款路径切流；标志绑定当前发布防陈旧）
               #   probe api2/v1/models=503 ∧ newapi/v1/models=404（评审 R5-F5：切流前复核隔离仍然真实生效）
               #   verify_container_env WALLET_LEDGER_WRITE_ENABLED true ∧ WALLET_DISPLAY_ENABLED true
               #     （评审 R4-F5：文件为 true 但容器未重建时禁止切流；失败提示先重跑 activate-wallet）
               #   set APIPOOL_API_MODE=portal → recaddy → probe api2 无 Key=401（门户网关特征）∧ newapi=404
               #   探测失败（评审 R2-F2）→ 自动收敛：set APIPOOL_API_MODE=maintenance → recaddy
               #     → probe 503/404 → 报告"portal 切换失败，已收敛 maintenance" + exit 非 0
               #     （不把外部流量留在故障网关；修好后重跑 portal 前滚）
  finalize)    # 序列 6（前态：portal ∧ 网关 smoke + 首笔充值 smoke 标志均在案）
               #   require_state APIPOOL_API_MODE portal
               #   [ -f "$APP_DIR/.cutover-smoke-ok" ] || exit 78（先跑 live-smoke.sh --gateway）
               #   [ -f "$APP_DIR/.cutover-recharge-ok" ] 且 IMAGE_TAG 匹配 || exit 78（评审 R14-F2：
               #     开放 checkout 前必须已验证首笔充值双写）
               #   交互确认 smoke 在 portal 态之后执行过（打印两标志文件内容=ISO 时间戳）
               #   三探测全过（newapi/v1/models=404、api2/api/status=404、api2/v1/models=401）
               #   → set APIPOOL_CHECKOUT_ENABLED=true → recreate
  status)      # 打印 .env.deploy 当前四开关值 + 三探测实时结果
esac
```

**`scripts/smoke-gateway.ts` 断言清单（设计 §15 Live 冒烟，切流前后各跑）：**
1. 本地建 Key：调 keys API 创建 → 断言 DB 有哈希行且**零远端调用**（对照 New API token 列表数不变）；
2. OpenAI SDK `Bearer` + Anthropic SDK `x-api-key`：chat/responses/messages/embeddings 非流式 + chat/messages 流式，全部 200；
3. 每请求断言：`request_ledger` 捕获真实 `newapi_request_id`、终态 `settled`、`charged == computeChargeMicroUsd(桶, price)` 重算、`wallet_ledger` 扣费一条、余额闭合；
4. 到达 New API 无门户 Key 载体（借 New API 日志/`request_ledger.newapi_token_name` 以 `rk_` 开头佐证）；
5. 禁用 Key → 401；把测试钱包 `manual_adjustment` 清零 → 429。

**`scripts/smoke-recharge.ts` 断言清单（设计 §461 / 评审 R14-F2；`activate-wallet` 与 `portal` 之间跑，checkout 仍冻结、走内部受控支付回调路径，不开放外部收款）：**
1. 构造受控订单 → 触发 `handleCheckoutSuccess`（内部直调，模拟支付成功回调）；
2. 断言 `order.status === PAID`；
3. 断言 `wallet_ledger` 按 `order_no` **恰一条** `recharge`、`signed_amount_micro_usd == order.amount(美分) × 10_000`（美分→micro-USD 换算正确，正是 R7-F4/wallet-only 事务分支的守卫）；
4. 断言 `credit` 表**零新增**（停写 credit）；
5. 余额守恒 `wallet_account.balance == Σ wallet_ledger.signed`；
6. **重放幂等**：二次 `handleCheckoutSuccess` 同 order → 仍一条 recharge、余额不变；
7. 清理：带审计的 `manual_adjustment` 冲回该测试余额（不留脏数据）。
成功 → 写 `.cutover-recharge-ok`（内容 = ISO 时间戳 + 当前 `IMAGE_TAG`）。

`live-smoke.sh`：`--gateway` 跑 `node ./smoke-gateway.cjs` 成功写 `.cutover-smoke-ok`；新增 `--recharge` 跑 `node ./smoke-recharge.cjs` 成功写 `.cutover-recharge-ok`（内容含 `IMAGE_TAG`，评审 R14-F2 绑定当前发布防陈旧标志）。两者 compose run 段复制现有 94-107 行模式；smoke-recharge 编译产物同 smoke-mvp.cjs 打包进镜像。

**`deploy.sh` 发布 recharge 门禁（评审 R15-F1 + R16-F1，轻量 fail-closed、冻结在前）**：仅当当前 `.env.deploy` 为 **`APIPOOL_API_MODE=portal` 且 `APIPOOL_CHECKOUT_ENABLED=true`**（已 go-live 的常规发布）时触发。**关键顺序（R16-F1）：冻结 checkout 必须【在镜像替换之前】**——否则替换→smoke 完成的窗口内新（未验证）镜像已对外 checkout=true，且冻结前已建的支付会话回调仍会在新镜像结算：

```sh
mode="$(read_env_value APIPOOL_API_MODE)"; co="$(read_env_value APIPOOL_CHECKOUT_ENABLED)"
gated=0
if [ "$mode" = "portal" ] && [ "$co" = "true" ]; then
  gated=1
  # ① 换镜像【之前】先冻结 checkout（原子写，评审 R6-F4）——checkoutEnabled() fail-closed 门控【创建】：
  #    冻结后新支付会话创建被拒；结算路径不受此门控（评审 R17-F1，否则 recharge smoke 无法通过）
  set_env_values APIPOOL_CHECKOUT_ENABLED=false
fi
# ② 常规部署（compose pull + up -d 新 IMAGE_TAG）+ healthcheck（现有流程）
# ③ gated 时：新镜像跑 recharge smoke，成功才【重开】checkout
if [ "$gated" = "1" ]; then
  if ./deploy/live-smoke.sh --recharge; then
    set_env_values APIPOOL_CHECKOUT_ENABLED=true   # 验证通过：重开收款（live-smoke 已刷新 .cutover-recharge-ok=新 tag）
    compose up -d                                   # 使重开生效
  else
    echo "[deploy] RECHARGE SMOKE FAILED on $IMAGE_TAG — checkout stays frozen (fail-closed)" >&2
    exit 75   # 保持冻结（已在 ① 冻结）；推理面不受影响、收款停、告警人工
  fi
fi
```

轻量取舍（阶段校准）：不对每次常规发布做完整 maintenance 循环（推理面无回归风险、不中断）；冻结**创建**在前 + 发布 recharge smoke，闭合"未验证镜像被新建的支付会话喂真钱"这条主旁路。首次切流仍走 cutover.sh 全序列。`set_env_values` 从 cutover.sh 抽到共享 `deploy/lib.sh`（deploy.sh 与 cutover.sh 共用同目录 mktemp+mv 原子写，评审 R6-F4）。

**已知残留（评审 R17，记 issues.md）**：结算路径（`handleCheckoutSuccess`）不受 checkout 门控（否则 recharge smoke 无法通过——R17-F1）。故换镜像**前已建**的在途支付会话，其 webhook 若恰在"新镜像已起、recharge smoke 尚未判定"的**数秒窗口**到达，会在未最终验证的镜像上结算一笔。该窗口秒级、仅命中冻结前已存在的会话（冻结后无新会话）；由每小时**钱包不变量自检**（`runWalletInvariantCheckOnce`）兜底可见、人工 `manual_adjustment` 冲正。pre-launch 低量单运营下可接受；若未来量增，再评估把结算纳入可重试的发布门控（届时须同时解决 R17 三个衍生问题，非本 v1 范围）。

- [ ] **Step 1: 写失败测试**（`tests/deploy/cutover.test.ts`：spawnSync 跑 `cutover.sh env-set-batch K1=V1 K2=V2` 暴露的内部子命令供测——断言幂等替换/追加/引号值不破坏，且**多键单次原子落盘**（对临时 env 文件断言两键同时出现、写入期间无中间态文件残留，评审 R3-F6）；`status` 子命令在无 curl 目标时输出四开关值；**前态断言（评审 F3）**：用临时 `.env.deploy` 构造各非法前态，断言跳级调用 `exit 78`——`APIPOOL_API_MODE=legacy` 时 `activate-wallet`/`portal`/`finalize` 全拒、`maintenance` 态钱包未激活/半激活时 `portal` 拒、`portal` 态无 `.cutover-smoke-ok` 时 `finalize` 拒；**半状态恢复（评审 R3-F6）**：构造 `LEDGER=true ∧ DISPLAY=false` 中断产物 → `portal` 被拒、`activate-wallet` 重跑幂等收敛成功（两键补齐、单次落盘）；**rename 原子性（评审 R6-F4）**：文本断言 `set_env_values` 实现用同目录 mktemp + `mv -f`、全脚本无 `install` 写 `.env.deploy`；空值前态：删除 API_MODE 行后 `activate-wallet`/`portal`/`finalize` 全拒（提示状态文件损坏）、`maintenance` 仍可执行（首次切流路径）；**文件-运行态窗口（评审 R4-F5）**：mock `docker compose`（PATH 注入假脚本记录调用）——文件已全 true 时 `activate-wallet` 重跑仍调用 recreate 与 printenv 验证；printenv 返回旧值时 `portal` 拒绝并提示重跑 activate-wallet；**隔离复核（评审 R5-F5）**：`APIPOOL_CUTOVER_PROBE_BASE` 指向 mock——探测返回非 503/404（模拟 maintenance 写文件后被 kill、Caddy 仍 legacy）时 `activate-wallet` 与 `portal` 均被拒并提示重跑 maintenance；**故障收敛（评审 R2-F2）**：`APIPOOL_API_MODE=portal` 时 `maintenance` 被允许且写回 maintenance + CHECKOUT=false；`portal` 探测失败路径自动把 `.env.deploy` 收敛回 maintenance 并 exit 非 0——探测目标用 `APIPOOL_CUTOVER_PROBE_BASE` 指向本地 mock/不可达端口注入失败）。
- [ ] **Step 2: 实现 cutover.sh** → 测试通过。
- [ ] **Step 3: 实现 smoke-gateway.ts + smoke-recharge.ts**（结构照 `scripts/smoke-mvp.ts`/`smoke-mvp-runner.ts`；Dockerfile 打包同款）→ 本地对 dev 服务器跑通（`pnpm dev` + 播种数据）；smoke-recharge 覆盖设计 §461 七条断言（PAID/单条 recharge/美分换算/零 credit/守恒/重放幂等/审计冲回）。
- [ ] **Step 4: live-smoke.sh 扩展（--gateway + --recharge）+ deploy.sh 发布 recharge 门禁 + `tests/deploy/` 全量回归**：cutover 前态断言（无 `.cutover-recharge-ok`/IMAGE_TAG 不匹配 → `portal`/`finalize` 被拒，评审 R14-F2）；deploy.sh 门禁回归（评审 R15-F1/R16-F1）——① **冻结在前**：`portal+checkout=true` 态发布，断言 `APIPOOL_CHECKOUT_ENABLED=false` 在 `compose pull/up` 之前被原子写（调用序断言）；② mock `--recharge` 失败 → checkout 保持 false、exit 75；③ 成功 → checkout 重开为 true、`.cutover-recharge-ok` 刷新新 IMAGE_TAG；④ `legacy`/`maintenance` 或 checkout≠true 态不触发门禁（不误冻）。
- [ ] **Step 5: Commit** `feat(deploy): cutover 逐态推进脚本与网关 live 冒烟`

---

### Task 28: 文档与终检

**Files:**
- Modify: `docs/deployment.md`（Runtime Architecture 三态路由表 + 切流引用）、`docs/07-runbook.md`（新章节"网关切流 runbook"）、`deploy/env.production.example` / `.env.example`（终检对齐实际实现）
- Create: `docs/dev/portal-newapi-routing-billing-decoupling/issues.md`（遗留清单）

**内容要点：**

- [ ] **Step 1: `docs/07-runbook.md` 新章节**，逐条写入：
  - 切流序列表（设计 §13.2 步骤 0–7 → `cutover.sh` 子命令映射 + 每步探测命令与期待值 + **前态状态机表**：脚本会拒绝跳级，runbook 说明每步被拒时的含义与补救）；
  - **前置门禁**：备份恢复演练证据在案才可 `activate-wallet`（含 `APIPOOL_CREDENTIALS_SECRET` 托管边界确认）；
  - 生产迁移只读验证 SQL：`sqlite3 file:data/portal/portal.db?mode=ro "PRAGMA table_info(wallet_ledger);"` 等（Task 1 关键列清单）；
  - 故障处理 = fix-forward：收敛 maintenance（api2 503、newapi 404）修好前滚；**不回 legacy**（会重开 newapi 后门）；镜像可回上一 `IMAGE_TAG` 但 API 保持 maintenance；
  - 在途排空与水位记录（活跃连接计数为 0 + 各用户 quota 快照命令）；
  - 观察期 72h 检查清单（对账差异/waived 量/钱包不变量/回填积压）+ 收尾：作废旧 `newapi_key_binding` 远端 token；
  - 告警最小集与对应 console 关键字（`overdraft_freeze`/`token_mismatch`/`wallet_invariant_broken`/`backfill_backlog_high`/`waived_by_failure_high`/`credential_create_failed`/`unmapped_usage_dimension`（评审 R6-F5：协议演进信号，触发白名单扩展流程）/`route_price_group_mismatch`/`reconcile_truncated`——grep 服务日志的检索式）。
- [ ] **Step 2: `docs/deployment.md`** Runtime Architecture 表更新（api2 三态指向 + newapi /v1 封锁说明）+ Pre-Deploy Checks 补 `compose config` 与 Caddy 三态 fixture 测试入口。
- [ ] **Step 3: env 模板终检**：对照代码实际读取的变量名逐一核对两个 example 文件（防实现期改名漂移）。
- [ ] **Step 4: `docs/dev/portal-newapi-routing-billing-decoupling/issues.md`** 初始化遗留清单（`- [ ]` 格式）：
  - Spike S1/S2 结论回填（admin 日志接口形态、cache 计价字段）；
  - 设计 §16 已知待观察项：风险槽默认 10 对高并发客户端（Claude Code/Codex 类）可能撞 429，需按目标用户群调；
  - 设计 §17 已知局限五条原样登记（上游品牌残留/SQLite 边界/policy B 运营吃/掐流白嫖离线查/同进程波及）；
  - 对设计原文的全部有意偏差已收编为 PLAN.md **设计勘误表 E1–E6**（评审 R2-F1 处置），issues 不再重复登记，只记运营观察项；
  - sweeper 对"有 request id 的超时 open 行转 pending_backfill"是设计缝隙的最小闭合（Task 20），运营期观察；
  - 评审 F8 降级修（stale 5min + keepAlive 穿插续租，拒绝 fencing token）的残余竞态窗口由业务唯一索引幂等兜底——若运营期观察到双活副作用（同 scope 双 token / 水位乱序），再评估升级为 fencing（届时属独立 feature）；
  - 评审 R4-F1 降级修（finalize 终态写入 3 次退避重试，拒绝持久化意图 marker——设计 §0#6 明文删除 dispatch marker）的残余窗口：流中断 ∧ 单条 UPDATE 三连失败 → open 残留经 sweeper 转回填后可能按日志错扣一笔；与设计 §10.2"open 命中日志走结算"的既有近似同源，可经对账发现并人工冲正——若运营期实际出现，再评估终态意图持久化（届时重开 §0#6 裁决）；
  - 评审 R6-F5 降级裁决：unmapped 非零 usage 维度仍结算已知桶（failed_unbilled=协议演进期全免单、pending_backfill 回填同样不识新维度，两条替代路径损失更大）；差额恢复路径 = `unmapped_usage_dimension` 告警 → 对账 `amount_mismatch` 浮现 → 白名单扩展 + 历史差额 `manual_adjustment` 补——协议演进（上游新增计费字段）发生时按此 runbook 处理；
  - reconcile 时间片参数（10min/片、50 页/片、12 片/轮）按 v1 量级设定，上量后按告警 `reconcile_slice_overflow` 频率调参；
  - 设计勘误表已扩至 **E1–E9**（PLAN.md），issues 不重复登记；
  - 评审 R17 残留：发布/切流的换镜像窗口内，冻结前已建在途支付会话的 webhook 可能在"新镜像 smoke 未过"数秒窗口结算一笔（结算路径不受 checkout 门控——否则 recharge smoke 无法通过）；由钱包不变量自检兜底可见 + 人工冲正，秒级窗口、pre-launch 低量可接受；上量后再评估把结算纳入可重试发布门控（须同时解决 R17 三衍生问题）；
  - 十七轮评审完整处置见 [review-log.md](../../plan/portal-newapi-routing-billing-decoupling/review-log.md)。
- [ ] **Step 5: Commit** `docs(deploy): 网关切流 runbook 与遗留清单`

---

## 批次三完成后（整体收口）

- [ ] 全量 `pnpm test` + `pnpm lint` + `pnpm build` 三绿。
- [ ] 按 PLAN.md"验收对照"逐条核对设计 §15 测试矩阵均有对应实现。
- [ ] 用 superpowers:finishing-a-development-branch 决定合并方式（本 worktree 分支 → PR to main）。
- [ ] 上线执行走 `docs/07-runbook.md` 新章节（阶段① 部署 → 门禁 → ①.5 → ② → ③），**代码合并 ≠ 切流**，切流由运营按 runbook 手动推进。
