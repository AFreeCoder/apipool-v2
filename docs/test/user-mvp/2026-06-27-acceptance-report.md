# User MVP 测试与验收报告

> 日期：2026-06-27
> 范围：`main`，`codex/user-mvp-dev` 已合入 `main` 后的本地验收
> 输入材料：`docs/08-user-mvp-requirements.md`、`docs/design/user-mvp/DESIGN.md`、`docs/design/user-mvp/PLAN.md`
> 执行方式：`gstack:review`、`gstack:qa-only`、`gstack:browse`、`gstack:design-review`、`superpowers:verification-before-completion`、`superpowers:dispatching-parallel-agents`、`superpowers:systematic-debugging`
> 约束：本轮只做测试、审查、复核与根因定位；未执行 `gstack:ship`、`land-and-deploy`、`canary`，也未修复代码。

## 一、测试范围

### 已覆盖模块、页面、接口和用户路径

- 模型广场：`/models` 桌面与移动端渲染、筛选维度、公开目录字段边界、disabled 目录维度过滤风险。
- 登录与权限：未登录访问 `/dashboard` 跳转登录；普通用户访问 `/admin` 被拦截到无权限页。
- 用户控制台：`/dashboard` 余额、API Base URL、最近用量、空状态、加载/错误状态基线。
- API Key 管理：`/dashboard/api-keys` 创建、重复名称拦截、完整 Key 只展示一次、失败态/清理状态的代码路径复核、无 callable 模型分组创建风险。
- 账单：`/dashboard/billing` 空状态、账本 DTO 暴露范围、英文状态文案 i18n 风险。
- 用量：`/dashboard/usage` 空状态、recent requests 展示、重复 usage id 回归覆盖。
- 管理后台：`/admin` RBAC 保护、目录管理实现边界、用户/账本/调额路径静态审查。
- 额度调整：后台人工增减额度、账本流水、重复提交幂等风险。
- 集成点：New API bridge、SQLite/libSQL schema、Better Auth 权限边界、支付账本、webhook 幂等、目录缓存、失败恢复路径。
- 浏览器 QA：桌面与移动视口真实浏览器走查，并保留截图证据。
- 自动化验证：lint、TypeScript、unit tests、integration-like tests、MVP smoke、production build。

### 截图证据

截图保存在：

- `../../../.gstack/qa-reports/user-mvp/screenshots/models-desktop.png`
- `../../../.gstack/qa-reports/user-mvp/screenshots/models-mobile.png`
- `../../../.gstack/qa-reports/user-mvp/screenshots/dashboard-auth-desktop.png`
- `../../../.gstack/qa-reports/user-mvp/screenshots/api-keys-auth-desktop.png`
- `../../../.gstack/qa-reports/user-mvp/screenshots/billing-auth-desktop.png`
- `../../../.gstack/qa-reports/user-mvp/screenshots/usage-auth-desktop.png`
- `../../../.gstack/qa-reports/user-mvp/screenshots/admin-ordinary-user.png`

### 未覆盖内容与原因

- OAuth Google/GitHub live 登录：本地验收未配置真实 OAuth provider 凭据。
- Resend 真实邮件投递：本地验收未配置真实 Resend 凭据与可投递域名。
- 真实支付 provider 与 webhook 回调：本地验收未接入线上支付 sandbox/live 回调链路。
- New API 真实模型调用：`npm run smoke:mvp` 因缺少 live user id 环境变量跳过，没有证明真实 gateway 调用成功。
- 线上缓存/CDN/任务队列：本轮只验证本地 Next.js、DB 和服务层路径，没有进入发布后 canary。
- CSRF/Origin 安全专项：子 agent 标记为需单独深测，本轮未做完整攻击面测试。

## 二、测试矩阵

| 需求点 | 测试类型 | 测试方法 | 预期结果 | 实际结果 | 通过/失败 |
| --- | --- | --- | --- | --- | --- |
| `/models` 展示可售模型、分组、价格、状态 | 功能/UI/浏览器 | 桌面与移动真实浏览器访问 `/models`，检查布局、空/有数据状态、公开字段 | 页面可读、响应式正常，不泄露内部 ID 或 `newapiGroup` | 页面渲染正常，未见内部字段；但代码复核发现 disabled group/vendor/category/capability 下的 listing 仍可能公开展示 | 部分通过 |
| `/models` 只展示公开可见且维度有效的数据 | 集成/边界 | 临时 SQLite 禁用 `official` group 后调用 public listing 查询 | 禁用分组下 listing 不应出现在 public 查询 | 仍返回 disabled group listing | 失败 |
| 登录后进入 `/dashboard`，未登录跳登录 | 用户路径/鉴权 | 未登录访问 `/dashboard`，登录态访问控制台 | 未登录跳 `/sign-in?callbackUrl=/dashboard`；登录后展示控制台 | 行为符合预期 | 通过 |
| 普通用户不能访问 `/admin` | 鉴权/UI | 普通用户访问 `/admin`，截图留证 | 普通用户被 RBAC 拦截，不出现后台功能 | 跳转/展示 `/no-permission`，符合预期 | 通过 |
| API Key 按 `groupSlug` 创建且不暴露内部字段 | 功能/集成/浏览器 | 登录后创建 Key，检查 payload、服务端映射、UI 展示 | 只提交 `groupSlug`，成功后完整 Key 只展示一次 | 普通创建路径通过；未见 `newapiGroup` 暴露 | 通过 |
| API Key 重复名称拦截 | 功能/浏览器/回归 | 用相同名称重复创建 Key | 用户看到安全错误，不展示新的完整 Key | 单用户单击路径正确拦截 | 通过 |
| API Key 同名并发创建 | 并发/边界 | 代码审查 schema 与创建流程 | 并发下也不能产生重复未删除名称 | 先查后写，无唯一约束，存在竞态 | 失败 |
| API Key 可选分组应有 callable 模型 | 功能/产品边界/浏览器 | `/dashboard/api-keys` 查看默认分组选项并创建 | 无 callable listing 的分组不应可创建，或应禁用并解释 | 本地“反代”分组显示 No callable models 但仍可创建 Active key | 失败 |
| Key 失败态可诊断、可清理 | 功能/回归 | 复核状态机、已有测试和 UI 路径 | failed/retriable/binding failed 可清理且不混入 active 列表 | 主要状态和清理路径已有覆盖；本地 binding update 错误脱敏仍有缺口 | 部分通过 |
| `/dashboard/billing` 展示充值/到账状态 | UI/集成 | 访问账单页空状态，复核 billing route DTO | 支付状态与到账状态清晰，不暴露内部字段 | 空状态正常；API 返回 ledger 宽 DTO，英文到账状态硬编码中文 | 部分通过 |
| 支付 webhook 重复回调幂等 | 集成/回归 | 复核账本设计、已有测试覆盖 | 重复回调不重复入账 | 自动化覆盖不足，本轮未做 live webhook 验证 | 部分通过 |
| 管理员人工调额 | 功能/集成/代码审查 | 复核调额表单和 server ledger 写入 | 重复提交不会重复加款/扣款，审计完整 | 缺少前端 early return 和服务端 idempotency key，重复提交可重复入账 | 失败 |
| `/dashboard/usage` 展示用量与空/失败状态 | UI/回归 | 浏览器访问空状态，复核 usage snapshot/log tests | 无数据、同步中、失败、stale 状态可理解，避免重复记录 | 空状态正常；重复 key 回归已有覆盖 | 通过 |
| 管理后台目录 CRUD | 功能/代码审查 | 复核 `/admin/catalog/*`、schema、locale 注册、测试 | 供应商/分组/分类/能力/状态/模型/售卖项可维护 | 结构完整；本轮未做每个 admin 表单的写入式浏览器操作 | 部分通过 |
| 登录邮件配置 | 功能/代码审查 | 复核 `/admin/settings/auth|email` 与相关测试 | OAuth/Resend 可配置，secret 不暴露，邮箱验证不阻塞 Key | 代码路径符合边界；未做真实邮件发送 | 部分通过 |
| 发布前基础验证 | 自动化 | `npm run lint`、`npx tsc --noEmit`、`npm test`、`npm run smoke:mvp`、`npm run build` | 所有命令成功，smoke 覆盖真实或等价 live 闭环 | lint/typecheck/tests/build 通过；`smoke:mvp` 退出 0 但跳过 live | 部分通过 |

## 三、问题清单

### 1. High：后台调额重复提交缺服务端幂等，可能重复加款或扣款

- 严重级别：High
- 复现步骤：
  1. 管理员进入后台调额表单。
  2. 对同一用户输入金额和原因。
  3. 在网络慢、浏览器重复提交、脚本重放或用户双击的情况下发起两次提交。
- 预期结果：同一次业务意图只生成一条有效账本流水；重复请求返回已有结果或被幂等拒绝。
- 实际结果：前端只设置 loading，没有明确 early return；服务端每次使用新的 `uuid` 生成 `portal-adjustment:${user}:${uuid}`，账本表也没有业务幂等键。
- 截图或日志证据：
  - `src/features/api-console/components/admin/quota-adjustment-form.tsx:47`
  - `src/features/newapi-bridge/server/portal.ts:1331`
  - `src/config/db/schema.sqlite.ts:729`
- 影响范围：管理员人工充值、扣减额度、异常补偿；直接影响用户余额和财务账本可信度。
- 初步根因：调额业务没有从 UI 到服务端到数据库建立同一业务请求的 idempotency key 和唯一约束。
- 建议修复方式：为调额请求生成稳定 idempotency key；账本层增加唯一约束；服务端在事务内检查并复用已有结果；补并发和重复提交回归测试。

### 2. High：`smoke:mvp` 发布门禁可能假阳性

- 严重级别：High
- 复现步骤：
  1. 运行 `npm run smoke:mvp`。
  2. 不设置 `APIPOOL_SMOKE_PORTAL_USER_ID` 和 `APIPOOL_SMOKE_OPERATOR_USER_ID`。
  3. 观察命令退出状态。
- 预期结果：发布前 smoke 应验证真实 DB-backed catalog、Key、New API 调用和用量/账本闭环；缺少 live 变量时应作为发布门禁失败或明确不能作为发布通过依据。
- 实际结果：命令退出 0，但输出 `SKIPPED: live MVP smoke requires APIPOOL_SMOKE_PORTAL_USER_ID, APIPOOL_SMOKE_OPERATOR_USER_ID...`；且脚本读取静态 `publicModels` fixture，不验证真实 DB catalog。
- 截图或日志证据：
  - `scripts/smoke-mvp.ts:3`
  - `src/features/api-catalog/lib/catalog.ts:132`
  - 命令输出：`SKIPPED: live MVP smoke requires APIPOOL_SMOKE_PORTAL_USER_ID, APIPOOL_SMOKE_OPERATOR_USER_ID`
- 影响范围：发布前可能误判 user-mvp 已完成真实可用闭环。
- 初步根因：smoke 脚本仍停留在 fixture/可选 live 模式，没有和当前 DB-backed catalog、New API bridge 绑定。
- 建议修复方式：将 smoke 改为从 DB 查询 public/callable/smokeTested listing，并使用真实或等价 New API 测试用户完成 Key 创建、调用、用量同步；发布模式下缺 live env 必须失败。

### 3. Medium：`/models` 可展示 disabled group/vendor/category/capability 下的 listing

- 严重级别：Medium
- 复现步骤：
  1. 初始化本地 catalog seed。
  2. 将 `official` group 设置为 `disabled`。
  3. 调用 `getPublicListingsUncached({ group: 'official' })`。
- 预期结果：disabled group 下的 listing 不应出现在公共模型广场。
- 实际结果：查询仍返回 disabled group 的 public listing。
- 截图或日志证据：
  - 复核结果：`disabledGroupPublicListingCount: 1`
  - 示例返回：`modelId: 'gpt-4o-mini'`，`groupSlug: 'official'`，`statusName: 'Available'`
  - `src/features/api-catalog/server/queries.ts:81`
- 影响范围：普通用户可能看到运营已禁用的分组、供应商、分类或能力，造成价格和可用性误导。
- 初步根因：public 查询只过滤 `catalogStatus.isPublicVisible`，没有同时要求 vendor/group/category/capability active。
- 建议修复方式：public/callable 查询统一加入 active 维度过滤；为 disabled vendor/group/category/capability 增加回归测试。

### 4. Medium：API Key 页可为无 callable 模型的分组创建 Key

- 严重级别：Medium
- 复现步骤：
  1. 登录本地普通 QA 用户。
  2. 打开 `/dashboard/api-keys`。
  3. 选择默认显示的“反代”分组，该分组显示 `No callable models`。
  4. 创建 API Key。
- 预期结果：无 callable listing 的分组应隐藏、禁用或给出明确不可创建提示。
- 实际结果：仍可成功创建 Active key。
- 截图或日志证据：
  - `../../../.gstack/qa-reports/user-mvp/screenshots/api-keys-auth-desktop.png`
  - `getGroupsForKeyCreation` 只看 active 和 `allowCreateKey`，未和 callable listings 对齐。
- 影响范围：用户可能创建出看似可用但无法解释可调用范围的 Key；英文界面还可能出现中文运营分组名。
- 初步根因：Key 创建分组筛选条件与模型目录 callable 条件不一致。
- 建议修复方式：`getGroupsForKeyCreation` 与 callable listing 查询对齐；无 callable 模型时禁用创建并展示运营可理解的说明。

### 5. Medium：`/api/apipool/billing` 返回 ledger 宽 DTO

- 严重级别：Medium
- 复现步骤：
  1. 登录用户访问 `/api/apipool/billing`。
  2. 检查返回字段。
- 预期结果：用户侧 billing API 只返回账单页需要的窄字段，不暴露内部流水、回滚状态或不必要的更新时间。
- 实际结果：返回 `id`、`amountUsd`、`source`、`status`、`reason`、`rollbackStatus`、`createdAt`、`updatedAt` 等 ledger 宽字段。
- 截图或日志证据：
  - `src/app/api/apipool/billing/route.ts:19`
  - `src/features/newapi-bridge/server/portal.ts:190`
  - 服务函数返回 keys：`id, amountUsd, source, status, reason, rollbackStatus, createdAt, updatedAt`
- 影响范围：用户 API 面可能泄露内部账本语义，后续前端也容易绑定不该承诺的字段。
- 初步根因：route 直接使用 ledger service 的 public-ish 投影，没有为账单页定义专用窄 DTO。
- 建议修复方式：改用 `listBillingLedgerEntries` 或新增用户账单 DTO；明确字段白名单并补 API shape 测试。

### 6. Medium：API Key 同名校验非原子，并发下可能重复

- 严重级别：Medium
- 复现步骤：
  1. 对同一用户和同一 display name 并发发起两个 create key 请求。
  2. 观察本地 binding 写入。
- 预期结果：未删除 Key 的同名约束在并发下仍成立。
- 实际结果：当前流程先查重复名再写入，schema 没有 `user + displayName + non-deleted` 唯一约束，存在竞态窗口。
- 截图或日志证据：
  - `src/features/newapi-bridge/server/portal.ts:470`
  - `src/config/db/schema.sqlite.ts:620`
- 影响范围：Key 列表、复制/禁用/删除操作、用户理解和审计都会被重复名称干扰。
- 初步根因：重复名称约束只存在应用层串行逻辑，没有数据库或事务级保护。
- 建议修复方式：增加事务锁、部分唯一索引或幂等键；补并发创建回归测试。

### 7. Low：本地 binding update 失败可能向用户透出 SQL/constraint 错误

- 严重级别：Low
- 复现步骤：
  1. 让 New API 远端 Key 创建成功。
  2. 人为制造本地 binding update 失败，例如 DB constraint 错误。
  3. 观察 `/api/apipool/keys` 错误响应和 UI 文案。
- 预期结果：用户看到安全、可理解的失败提示；内部 SQL/constraint 细节只进入日志或审计。
- 实际结果：catch 后重新抛出原始错误，public error mapper 不覆盖普通 SQL/constraint 关键词。
- 截图或日志证据：
  - `src/features/newapi-bridge/server/portal.ts:607`
  - `src/features/api-console/lib/public-errors.ts:37`
- 影响范围：Key 创建异常路径，可能暴露内部数据库实现细节。
- 初步根因：错误统一包装只覆盖 New API bridge error，没有覆盖本地 DB 失败。
- 建议修复方式：本地持久化失败统一包装为 `NewApiBridgeError` 或专用 public error；扩大脱敏测试。

### 8. Low：英文 Billing 页到账状态硬编码中文

- 严重级别：Low
- 复现步骤：
  1. 切到英文 locale。
  2. 访问有账单记录的 `/dashboard/billing`。
  3. 查看到账状态。
- 预期结果：英文页面展示英文状态文案。
- 实际结果：`mapApplyStatus` 返回 `已到账`、`到账处理中`、`到账失败` 等中文文案。
- 截图或日志证据：
  - `src/app/[locale]/(landing)/dashboard/billing/page.tsx:38`
- 影响范围：英文用户账单体验和产品一致性。
- 初步根因：状态映射写在页面代码中，没有接入 i18n message。
- 建议修复方式：将到账状态文案迁移到 locale message，并补英文账单状态测试。

### 9. Low：偶发 hydration warning 与错误提示视觉弱化

- 严重级别：Low
- 复现步骤：
  1. 真实浏览器访问用户控制台页面。
  2. 观察 dev console 与 API Key duplicate error 样式。
- 预期结果：无 hydration mismatch；错误状态使用明确的 destructive/错误样式。
- 实际结果：曾观察到一次 Radix/MobileNav `aria-controls` id mismatch，刷新后不可稳定复现；duplicate error 使用 muted 文案，视觉优先级偏弱。
- 截图或日志证据：
  - hydration warning 为浏览器 QA 期间偶发观察，未稳定复现。
  - API Key 错误提示位于 `api-key-manager` 相关 UI。
- 影响范围：低频开发体验噪声、错误提示可发现性。
- 初步根因：Radix id 生成或 SSR/client 条件渲染差异待复核；错误提示样式未按 destructive 状态设计。
- 建议修复方式：单独复查 MobileNav SSR/hydration；将关键错误提示改为明确错误色和 aria live。

## 四、验证结果

| 验证项 | 命令 | 结果 | 备注 |
| --- | --- | --- | --- |
| lint | `npm run lint` | 通过 | 0 errors，196 warnings；包含 baseline-browser-mapping 过旧、未使用变量、hook dependency、img alt 等既有 warnings |
| typecheck | `npx tsc --noEmit` | 通过 | 无错误输出 |
| unit tests | `npm test` | 通过 | `232/232 pass` |
| integration tests | `npm test` 中的 catalog、api-console、newapi-bridge、billing/ledger 相关测试 | 通过 | 属于本地集成/服务层覆盖；未替代 live provider 验收 |
| MVP smoke | `npm run smoke:mvp` | 命令退出 0，但 live 跳过 | 缺少 `APIPOOL_SMOKE_PORTAL_USER_ID`、`APIPOOL_SMOKE_OPERATOR_USER_ID`；不能作为发布通过依据 |
| build | `npm run build` | 通过 | Next 16/Turbopack build 成功 |
| browser/UI QA | gstack browse + 桌面/移动截图 | 部分通过 | 主要用户页可渲染；发现 API Key 分组、billing DTO、disabled catalog 等风险 |
| design review | gstack design-review + 主 agent 复核 | 部分通过 | 布局基本可用；错误提示、i18n、hydration warning 有低风险待处理 |

补充说明：

- 最终验证后曾为补齐 billing/usage 截图短暂重启本地 dev server，只创建并清理本地 QA 用户和截图文件，没有修改业务代码。
- 本轮测试创建的本地 QA 用户、测试 Key、临时 catalog disable DB 和 `/private/tmp/apipool-*.png` 均已清理。
- 最终确认端口 3000 无持续监听，测试浏览器服务已停止。

## 五、发布建议

发布建议：Conditional。

当前实现适合进入 staging 或受控内测，但不建议直接面向公开生产发布。主要原因不是基础构建失败，而是发布门禁与关键资金/目录/Key 边界还有会影响真实用户和账本可信度的问题。

### 必须修复项

- 后台人工调额必须补服务端幂等、数据库约束和重复提交回归测试。
- `smoke:mvp` 必须改为 DB-backed catalog + 真实或等价 New API 闭环；发布模式下 live smoke 跳过应失败。
- `/models` public/callable 查询必须过滤 disabled vendor/group/category/capability。
- API Key 可创建分组必须和 callable listing 对齐，无 callable 模型的分组不能直接创建 Active key。
- `/api/apipool/billing` 必须收窄用户侧 DTO，避免暴露内部 ledger 字段。

### 可延后项

- 英文 Billing 到账状态 i18n。
- API Key duplicate/error 提示样式增强。
- i18n namespace 加载测试增强。
- Radix/MobileNav hydration warning 偶发复查。
- lint warnings 分批清理。

### 剩余风险

- OAuth、Resend、支付 provider、New API live 调用仍未完成真实外部依赖验收。
- 支付 webhook、任务队列、缓存刷新和错误恢复只做了本地/代码层复核，仍需要 staging live 验证。
- 自定义 mutating routes 的 CSRF/Origin 策略需要单独安全验收。
- 管理后台目录 CRUD 本轮以代码审查和既有测试为主，未对每个表单做完整写入式浏览器验收。
