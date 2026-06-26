# 开发评审处理表 · user-mvp

> 跨 step / 跨轮累积。每个 step 一节，记录每轮评审 findings、处理结论、测试结果。
> 编排 skill：multi-agent-dev-iteration（Orchestrator=Claude / Author=Codex / Reviewer=独立 Claude）。

## 元信息
- feature: user-mvp
- 分支 / worktree: `dev/user-mvp` @ `/Users/afreecoder/project/user-mvp-dev`
- 主仓库: `/Users/afreecoder/project/APIPool_v2`（HEAD 起点 7cecf25）
- 输入: [DESIGN.md](../../design/user-mvp/DESIGN.md)（冻结）+ [PLAN.md](../../design/user-mvp/PLAN.md)（16 step）
- 终止阈值: 连续无净进展轮数 K=2，硬上限 M=5（按 step 分别计）
- 状态文件: `.author/step-<N>-prompt.md`（Codex prompt）、`.review/step-<N>-round-<R>.json`（评审输出）

## Step 进度总览

| Step | 标题 | 状态 | 轮次 | 结论 |
|---|---|---|---|---|
| 1 | catalog schema + 单源守护 | ✅ 完成 | 1 | GO（approve，0 blocker/major，3 minor 记债务）|
| 2 | init-catalog seed | ✅ 完成 | 1 | GO（approve，0 b/m，2 minor）|
| 3 | CATALOG 权限 | ✅ 完成 | 2 | GO（round2 approve，3 major 全 resolved，1 minor）|
| 4 | catalog-service 服务层 | ✅ 完成 | 1 | GO（approve，0 b/m，3 minor，1 open_question）|
| 5 | queries 查询层 + 边界守护 | ✅ 完成 | 1 | GO（approve，0 b/m，3 minor）|
| 6 | /models 四层筛选 | ✅ 完成 | 1 | GO（approve，0 b/m，2 minor）|
| 7 | 建 Key 服务层 | ✅ 完成 | 1 | GO（approve，0 b/m，2 minor）|
| 8 | 建 Key UI | ✅ 完成 | 1 | GO（approve，0 b/m，1 minor）|
| 9 | 后台 CRUD 字典三表 | ✅ 完成 | 1 | GO（approve，0 b/m，1 minor）|
| 10 | 后台 CRUD 分组 | ✅ 完成 | 1 | GO（approve，0 b/m，2 minor）|
| 11 | 后台 CRUD 模型+listings | ✅ 完成 | 1 | GO（approve，0 b/m，2 minor）|
| 12 | 接回登录设置页 | ✅ 完成 | 1 | GO（approve，0 b/m，2 minor）|
| 13 | 充值记录展示 | ✅ 完成 | 1 | GO（approve，0 b/m，2 minor）|
| 14 | 余额不足提示 | ✅ 完成 | 1 | GO（approve，0 b/m，2 minor）|
| 15 | 用户详情聚合视图 | ✅ 完成 | 1 | GO（approve，0 b/m，1 minor）|
| 16 | smoke 端到端闭环 | ✅ 完成 | 1 | GO（approve，0 b/m，1 minor；live 需外部环境）|

---

## Step 1: catalog schema 建表 + 单源守护

> DESIGN §5.1/§6.1/§D6/§5.4；覆盖 F1（建表）/F8（编译期边界）/F24（status 行为标志列）。
> STEP_BASE=7cecf25 → commit c4a446d。

### 轮次 1
- 主笔（Codex/workspace-write）：退出码 0；新增 7 张 catalog 表 + newApiKeyBinding.groupId(FK set null)/newapiGroup 列；迁移 0003_jazzy_namora.sql；单源守护测试。
- 看门狗核查：产物真实存在；pg/mysql 零 catalog_；独立复跑单源守护测试 3 pass、全量 121 pass；DESIGN 未改。**Codex 沙箱无法写 worktree gitdir → 未 commit，由 Orchestrator 代 commit（c4a446d）**。
- 测试结果：`tsx --test tests/db/catalog-schema-singlesource.test.ts` = 3 pass / 0 fail；全量 121 pass / 0 fail。
- findings（.review/step-1-round-1.json）：

  | id | severity | category | anchor | 处理 | 理由 |
  |----|----------|----------|--------|------|------|
  | R1-F1 | minor | test-quality | tests/db/catalog-schema-singlesource.test.ts:38-50 | 记债务 | 守护测试可补 isCallable/isPublicVisible/newapiGroup 列断言以闭合 F24 护栏（非必须）|
  | R1-F2 | minor | test-quality | tests/db/catalog-schema-singlesource.test.ts:43-47 | 记债务 | barrel 断言可用 getTableName 增强（可选）|
  | R1-F3 | minor | design-fidelity | src/config/db/schema.sqlite.ts:584 | 核对通过 | featured 列与 §6.1(DESIGN.md:481) 一致，评审者标注「无需处理」|

- schema 校验：jsonschema 完整校验通过。
- 收敛判定：`progress-check.py --k 2 --m 5` = **complete**。
- 本 step 结论：**GO**，进入 Step 2。

### 已知债务（minor，留人类检查点②决策）
- [Step1/R1-F1] 单源守护测试补 catalog_status.isCallable/isPublicVisible + newApiKeyBinding.newapiGroup 列断言（闭合 F24/§5.4 回归护栏，成本极低）。
- [Step1/R1-F2] barrel 导出断言改 getTableName 精确校验（可选增强）。

---

## Step 2: init-catalog 幂等 seed

> DESIGN §5.1/§D9/§3.7/§10.1 F1；覆盖 F1（seed）。STEP_BASE=c4a446d → commit 1aee307。

### 轮次 1
- 主笔（Codex）：退出码 0，**自行提交 1aee307**（本次沙箱可写 gitdir）。新建 scripts/init-catalog.ts（onConflictDoNothing+事务+依赖序）、tests/db/init-catalog.test.ts、package.json catalog:init。
- 看门狗核查 + 独立复跑：init-catalog 测试 3 pass（幂等/完整/并发），全量 124 pass；diff c4a446d..HEAD 仅含计划内 3 文件；DESIGN 未改。
- findings（.review/step-2-round-1.json）：

  | id | severity | category | anchor | 处理 | 理由 |
  |----|----------|----------|--------|------|------|
  | R1-F1 | minor | maintainability | scripts/init-catalog.ts | 记债务 | schema/tx 用 any 丢编译期列校验（非必须）|
  | R1-F2 | minor | test-quality | tests/db/init-catalog.test.ts | 记债务 | 并发用例 SQLITE_BUSY 退避，建议加注释防误读假绿（非必须）|

- 反模式核对（评审独立验证）：init-catalog 全程 onConflictDoNothing，**未照抄** init-rbac 先查后插；seed 后 select 取父行 id 建关联属 D9 允许。
- schema 校验通过；收敛判定 = **complete**。
- 本 step 结论：**GO**，进入 Step 3。

## Step 3: CATALOG 权限

> DESIGN §5.6/§0.2/§3.7；覆盖 F2-F6 权限前置。STEP_BASE=1aee307。

### 轮次 1
- 主笔（Codex）：写完产物后**在跑测试验证前被信号中断**（看门狗内部 codex 被自动后台化、看门狗误判结束 turn）。Orchestrator 亲自核查：产物完整落地，目标测试 2 pass、全量 126 pass，代 commit a217510。
- findings（.review/step-3-round-1.json）：

  | id | severity | category | anchor | 处理 | 理由 |
  |----|----------|----------|--------|------|------|
  | R1-F1 | major | scope | src/core/rbac/permission.ts | 采纳 | 越界：把 8+ guard 函数静态 import 改函数内动态 import，超「仅加常量」范围 |
  | R1-F2 | major | test-quality | permission.ts:1-9 | 采纳 | 评审实证证伪重构必要性（原静态 import 下 import PERMISSIONS 正常 + 已有 readFile 断言先例）|
  | R1-F3 | major | correctness | requireAdminAccess | 采纳 | 重构顺带改 auth guard 控制流（加 return），未验证的语义变更 |
  | R1-F4 | minor | maintainability | permission.ts | 采纳 | 随回退一并消除 |

- in-scope 部分（CATALOG 常量、init-rbac seed 授权、main 守卫、测试）评审确认正确。
- schema 校验通过；收敛判定 = **continue** → 进入轮次 2 修订。
- **流程改进**：改由 Orchestrator 直接 run_in_background 跑 codex（harness 退出时可靠重唤），替代易后台化误判的看门狗子 agent；独立验证环节保留。

### 轮次 2（修订，最终 commit 84cb90a）
- 主笔（Codex，run_in_background）：① 回退 permission.ts 越界重构（仅保留 +4 行常量、原静态 import）；② 回退后 Orchestrator 独立验证发现**测试在 react-server 条件下崩**（`import { PERMISSIONS }`→permission.ts 顶部 `@/core/i18n/navigation`→`React.createContext is not a function`）；③ 据此补全修订：测试改 readFile+regex 断言源码（跟随先例 `tests/api-console/admin-permission.test.ts`），permission.ts 保持纯净。
- 关键认知：评审 R1-F2「重构无必要」判断不准（探针未用 react-server 条件）；但 R1-F1/F3 成立。最终方案（permission.ts 不重构 + 测试 readFile）优于 round1 过度重构与朴素全回退——三方各暴露一部分真相。
- prior_findings_status：R1-F1/F2/F3/F4 **全部 resolved**（评审字节级核实回退 + 亲自复现 react-server 崩溃确认 readFile 方案正确）。
- 本轮 findings：R2-F1 minor（test-quality，断言位置宽松非假绿，记债务）。
- 测试：目标 2 pass、全量 126 pass。schema 校验通过；强制约束无矛盾；收敛判定 = **complete**。
- 本 step 结论：**GO**，进入 Step 4。

### Step 3 已知债务
- [Step3/R2-F1] catalog-permission.test.ts 的 super_admin/admin 断言可升级为结构化校验（import defaultRoles，需先验 react-server import 安全）。

## Step 4: catalog-service 服务层

> DESIGN §5.2/§6.2/§3.7；覆盖 F2-F6 服务层。STEP_BASE=84cb90a → commit 07f13e1。

### 轮次 1
- 主笔（Codex，run_in_background）：catalog-service.ts（307 行，31 函数 = 6 实体各 5 CRUD + getListingsByModel + create/update/deleteListing + setModelCapabilities 先删后插 + getGroupNewapiMapping）+ 真实库测试 240 行。
- 评审环境波折：① 首次 API 连接中断（subagent_tokens=0）② 重试遇 hook 注入致 subagent 空转（tool_uses=0）③ 加固防 hook 干扰指令后第三次成功。均为环境故障非评审逻辑，绝未静默当通过。
- 独立复跑：目标 5 pass、全量 131 pass；setModelCapabilities 先删后插正确。
- findings（.review/step-4-round-1.json）：

  | id | severity | category | anchor | 处理 | 理由 |
  |----|----------|----------|--------|------|------|
  | R1-F1 | minor | security | src/core/db/sqlite.ts:25 | 记 open_question | libsql 未 PRAGMA foreign_keys=ON，schema FK cascade/no-action 运行期不生效，删被引用实体静默孤儿化 |
  | R1-F2 | minor | correctness | catalog-service.ts:63 | 记债务 | update/delete 不区分行不存在（与 rbac.ts 范式一致）|
  | R1-F3 | minor | test-quality | catalog-service.test.ts:178 | 记债务 | 未覆盖各实体 update/delete（同构模板）+ getGroupNewapiMapping 不存在分支 |

- schema 校验通过；收敛判定 = **complete**。
- 本 step 结论：**GO**，进入 Step 5。

---

## Step 5: queries 查询层 + 边界守护

> DESIGN §5.2/§6.2/§8.1/§D7；覆盖 F7/F8/F9/F10 数据层。STEP_BASE=07f13e1 → commit e13ca85。

### 轮次 1
- 主笔（Codex）：queries.ts(276 行，'server-only'，4 Uncached + unstable_cache 包装 + revalidateCatalog)、types.ts(ListingRow 无 newapiGroup + FilterDimensions)；测试 415 行（真实库 + seed 故意写 newapiGroup='newapi-*-secret' 使泄漏断言有意义）。
- 独立复跑：目标 7 pass、全量 138 pass；getGroupsForKeyCreation 仅 select slug/name/userDescription。
- F8 三道防线评审确认：类型即边界（ListingRow 无 newapiGroup/id）+ select 不取敏感列 + 测试断言 JSON 无 /newapi/i。
- findings（.review/step-5-round-1.json）：R1-F1 minor(补 listInput/discountNote 断言)、R1-F2 minor(conditions any[] 类型,与 init-rbac 风格一致)、R1-F3 minor(补四层过滤空结果用例)——均记债务非必须。
- schema 校验通过；收敛判定 = **complete**。**GO** → Step 6。

---

## Step 6: /models 四层筛选

> DESIGN §5.3/§D7/§Q-B/§10.1 F7/F8/F24；覆盖 F7/F8/F24。STEP_BASE=e13ca85 → commit 3fea579。

### 轮次 1
- 主笔（Codex）：models/page.tsx 切 getPublicListings+getFilterDimensions、四层筛选(slug 驱动+All 清除)、micro-USD 价格、状态 isCallable 着色、删 Deals 区；catalog.ts parseModelFilters/buildModelFilterHref 改 4 维 + formatMicroUsdPerMillion；保留 publicModels(Step11 清理)；未加 group 黑名单(门户分组用户可见)。
- 独立复跑：models-filter 3 pass、全量 141 pass；models/page 无 publicModels import、无类型错。
- 评审独立核实：5 correctness 点全过、F8 grep 无 newapiGroup、纯链接 SSR 保持、scope 严格(publicModels 保留)、13 pass。
- findings（.review/step-6-round-1.json）：R1-F1 minor(划线价缺「>实价」守护,折扣语义)、R1-F2 minor(legacy filterModels vendor 短路,Step11 删)——记债务。
- 评审附带发现：init-catalog.ts 有 6 处 pre-existing tsc 错误（Step2 R1-F1 any 类型债务，非本 step）。
- schema 校验通过；收敛判定 = **complete**。**GO** → Step 7。

---

## Step 7: 建 Key 服务层（F1 边界）

> DESIGN §5.4/§6.2(F1)/§6.3/§8.1；覆盖 F9/F14/F19。STEP_BASE=3fea579 → commit dfe8546。

### 轮次 1
- 主笔（Codex）：key-input→{name,groupSlug}；client.createKey 增 group(L573)；portal.createPortalApiKey 用 getGroupBySlug 解析+校验 active/allowCreateKey→client.createKey({group:newapiGroup})→落 groupId=内部id+newapiGroup 快照，allowedModels=[]；catalog-service 加 getGroupBySlug；route 解构剔除内部字段。
- 独立复跑 + F1 四项核查全通：client 收 newapiGroup(:426)、binding.groupId=内部id(:413)、route 剔除(:47)、L573；目标 6 pass、全量 143 pass。
- 评审独立核实 F1：**真正防护点是 toPublicApiKey 9 字段白名单投影**（GET/list/POST 复用，统一安全）；create-portal-key 测试覆盖正常+3 拒绝分支。
- findings（.review/step-7-round-1.json，confidence 字段 Orchestrator 规整 high→0.9）：R1-F1 minor(route 解构冗余,建议守护集中到 toPublicApiKey)、R1-F2 minor(smoke-mvp 旧签名,Step16 改)。
- schema 校验通过；收敛判定 = **complete**。**GO** → Step 8。

---

## Step 8: 建 Key UI

> DESIGN §5.4/§6.2/§10.1 F9/F10/F14；覆盖 F9/F10/F14。STEP_BASE=dfe8546 → commit 92e1a56。

### 轮次 1
- 主笔（Codex）：api-key-manager 分组下拉(value=slug,必选)+可调模型范围+列表分组列；body 改 {name,groupSlug}(buildCreateKeyRequest 可测)；page 预取 groups+callableByGroup；portal.listPortalApiKeys left join 增 groupName，groupId/newapiGroup 仍排除（守护集中 toPublicApiKey 白名单，处理 Step7 R1-F1）。
- 独立复跑：目标 24 pass、全量 147 pass；**Orchestrator 运行时验证** listPortalApiKeys 输出含 groupName='Official' 不含 newapiGroup/其值/内部 id（return syncedRows.map(toPublicApiKey)）。
- 评审独立核实 F1/F14 边界 + 哨兵字符串无假绿。
- findings（.review/step-8-round-1.json）：R1-F1 minor(组件中英文案混排,记债务见下)。
- schema 校验通过；收敛判定 = **complete**。**GO** → Step 9。

---

## 📌 语言一致性方向（Step8 R1-F1 引出，后续 UI step 适用）
- **问题**：Codex 受中文 prompt 影响在 api-key-manager（基线全英文硬编码）新增中文文案 → 中英混排。
- **方向**：后续 admin 页（Step9-12/15）按 roles 范式用 **i18n（getTranslations + en/zh messages）**；dashboard 客户端组件（Step13/14）新文案用**英文**（与基线一致）。已在各 step prompt 强调。
- **债务 [Step8/R1-F1]**：api-key-manager 5 处中文文案待统一（英文化或随 dashboard i18n 接线）。

---

## Step 9: 后台 CRUD 字典三表

> DESIGN §5.5/§3.7/§6.1；覆盖 F2/F4 + F3 能力字典。STEP_BASE=92e1a56 → commit 82f1f94。

### 轮次 1
- 主笔（Codex）：vendors/capabilities/statuses 各 list+new+edit 共 9 页面（仿 roles：TableCard+New+FormCard+'use server' 调 catalog-service+revalidateCatalog）；statuses isCallable/isPublicVisible switch；全 i18n（getTranslations + en/zh catalog.json）；禁用用 status=disabled 不硬删。
- 独立复跑：目标 4 pass、全量 151 pass；i18n en/zh 键集各 81 一致；admin catalog 页**无中文字面**（i18n 范式修正生效）。
- 评审重点核查 switch→boolean 转换（FormCard String(value)→'true'/'false'，handler ===\'true\' 还原，正确，无 blocker）；CRUD 范式/权限/i18n/scope 全过。
- findings（.review/step-9-round-1.json）：R1-F1 minor(edit 页 slug 可编辑,改 seeded slug 会致下次 seed 重复插入,建议 disabled:true；内部 FK 用 id 故 FK 安全)。
- schema 校验通过；收敛判定 = **complete**。**GO** → Step 10。
- **范式约束（R1-F1 引出）**：Step10/11 新 edit 页的业务键（slug/modelId）一律 `disabled:true`（仿 roles name）；Step9 三页 slug disabled 记债务。

---

## Step 10: 后台 CRUD 分组

> DESIGN §5.5/§D5/§6.1/§10.1 F5/F24；覆盖 F5/F24。STEP_BASE=82f1f94 → commit 770d5ea。

### 轮次 1
- 主笔（Codex）：groups list+new+edit（仿 Step9）；字段 slug(edit disabled)/name/userDescription/newapiGroup(admin 可见)/allowCreateKey(switch)/sortOrder/status；status=disabled 下线(F24)；i18n。
- 独立复跑：目标 5 pass、全量 152 pass；i18n 键集 103 一致、groups 页无中文字面。
- 评审 grep 确认 **newapiGroup 无泄漏**（仅 admin 页+服务端，getGroupsForKeyCreation 仅 {slug,name,userDescription}，route 解构剔除）；switch 转布尔正确；slug disabled。
- findings（.review/step-10-round-1.json）：S10-001 minor(vendors/statuses edit 未锁 slug,与 group 不统一=Step9 R1-F1 再确认)、S10-002 minor(sortOrder Number() 可能 NaN,继承 Step9 范式,影响所有字典)。
- schema 校验通过；收敛判定 = **complete**。**GO** → Step 11。

### Step 9/10 累积债务（字典 CRUD，留人类检查点②或后续统一）
- [slug disabled] vendors/capabilities/statuses 三 edit 页 slug 加 disabled:true（groups 已做）。
- [sortOrder NaN] 所有字典 new/edit 的 sortOrder 用 Number.isFinite 兜底（Step11 models/listings 直接做对）。

---

## Step 11: 后台 CRUD 模型+listings（M5 闭环）

> DESIGN §5.5/§D4/§6.1/§10.1 F3/F6；覆盖 F3/F6。STEP_BASE=770d5ea → commit 6befcc7。

### 轮次 1
- 主笔（Codex）：models list+new+edit(modelId edit disabled,vendor 下拉)+能力打标页(仿 edit-permissions,setModelCapabilities)+listings 子表(group/status 下拉,价格,smokeTested switch,listing edit groupId disabled)；pricing.ts(dollarsToMicroUsd/microUsdToDollars,Math.round)；catalog-service +getModelCapabilities/getListingById；categories 改向；sidebar Model Catalog 组(en/zh)；publicModels 保留作夹具(零运行时引用,注释)。
- 独立复跑：目标+pricing 13 pass、全量 160 pass；i18n catalog 168/sidebar 23 键集一致、无中文字面。
- 评审（verdict 字段 Orchestrator 规整 pass→approve）独立实测：价格 Math.round 无浮点误差(0.07/0.29)、能力打标先删后插有真实 DB 单测、**listing edit groupId disabled+handler 强制原 groupId（F6 唯一键关键防线）**、32 目标测试 pass。
- findings（.review/step-11-round-1.json）：S11-001 minor(重复 listing 报错为原始 DB 文案非 i18n 友好)、S11-002 minor(featured 字段无 UI,§6.1 有列但未暴露编辑)。
- schema 校验通过；收敛判定 = **complete**。**GO** → Step 12。**M5 模型目录体系（公共侧+后台侧）完整闭环。**

---

## Step 12: 接回登录设置页

> DESIGN §5.7/§D8/§3.5/§10.1 F20；覆盖 F20，为 F16/F17/F18 铺路。STEP_BASE=6befcc7 → commit 7b03d94。

### 轮次 1
- 主笔（Codex）：settings/[tab]/page.tsx 删 redirect→requirePermission(SETTINGS_READ)+getSettingTabs+getSettings 过滤 tab→Setting 映射 FormCard→'use server' saveConfigs；空值跳过(collectNonEmptyConfigs,F20)；password 强制 value=''(不回显明文)；sidebar Settings 入口；复用 settings.ts/config.ts 零核心重写。
- 独立复跑：目标 5 pass、全量 165 pass；redirect 桩已删、未改核心。
- 评审实证：password 明文不进渲染链(value='')、F20 空值剔除有纯函数+单测。
- findings（.review/step-12-round-1.json）：S12-1 minor(security,'use server' handler 未二次鉴权——见全局 OQ-2)、S12-2 minor(未知 Setting.type 静默降级 text,前瞻)。
- schema 校验通过；收敛判定 = **complete**。**GO** → Step 13。

---

## Step 13: 充值记录展示

> DESIGN §5.8/§6.2/§3.2 F2/§10.1 F21；覆盖 F21/A7。STEP_BASE=7b03d94 → commit 9eead74。

### 轮次 1
- 主笔（Codex）：portal.listBillingLedgerEntries(left join order,返回 orderNo/amountUsd/ledgerStatus/orderStatus/paymentProvider/paidAt/createdAt,不改 toPublicLedgerEntry)；billing 4 列→订单时间/金额/支付状态/到账状态(含 Processing)；amountUsd 直接 formatUsdAmount(不×100,F2)；无 orderNo 显—；英文文案。
- 独立复跑：目标 4 pass、全量 169 pass；F2 单位无 ×/÷100、无中文字面。
- 评审重点核查 F2（测试断言 amountUsd=5→$5 非 $500）+ left join 无 orderNo 不崩 + toPublicLedgerEntry 未改 + 映射全分支。
- findings（.review/step-13-round-1.json）：S13-F1 minor(投影 paymentProvider/paidAt 预留未渲染,§6.2 要求保留)、S13-F2 minor(订单时间取 ledger.createdAt,符合 §6.2 字面)。
- schema 校验通过；收敛判定 = **complete**。**GO** → Step 14。

---

## Step 14: 余额不足提示

> DESIGN §5.8/§10.1 F13；覆盖 F13。STEP_BASE=9eead74 → commit 897b4e2。

### 轮次 1
- 主笔（Codex）：balance-warning.tsx(isLowBalance,null/undefined→false 不误报 + BalanceWarning 组件 + Add credit→/dashboard/billing)；dashboard 概览接入；英文文案。
- 独立复跑：目标 4 pass、全量 173 pass；无中文字面。
- 评审端到端追 getPortalUsage 确认上游失败无缓存时 balanceUsd=undefined→不误报（F13 失效路径成立）；边界/契约全过。
- findings（.review/step-14-round-1.json）：S14-01 minor(文案硬编码英文未落 billing.json,与 dashboard 基线一致)、S14-02 minor(充值入口用 `<a>` 非 i18n Link,locale 前缀靠中间件兜底)。
- schema 校验通过；收敛判定 = **complete**。**GO** → Step 15。

---

## Step 15: 用户详情聚合视图

> DESIGN §5.9/§6.2/§10.1 F22/F23；覆盖 F22/F23/A8/A9。STEP_BASE=897b4e2 → commit 580ba2b。

### 轮次 1
- 主笔（Codex）：admin/users/[id]/detail 只读聚合(USERS_READ + getPortalUsage + listKeysByPortalUser + listAdjustmentLedgerByPortalUser 四区块)；portal 新增 listKeysByPortalUser(只读本地,不含 groupId/newapiGroup) + listAdjustmentLedgerByPortalUser(source=manual_adjustment + operator join)；users 加详情入口；无 binding 降级；调额仍走 adjust-quota 不新增写接口；i18n。
- 独立复跑：目标 4 pass、全量 177 pass；F1 边界保持、无中文字面。
- 评审：approve，1 minor S15-001(getPortalUsage 触发被查用户自身用量远端同步副作用,但属 §5.9/§6.2 指定数据源、不越 F1 边界,「只读」措辞 vs 行为出入,非必须)。
- schema 校验通过；收敛判定 = **complete**。**GO** → Step 16。

---

## Step 16: smoke 端到端闭环

> DESIGN §10.1 F11/F12/F15/§9.1/§11；覆盖 F11/F12/F15（端到端 live 需外部环境）。STEP_BASE=580ba2b → commit 350e56a。

### 轮次 1
- 主笔（Codex）：smoke-mvp.ts 建 Key 改 groupSlug='official'(适配 Step7,移除 allowedModels)+live 对齐注释；其他闭环逻辑不变。
- 独立复跑：`npm run smoke:mvp` → **SKIPPED**(缺 live env 优雅跳过,退出码 0,脚本就绪)；全量 177 pass；smoke-mvp 无新类型错误。
- 评审：approve，1 minor S16-1(newapiGroup='' 对齐语义隐式,可选注释)。评审再次拒绝注入。
- 收敛判定 = **complete**。**GO**。
- **外部依赖**：端到端 live（建 Key→真实 /v1 调用→用量→禁用 401）需真实 New API 烟测环境（127.0.0.1:3001 本地不可达），留人类检查点②由用户在真实环境跑 `APIPOOL_SMOKE_REQUIRE_LIVE=true npm run smoke:mvp`（须先对齐 official 分组 newapiGroup→真实 group，§9.1 手动对齐）。

## ✅ F11/F12/F15 本地 live 验证（2026-06-26，合并后）

在本地搭建真实 New API(docker compose 恢复 data/new-api)+mock upstream(3002)环境，**端到端验证通过**：
- **F11**：建 Key 选分组(official)→真实 key(sk-)→真实 `/v1` 调用 **HTTP 200**（经 official.newapiGroup=''→New API default group→渠道→mock pong）；响应 groupName=Official、**无 newapiGroup**（F1 边界 live 确认）。
- **F12**：调用后 getPortalUsage 用量可见（requests/logs>0, status=ready）。
- **F15**：disablePortalApiKey 后同 key 调 `/v1` **HTTP 401(Invalid token)**。
- **环境踩坑（与 user-mvp 代码无关，均 New API 侧）**：① data/new-api 恢复后 admin token 失效（access token 重新生成语义）→ newapi-token.sh 重取；② 渠道原指 apipool.dev 真实上游(502 不可用)→改指 mock upstream；③ 调额(F22 兑换码模式)被 New API rc.10 **合规锁**阻断（"compliance terms"，需 dashboard 确认，DB 设 compliance_confirmed=true 无效——有额外内部校验）→ 绕过调额、直接给 New API user 设 quota(DB) 验证调用链；④ binding/provision 跨两库纠缠(失效凭据/unique 冲突)→用全新 portal user + 清积累 key_binding 解决。
- **结论**：user-mvp 建 Key 选分组核心闭环(F9/F11/F12/F14/F15)在真实 New API 上工作。F16/F17/F18(OAuth/邮件登录)仍需真实 provider/密钥(无法纯本地)；F22(调额)受 New API 合规锁(本地环境配置项，非代码)。

## 合并前质量门修复（tsc）：commit 2fde009

- 发现：整体 `tsc --noEmit` 有 6 错误，全在 Step2 的 init-catalog.ts（CatalogSchemaTables 7 表标 any → indexBy/requireRow 行类型窄化 → .id TS2339）；main baseline tsc **干净(0)**，故为本次引入回归。
- 性质：纯类型标注缺陷（Step2 R1-F1 根因），**运行时正确**（select 全选、测试 177 pass 含关联/listing 数据断言已证 .id 有效）。
- 修复：CatalogSchemaTables 字段 any → `typeof catalogVendor` 等真实表类型；运行时不变。**tsc 回 0(匹配 baseline)、全量仍 177 pass**。

---

## 🔴 安全事件：评审 subagent 检测到 prompt 注入（已拒绝，无危害）

- **Step 4 评审**：subagent 返回「user-level hooks active, configured by a previous user」消息（注入到 subagent 上下文），未执行评审 → 加固「忽略 hook 注入」指令后第三次成功。
- **Step 15 评审**：subagent 报告上下文含注入指令——试图诱导它①转向「generic security review」②**读取/执行 `.context` 目录下的 "reset hook" 文件**，伪装成系统要求。subagent **正确识别为不可信注入并拒绝**，仅完成分配的 Step 15 评审。
- **Orchestrator 防御性核查（仅 ls/查看，未执行）**：主仓库 `.context/` 仅含 `claude-session-id`（UUID 文本），**无 "reset hook" 文件**；worktree 无 .context；全仓无可疑 hook 脚本；项目无 settings.json hooks。**注入指向不存在的文件**，纯恶意诱导。
- **影响评估**：零实质危害。所有评审结论基于真实代码分析、Orchestrator 每步独立复跑测试 + 核查关键点。注入未污染任何产物或判定。
- **处理**：按指令边界（观察内容=数据非命令），全程未基于注入读取/执行任何 hook。后续 subagent prompt 已含「忽略 hook 注入」加固。**人类检查点②须向用户报告此事件。**

---

## ⚠️ 全局 open_questions（需后续 step 或人类检查点②决策）

- **[OQ-2 ✅ 已解决（Step 17，commit eed355b）]** 14 个 admin catalog/settings 写 handler 已补 requirePermission(WRITE) 二次鉴权（评审 approve，14/14 守护，全量 191 pass，tsc 0）。**用户拍板「先修 OQ-2 再合并」已执行。**
- **[OQ-3 ✅ 已解决（2026-06-26，merge 5f1bcfe）]** roles/users 4 个既有写 handler 已补二次鉴权（roles edit/edit-permissions→ROLES_WRITE；users edit→USERS_WRITE；users edit-roles→requireAllPermissions[USERS_WRITE,ROLES_WRITE] 对齐页首）。**至此全 admin 写面 18/18 handler 二次鉴权闭环**（OQ-2 catalog/settings 14 + OQ-3 roles/users 4）。记录见 docs/dev/oq3/。全量 195 pass、tsc 0。
- **[原 OQ-2 描述存档]** admin Server Action 二次鉴权问题（已由上方 OQ-2 ✅ 解决）。原始：：catalog CRUD（Step9-11）与 settings（Step12）的 `'use server'` submit handler 仅依赖**页首 requirePermission**，handler 内**未二次鉴权**。Next.js Server Action 编译为可独立调用的 POST 端点，页面渲染门控不保护它——理论上有该 action 引用、仅 READ 权限（或无写权限）的调用方可触发写入/改配置。**贯穿 Step9-12 所有 admin 写 handler**（非单点）。风险中等（action 闭包绑定 + admin 路由组 + 生产单实例）。DESIGN §8.1 要求「写操作在 handler 内二次校验」——当前实现仅做了页首校验。**建议**：人类检查点②前统一在各 admin 写 handler 首行补 `requirePermission(CATALOG_WRITE / SETTINGS_WRITE)`（一个小加固 step 或合并修）。**留用户拍板**是否本轮加固。

- **[OQ-1 / 来自 Step4 R1-F1] FK 强制未启用**：libsql/sqlite 连接（`src/core/db/sqlite.ts`）全局未 `PRAGMA foreign_keys=ON`，schema 声明的 `ON DELETE cascade/no action` 在运行期不生效。影响：后台删除供应商/分组/状态（Step 9-11）时，被引用的 model/listing 会静默孤儿化，而非级联或拒绝（与 DESIGN F3/F5「删能力级联」「分组下线」预期不一致）。**处理方案二选一**：① Step 9-11 删除入口做 app 层引用检查（先查引用再拒绝/级联，安全、不动全局）；② 基建层统一开 FK pragma（一处解决，但影响现有 bridge 表删除行为、有回归风险）。**倾向 ①**（在 Step 9-11 实现删除 UI 时落地），②留人类检查点②决策。

---

## 终止结论（全部 step 后）

- **整体：GO**（全 16 step approve/complete；分支 dev/user-mvp，17 commits = 16 step + 1 tsc 质量门修复）。
- **收敛**：15 个 step 首轮 approve；仅 Step 3（CATALOG 权限）经 2 轮（round1 揪出 permission.ts 越界重构 3 major → round2 修复 approve）。无任何 step 触发 escalate（无连续无进展、无硬上限、无持续分歧）。
- **测试**：全量 `tsx --test tests/**/*.test.ts` = **177 pass / 0 fail**（main baseline 121 → +56 新测试）；`tsc --noEmit` = **0 错误**（与 main baseline 一致）；`npm run smoke:mvp` 脚本就绪（无 env 优雅 SKIPPED）。
- **整体改动**：`git diff main..dev/user-mvp` = 75 文件，+12193 / -315。
- **DESIGN 覆盖（F1-F24 全 24 功能点 / 18 验收 U1-U9·A1-A9）**：
  - F1 schema+seed(S1/S2) · F2 供应商 CRUD(S4/S9) · F3 能力 CRUD+打标(S4/S9/S11) · F4 状态字典(S4/S9) · F5 分组+newapiGroup(S4/S10) · F6 同 modelId 跨分组(S4/S11) · F7 /models 四层筛选(S5/S6) · F8 公共页不暴露后台痕迹(S5/S6) · F9 建 Key 选分组(S7/S8) · F10 可调模型范围(S5/S8) · F11 复制 Key 真实调用(S16，**live 待外部环境**) · F12 调用后余额用量(S16/现有) · F13 余额不足提示(S14) · F14 Key 列表分组列(S8) · F15 禁用 Key 不能调用(S16，**live 待外部环境**) · F16 Google(S12，待填密钥) · F17 GitHub(S12，待填密钥) · F18 邮箱验证(S12，待填密钥) · F19 建 Key 不被邮箱验证阻止(S7) · F20 接回设置页(S12) · F21 充值到账状态(S13) · F22 管理员调额(S15) · F23 用户详情聚合(S15) · F24 下线模型/分组状态(S6/S10/S11)。
  - **本地可断言项全部覆盖**；3 类需外部依赖项已标注：F11/F15（真实 New API 烟测环境）、F16/F17/F18（管理员填 OAuth/Resend 真实密钥 + 回调域名配置）。

### 待人类决策项（人类检查点②）
1. **是否合回主干**（`git merge --no-ff dev/user-mvp`，仅人类确认后）。
2. **🔴 安全事件**：评审 subagent 两次检测到 prompt 注入（详见上「安全事件」节），已拒绝、无危害，须知悉。
3. **OQ-1（FK 强制未启用）** + **OQ-2（admin Server Action 二次鉴权，安全）**：见 open_questions 节，建议合并前或紧接其后处理 OQ-2。
4. **外部依赖验证**：F11/F15 跑 live smoke、F16/F17/F18 填密钥后人工验登录（需用户环境/密钥）。
5. **已知 minor 债务**（不阻塞，散见各 step）：字典 edit slug disabled（S9）、sortOrder NaN 兜底（S10）、api-key-manager 中英混排（S8）、划线价 >实价 守护（S6）、重复 listing/listing 友好报错（S11）等——可批量清理或按需。
6. **PLAN.md/dev-log 等流程产物**（主仓库 docs/，当前未提交）是否随合并一并纳入。
