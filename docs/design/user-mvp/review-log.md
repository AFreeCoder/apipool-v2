# 评审处理表 — user-mvp（APIPool 最小用户可用版本）

> 跨轮累积。每条 Codex finding 一行，记录分级与处理结论。与 `DESIGN.md` 同目录维护。
> 关联：`DESIGN.md`（设计文档）、`.codex/round-1.json`（本轮评审输出）、`.codex/confirmed-requirements.md`（已确认需求）。

## 第 1 轮（`codex exec`，ROUND=1）

- Codex verdict：**needs-revision**
- 总评：no-ship——设计里仍有 schema 方言决策未定、Key 分组 API 自相矛盾、支付展示数据源与金额单位不一致、核心 UI 验证不可重复。
- Orchestrator 复核：**5 条全部成立，无一拒绝**。F3=blocker（已拍板定稿），F1/F2/F4/F5=major。
- Author 处理结果：**F1/F2/F3/F5 采纳，F4 部分采纳**；并修正了 Reviewer 与 Orchestrator research 摘要中的 3 处现状事实错误（amountUsd 单位、init-rbac 幂等、getFeaturedModels/getQuickstartCurl 引用）。

| 编号 | 分级 | 类别 | 落点（文件/章节/接口/数据流/测试）| Codex 建议 | 处理 | 理由 / DESIGN.md 改动位置 |
|---|---|---|---|---|---|---|
| F1 | major | data-api-stateflow | 建 Key 分组输入在 public slug 与内部 groupId 之间断裂；`catalog_group.id`(PK) ↔ `getGroupsForKeyCreation()` 返回 slug ↔ `newApiKeyBinding.groupId` FK ↔ `POST /api/apipool/keys`；confirmed §4 禁暴露内部 ID | 用户输入字段改 `groupSlug`；`getGroupsForKeyCreation()` 返回 slug/name/desc；POST 只收 slug，服务端同流程解析到内部 id + newapiGroup，只把内部 id 写 binding.groupId；补测试：响应不含 id/newapiGroup，未知 slug/disabled/allowCreateKey=false 均拒绝 | **采纳** | 内部 UUID 不出服务端，杜绝 round-trip 暴露 id 或拿 slug 当 groupId 落 FK 致语义错配两条歧路。改：**D5**（新增「公共标识与内部 id 分离」段）、**D7**（函数签名改 groupSlug）、**§5.2**（queries 返回不含 id/newapiGroup）、**§5.4**（key-input/portal/route/组件/页面五行全改为 slug 输入、服务端解析）、**§6.1**（newApiKeyBinding.groupId 加「内部 id、不下发浏览器」注）、**§6.2**（建 Key 签名 `groupSlug`、响应不含 id/newapiGroup）、**§6.3**（建 Key 状态流改 slug→id 解析）、**§10.1 F9**（验收加「响应不暴露 id/newapiGroup」+ 三拒绝分支） |
| F2 | major | codebase-consistency | 充值记录无可用支付状态数据源（`toPublicLedgerEntry` 不返回 orderNo、不 join order）+ `amountUsd` 单位误标「美分」；锚点 DESIGN:138/550-556、portal.ts:162-170、billing/page.tsx:40-47、recharge.ts:51-52、recharge.test.ts:95-100 | 新增只读投影 `listBillingLedgerEntries(portalUserId)` 返回 ledger.orderNo + order.status/paymentProvider/paidAt + ledger.status + amountUsd，service 层 join order；修正文档 amountUsd 是美元数非美分 | **采纳**（并修正现状事实错误）| 已核对真实代码：`recharge.ts:51-53 toAmountUsd` 除以 100、`recharge.test.ts:99` 断言 500→`amountUsd===5`，故 amountUsd 是**美元数值整数**（5=$5）；`toPublicLedgerEntry`(portal.ts:162-173) 确无 orderNo。`order` 表(:203-229) 有 orderNo/status/paymentProvider/paidAt 可 join。改：**§3.2**（amountUsd 改注「美元数值整数」+ 补充值数据源现状）、**§5.8**（新增 `listBillingLedgerEntries` 行 + billing 页改用之、formatUsdAmount 不再 /100）、**§6.2**（充值记录投影块给出函数签名 + 映射）、**§10.1 F21**（验收加「amountUsd=5→$5.00 不被×100」+ ledger 无 orderNo 不报错分支）|
| F3 | blocker | compat-migration | D6 把硬性三方言约束留成 Q-A 未决，DB 方案未定稿；锚点 confirmed:51-52、DESIGN:259-265/289-292/730、schema.ts:1-5 | 编码前二选一并写入设计：A. catalog 表 sqlite-only + 类型/构建守护证明单源；B. 在 pg/mysql 文件补齐等价表 + 类型测试。不要把 Q-A 留到开发中 | **采纳**（Orchestrator 已拍板选 A：sqlite-only）| 遵循现有 bridge 表先例（本就只在 sqlite）+ 生产仅 SQLite，pg/mysql 不在 user-mvp 支持面。「三方言不漂移」= 类型从 sqlite barrel 单源推导。confirmed §6 已落定稿条款。改：**D6**（标题/状态改「已定稿 sqlite-only」，删「需评审确认」，补 3 项守护方案：禁 import pg/mysql catalog 表 + `catalog-schema-singlesource.test.ts` 断言 + migrator 一致）、**§0.4 Q6**（标已决）、**§5.1**（新增守护测试文件行）、**§9.2**（假设表标已定稿）、**§10.1 F1**（验收加单源守护）、**§11 Q-A**（标已决、不再上交）|
| F4 | major | testing | 核心 UI 流只规划人工走查，缺可重复断言；仓库仅 `tsx --test`（node:test）、无 Playwright；锚点 DESIGN:671-721、package.json:14-20 | UI 层验证改可执行：引入 Playwright 列 ≥3 e2e，或现有 node:test 下补页面/组件守护并明确哪些仍需手测；关键流不能只写人工走查 | **部分采纳** | 不强制引入 Playwright（基础设施决策、易超 mvp）。但「关键流仅人工走查」不可接受：改为每条用户可见验收至少一个可运行兜底——服务/投影单测 + 组件 props/渲染契约 node:test + 扩展现有 `scripts/smoke-mvp.ts` 端到端（已含建 Key→真实 /v1→用量闭环）；人工走查降为补充并列明确清单；Playwright 仅作条件项（如 OAuth popup）。改：**§10 原则行**（测试栈现状 + 三类可运行兜底 + 不强制 Playwright）、**§10.3**（UI 验证策略表 5 条关键流各列可运行兜底 + 明确人工走查清单 5 项 + 条件项）、**§10.1 F9/F11/F20/F21**（验收列改为指向 node:test/smoke 可运行断言）|
| F5 | major | data-api-stateflow | seed 并发安全声明不成立——`init-rbac.ts:358-376` 实为「先查后插」无 onConflict，并发会抛唯一冲突；catalog seed 是地基且 F1 要求可重入；锚点 DESIGN:291/635、init-rbac.ts:358-375 | 不复制 init-rbac 脆弱模式；每表按 slug `insert ... onConflictDoNothing/onConflictDoUpdate` 或冲突重查；多表 seed 放事务保证可重入；测试加并发用例 `Promise.all([initCatalog(), initCatalog()])` 行数稳定不抛错 | **采纳**（并修正现状事实错误）| 已核对：`init-rbac.ts:358-376` 确为 select-then-insert、无 onConflict，并发查空窗口竞态。新增 **D9**：`init-catalog` 用 `insert ... onConflictDoNothing` + 事务，幂等下沉 DB 唯一约束。务实定级：生产单实例 compose 串行 seed，多进程并发非主风险，但可重入是硬要求、onConflictDoNothing 成本极低同时覆盖。改：**§3.7**（init-rbac 加「并发脆弱」核对注）、**新增 D9**、**§5.1**（init-catalog 行改 onConflict + 事务）、**§6.1**（slug unique 理由改 onConflict）、**§7.2 step2**（seed 改 onConflict）、**§8.2**（并发/竞态段改 onConflict）、**§10.1 F1**（验收加并发用例 + 注明非主风险）|

### 本轮额外处理的现状事实更正（Author 主动，非 Codex finding）

| 项 | 第一版/research 摘要表述 | 真实代码 | 改动位置 |
|---|---|---|---|
| amountUsd 单位 | 「以美分」 | `recharge.ts:51-53` 除以 100、test 断言 500→5，是美元数值整数 | §3.2、§5.8、§6.2、§10.1 F21（同 F2）|
| init-rbac 幂等性 | 「onConflict 幂等」 | `:358-376` 先查后插、无 onConflict、并发脆弱 | §3.7、D9（同 F5）|
| 删硬编码兼容面 | `getFeaturedModels`/`getQuickstartCurl`「被首页/quickstart 引用」、「本次最大兼容风险点」 | repo-wide grep：二者在 src 下**无任何引用**；真实外部消费者仅 `models/page.tsx` + `key-input.ts` 两处 | §7.1（更正表述 + 列真实引用点）、§7.2（灰度迁移 3a–3d）、§11 Q-C |

### 额外处理的真实落地风险（评审 open_questions + 第一版未决项）

- **Codex open_questions**：① Q-A（sqlite-only vs 三方言）→ 由 **F3/D6** 覆盖（已决 sqlite-only）；② 公共 API 用户可见字段统一 `groupSlug`、内部 id 仅服务端 → 由 **F1/D5** 覆盖（已采纳）。两问均已在修订中落定，与 Orchestrator 基调一致。
- **删硬编码 publicModels 兼容路径（第一版 Q-C，真实风险）**：已从「纯未决」升级为 **§7.2 灰度迁移设计决策**（3a 并存→3b/3c 逐个迁移并测试通过→3d 再删），不再运行时直接删致空目录/报错。
- **第一版 Q-B / Q-D / Q-E**：第 2 轮冻结时保留为待用户拍板；**2026-06-24 用户已拍板落定**（Q-B 不留 Deals 区 / Q-D 不做连通性自检 / Q-E 无历史无分组 Key），已回填 DESIGN §11/§5.3/§6.1/§7.1/§7.2/§10.3/D5/F14。

## 第 2 轮（ROUND=2，验证修复 + 查回归）

- Codex verdict：**approve**（ship——第 1 轮 blocker/major 已实质修复，未发现阻止冻结的新 major/blocker 回归）
- 执行说明：第 2 轮首跑（后台 xhigh）进程中途夭折、无产出；按 skill「评审失败不得当通过、最多重试一次」**前台 + medium effort 重跑成功**（round-2.json 已生成并过 schema 校验）。
- Orchestrator 复核：5 条 prior findings 全部 resolved、findings 空、无未解决/无分歧。

### 上一轮 Blocker/Major 解决状态（对应 schema `prior_findings_status`）

| 编号 | status | evidence（Codex 判定依据，DESIGN.md 落点）|
|---|---|---|
| F1 | **resolved** | D5/§6.2/§6.3：浏览器与 POST 只用 `groupSlug`，`getGroupsForKeyCreation` 仅返回 slug/name/userDescription、不含内部 id/newapiGroup；§5.4 与 §10.1 F9 补未知 slug/disabled/allowCreateKey=false 三拒绝及「响应不暴露内部映射」测试 |
| F2 | **resolved** | §3.2 amountUsd 改正为美元数值整数并与真实 `order` 表字段对齐；§5.8/§6.2 新增 `listBillingLedgerEntries` 独立投影 join order（不改 `toPublicLedgerEntry`）；§10.1 F21「amountUsd=5→$5.00 不 ×100」 |
| F3 | **resolved** | D6/§0.4/§9.2/§11 Q-A 均标 sqlite-only 已定稿，confirmed §6 同步落定；§5.1/§10.1 F1 规划 `catalog-schema-singlesource.test.ts`（断言 pg/mysql 源码不含 `catalog_` + barrel 单源可解析 7 export）|
| F4 | **resolved** | §10 原则不再接受仅人工走查；§10.1 F9/F11/F13/F20/F21 + §10.3 为五条关键流各指定 node:test 服务/投影/组件契约断言并扩展 `smoke:mvp` 闭环；人工走查降为视觉补充 |
| F5 | **resolved** | D9/§5.1/§7.2/§8.2：`init-catalog` 用 `insert ... onConflictDoNothing` + 事务、不复制 init-rbac 先查后插；§6.1 给出 onConflict 依赖的各唯一约束；§10.1 F1 增连跑 + `Promise.all` 并发可重入断言 |

### 本轮仍未解决 / 新增（对应 `findings`）

| 编号 | 分级 | 落点 | 处理 / 理由 |
|---|---|---|---|
| —— | —— | —— | **无**：`findings=[]`，无未解决、无新引入回归 |

## 终止结论

**三档判定规则**：
- **GO** = 0 Blocker/Major 且无需开发中跟踪的条件项。
- **GO with conditions** = 0 Blocker/Major，但有需开发中跟踪的条件项或 Minor 债务。
- **NO-GO** = 任一未解决 Blocker/Major 或分歧 → 上交人类。
- 冻结语义：GO 与 GO with conditions 均**冻结并可进开发**；NO-GO **不冻结**。

- **本次结论**：**GO with conditions → 条件已清（2026-06-24）**。0 Blocker / 0 Major / 0 Minor 债务、findings 空；原 3 个待拍板取舍 Q-B/Q-D/Q-E 已由用户拍板落定并回填 DESIGN。**DESIGN.md 已冻结、可进入开发**；仅余 Q-C（`publicModels` 删除 vs 留作单测夹具）为开发中可定细节。
- **带入开发的 Minor / 条件项**：
  - （F4 条件项）若 OAuth popup 跨窗口回调等关键浏览器交互经评估 node:test + smoke 仍不足覆盖，可引入 Playwright 写单条 e2e，开发中跟踪。
  - （Q-C 细节）`publicModels` 删除 vs 永久保留作单测夹具，开发中定（倾向保留作夹具）。
- **设计取舍（原待用户拍板）→ 已全部落定（2026-06-24）**：
  - **Q-B → 不保留独立 Deals 视觉分区**：删 `channelTier`/`isDealModel`，折扣用分组 + `discountNote`/划线价表达。
  - **Q-D → 不做连通性自检**：门户分组是逻辑/展示名称、底层渠道分组在 New API 侧，门户只维护「逻辑名 → newapiGroup」映射、不校验连通性。
  - **Q-E → 场景不存在**：项目未上线、无历史无分组旧 Key，删除全部历史 Key 兼容论述。
- 评审轮数：2（第 1 轮 needs-revision「1 blocker + 4 major」→ Author 修订 → 第 2 轮 approve「F1–F5 全 resolved、无回归」）
- **冻结收尾（Orchestrator 执行，2026-06-24 完成）**：`DESIGN.md` 状态行已改为「已冻结 / 2026-06-24 / 经 2 轮评审」；本表归档。
