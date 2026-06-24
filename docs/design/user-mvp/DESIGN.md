# APIPool 最小用户可用版本（user-mvp）详细设计

- 状态：**已冻结 / 2026-06-24 / 经 2 轮评审**（第 1 轮 1 blocker + 4 major 全部修复 → 第 2 轮 Codex `approve`、F1–F5 全 resolved、无新增回归）
- 作者：Author（主笔）　评审：Reviewer（`codex exec`，只读）
- 评审处理表：`docs/design/user-mvp/review-log.md`（逐条 finding 处置）
- 关联需求：
  - `docs/08-user-mvp-requirements.md`（需求全文）
  - `docs/design/user-mvp/.codex/confirmed-requirements.md`（阶段 0 固化的已确认需求与约束）
  - `docs/design/user-mvp/.codex/current-state-research.md`（现状调研摘要，本设计已逐项核对真实代码）

---

## 0. 已确认需求与约束

> 来自阶段 0「需求理解与澄清」，用户已拍板。这是设计地基，后续各节不得与此冲突。完整版见 `confirmed-requirements.md`，此处摘要并补充本设计将解决的开放问题。

### 0.1 目标 / 范围 / 非目标

**目标**：让真实用户完成完整自助闭环
`注册/登录 → 在线充值或管理员发放额度 → 查看模型与价格 → 选分组创建 API Key → 真实调用模型 → 控制台看到余额、用量与 Key 状态`，同时保留管理员手动调额（充值/补偿/扣减/异常处理）。

**范围（六大块，深度不同）**：

1. 【最大新建块】模型/供应商/分组/能力/价格/状态体系：硬编码搬到 DB + 后台 CRUD；`/models` 四层筛选；同一 modelId 在不同分组 = 不同售卖项。
2. 【端到端新建】建 Key 选分组：只绑分组、不限定 allowedModels、可调模型范围做展示性。
3. 【配置+验证+补缺口】在线支付：不重写核心，接回设置页 + 端到端跑通 + 补充值记录展示。
4. 【补只读视图】管理员额度运营：沿用 adjust-quota，新增用户详情聚合只读视图。
5. 【接回+配置】登录增强：接回 admin 设置页、OAuth/Resend 配置化、邮箱链接验证。
6. 【补缺口】完整 dashboard：余额不足提示、Key 列表分组列、调用后变化可见（SSR + 手动刷新）。

**非目标**（见第 2 节，严格按 confirmed 第 5 节）。

### 0.2 非功能需求（性能/规模/并发/权限/兼容/可观测）

- **权限**：所有 admin 操作走 RBAC `requirePermission`；模型目录 CRUD 新增 `CATALOG` 类权限并授权 admin。
- **兼容/迁移**：模型目录由硬编码迁到 DB，需幂等 seed 脚本；drizzle 三方言（sqlite/postgres/mysql）schema 不得类型漂移（生产仅 SQLite）；迁移沿用现有 `deploy/entrypoint.sh` 运行时 migrator，不改 Dockerfile/entrypoint。
- **可观测/审计**：额度调整与加额走 `apipoolLedgerEntry` + `newApiBridgeAuditLog`。
- **i18n**：新增页面、动态 label、sidebar 均需 en/zh 两套文案。
- **架构约束**：New API 无「读分组/模型/价格列表」接口 → 门户自维护一份，管理员两侧手动对齐、不自动同步；控制面/数据面分离不破坏；不向普通用户暴露后台网关名称/入口/内部 ID；quota 整数 `500000 = $1`，幂等靠门户 `ledger.orderNo` 唯一索引。

### 0.3 验收标准（docs/08 第 4 节，逐条，本设计第 10 节矩阵全覆盖）

**用户验收 9 条（U1–U9）**：① Google/GitHub/邮箱注册登录均可完成；② 邮箱注册收到验证链接；③ 已登录用户建 Key 不因邮箱未验证被阻止；④ 在线充值并看到余额变化；⑤ `/models` 找到 ≥1 个可用模型；⑥ 选分组建 Key；⑦ 复制 Key 并真实调用 ≥1 个模型成功；⑧ 调用后 dashboard 看到余额减少与用量记录；⑨ 禁用 Key 后该 Key 不能继续调用。

**管理员验收 9 条（A1–A9）**：① 新增供应商/分组/能力/模型；② 同一 modelId 出现在不同分组并配不同价；③ 配置门户分组↔后台网关分组对应关系；④ 把模型从「即将上线」改「可用」并让用户建 Key 后调用；⑤ 下线模型或分组并让用户侧看到明确状态；⑥ 配置 Google/GitHub 与邮箱链接验证；⑦ 查看支付订单与到账状态；⑧ 对用户额度增加与扣减；⑨ 查看额度调整记录与用户用量。

### 0.4 留到本设计解决的开放问题（本节先列，第 4/6/11 节展开）

1. 价格如何存（定点 integer vs 小数字符串）。
2. 能力如何存（JSON 数组 vs 关联表）。
3. 状态如何兼顾「控制台可配」与业务语义（枚举字典表 + 行为标志）。
4. 「同一 modelId 在不同分组 = 不同售卖项」如何建模（本体表 × 分组定价表，行粒度）。
5. 门户分组 ↔ New API group 映射落在哪个字段；建 Key 用户输入字段如何不暴露内部 id。
6. ~~新建的 catalog 表是否需要进 postgres/mysql 三方言~~ —— **已定稿（第 1 轮评审后 Orchestrator 拍板）：sqlite-only**，遵循现有 bridge 表先例，详见 D6 与 confirmed §6「DB 方言策略」。

---

## 1. 背景与目标

### 1.1 要解决的问题

MVP 已打通最小垂直闭环（注册→建 Key→调用→看用量），但有三处硬伤使「真实用户自助、可信赖使用」不成立：

- **模型目录硬编码**：`src/features/api-catalog/lib/catalog.ts:111-268` 把 7 个模型写死在 `publicModels: ApiModel[]`，provider 仅 `OpenAI|Anthropic`、status 仅 `available|coming_soon`、无「分组（group）」概念（用 `channelTier: official|deal` 近似），管理员要改价/上下线/加供应商必须改代码重新部署。需求要求**四层筛选（供应商→分组→能力→状态）控制台可配** + **同一 modelId 跨分组多售卖项**，硬编码无法承载。
- **建 Key 不选分组**：`client.ts:572` 写死 `group: ''`，`key-input.ts:10-21` 写死 `allowedModels = [defaultCallableModelId]`、无 group。需求要求建 Key 必须选分组，并把分组翻译成 New API group 写进 token。
- **设置页是 redirect 桩**：`admin/settings/[tab]/page.tsx` 直接 redirect 到 `/admin/apipool-adjustments`，导致 OAuth/Resend/验证开关无 UI 入口（虽然 Better Auth 代码已就绪），充值记录缺「到账状态」列，admin 无用户额度/用量只读视图。

### 1.2 可度量目标（完成后什么变好、怎么验证）

| 目标 | 完成判据 | 验证方式（详见第 10 节） |
|---|---|---|
| 模型目录进 DB 且后台可维护 | 管理员能在 `/admin/catalog/*` 新增供应商/分组/能力/模型并配价，`/models` 立即反映 | A1/A2/A4/A5 端到端 |
| 四层筛选可配 | `/models` 出现「供应商/分组/能力/状态」四组链接筛选，选项来自 DB | U5 集成 + UI |
| 建 Key 选分组生效 | 建 Key 选分组后 token 的 New API group 非空、可成功调用 | U6/U7 端到端 |
| 登录三渠道可用 | Google/GitHub/邮箱均可登录，邮箱收到验证链接 | U1/U2 端到端 |
| 设置页接回 | admin 能在 `/admin/settings/auth`、`/admin/settings/email` 填密钥并保存 | A6 UI |
| 充值到账可见 | dashboard 充值记录展示订单时间/金额/支付状态/到账状态/到账处理中 | U4/A7 集成 + UI |
| 额度运营可查 | admin 用户详情聚合页展示余额/用量/Key/调额历史 | A8/A9 集成 + UI |

---

## 2. 非目标

严格按 `confirmed-requirements.md` 第 5 节 + docs/08 第 5 节，本次**明确不做**：

- 不把 `/docs` 快速接入文档作为本阶段紧迫项。
- 不做邮箱验证码（OTP）输入流程（沿用链接验证）。
- 不做模型独立详情页。
- 不做 Playground。
- 不做团队/组织账户。
- 不做用量导出。
- 不做复杂发票系统 / 复杂营销活动系统。
- 不做现有 APIPool 老用户资产迁移。
- 不向普通用户暴露后台网关名称、后台网关管理入口或内部 ID。
- **支付**：不重写支付核心、不做动态套餐管理后台（套餐仍暂留 i18n `pricing.json`）。
- **额度运营**：不做独立异常仪表板、批量重试工具、失败告警（复用现有 retry/reconciliation API）。
- **建 Key**：不做模型级精确限定（不写 allowedModels 进 token）、不做 Key 级受影响精确分析（已下线模型仅降级为状态标注）。
- **dashboard 实时刷新**：不做自动轮询/WebSocket（接受 SSR + 手动刷新按钮）。
- **门户↔网关同步**：不做模型目录/分组/价格在门户与 New API 之间的自动同步（管理员手动对齐）。

---

## 3. 当前系统现状

> ⚠️ 本节所有「文件:行」均由 Read/Grep 亲自核对真实代码（2026-06-24），非凭摘要假设。

### 3.1 模型目录 / 分组 / 价格（完全硬编码，无 DB）

- **类型与硬编码**：`src/features/api-catalog/lib/catalog.ts`
  - 类型（:3-8）：`ApiModelProvider = 'OpenAI'|'Anthropic'`、`ApiModelCapability = 'text'|'vision'|'reasoning'|'coding'`、`ApiModelStatus = 'available'|'coming_soon'`、`ApiModelChannelTier = 'official'|'deal'`。
  - `ApiModel` 类型（:10-34）：`slug/modelId/displayName/provider/category/capabilities[]/shortDescription/longDescription/contextWindow/featured/smokeTested/status/sortOrder/channelTier?/dealNote?/pricing{inputPerMillionUsd,outputPerMillionUsd,officialInput/OutputPerMillionUsd?,source,note?}`。价格是 `number`（浮点美元/百万 token）。
  - `publicModels: ApiModel[]`（:111-268）硬编码 7 条；注意 :136-162 用 `slug: 'gpt-4o-mini-deal'` + 同 `modelId: 'gpt-4o-mini'` + `channelTier: 'deal'` 表达「同一模型的特价渠道」——这就是当前「同一 modelId 多售卖项」的近似实现，靠 `slug` 区分、靠 `channelTier` 分区。
  - 筛选常量（:51-63）：`MODEL_PROVIDER_FILTERS/MODEL_CAPABILITY_FILTERS/MODEL_STATUS_FILTERS`，均 `as const` 硬编码；`buildModelFilterHref`（:94-109）纯链接式构造 querystring；`filterModels`（:270-291）三层过滤 + sortOrder 排序。
  - 业务语义：`isModelCallable`（:297-299）= `status==='available' && smokeTested`；`getDefaultCallableModelId`（:309-327）取配置或第一个可调模型。
- **`/models` 页**：`src/app/[locale]/(landing)/models/page.tsx`
  - 纯 Server Component（**无 `'use client'`**），数据源 = `import { publicModels }`（:9）→ `filterModels(publicModels, filters)`（:49）。
  - 三层筛选 `filterGroups`（:52-60）= Provider/Capability/Status，渲染为 `<Link>`（:87-101），**缺分组层**。
  - 表格 `ModelsTable`（:142-249）列：Model / Provider / Capabilities / Context / Input·1M / Output·1M / Status；额外有独立 Deals 区（:125-136）展示 `channelTier==='deal'` 模型。
- **守护测试**：`tests/public-content/locale-copy.test.ts`
  - 扫描根（:6-13）：`messages/{en,zh}/landing.json`、`messages/{en,zh}/pages/`、`content/docs`、`content/pages`（即 i18n seed + content）。
  - 内部黑名单（:35-40）：`/\bbridge\b/i`、`/New API/i`、`/newapi/i`、`/internal service/i`。**注意**：该测试**只扫 i18n seed JSON 与 content 目录**，不扫 `/models` 页面组件、不扫 DB 数据。

### 3.2 数据库 schema（drizzle 三方言）

- **barrel**：`src/config/db/schema.ts` 只 `export * from './schema.sqlite'`（:5），postgres/mysql 被注释。
- **三方言文件**：`schema.sqlite.ts`（808 行）、`schema.postgres.ts`（557 行）、`schema.mysql.ts`（517 行）。
  - **关键事实**：bridge/业务表（`newApiKeyBinding`、`apipoolLedgerEntry`、`usageSnapshot`、`newApiBridgeAuditLog`、`newApiUserBinding`、`usageLogSnapshot`）**只在 `schema.sqlite.ts` 定义，postgres/mysql 文件里没有**。三方言「不漂移」实际只对 ShipAny 通用表（user/order/config 等）成立。
  - 金额/quota 字段三方言一律 `integer`（mysql 是 `int`），**无 decimal/numeric**。
- **范式**（`schema.sqlite.ts`）：
  - 主键 `id: text('id').primaryKey()`（:19，无默认值函数，应用层 `getUuid()` 生成）。
  - boolean：`integer('x', { mode: 'boolean' }).default(false).notNull()`（:22-24）。
  - timestamp：`integer('x', { mode: 'timestamp_ms' }).default(sqliteNowMs)`（:26-28，`sqliteNowMs` 定义于 :14）。
  - FK：`.references(() => user.id, { onDelete: 'cascade' })`（:61-63）。
  - 索引：表定义第二参 `(table) => [ index('idx_x').on(table.col) ]`（:38-43）；唯一索引 `uniqueIndex(...)`。
  - JSON 列：`text('allowed_models').notNull().default('[]')`（:453）存 JSON 字符串。
- **现有相关表**：
  - `config`（:130-133）：`name: text('name').unique().notNull()`、`value: text('value')`（可空）；**无显式主键**（SQLite rowid）。
  - `newApiKeyBinding`（:441-476）：列含 `allowedModels`(:453 JSON text)、`status`、`quotaLimit`、`idempotencyKey`，**确认无 group/groupId 列**；索引 `idx_..._portal_status`/`idx_..._remote_key`(unique)/`idx_..._idempotency`(unique)。
  - `apipoolLedgerEntry`（:545-581）：`portalUserId/operatorUserId`(FK)、`newapiUserId`、`newapiChangeId`(unique :578)、`orderNo`(unique :579)、`amountUsd: integer`(:558，**美元数值整数，5 表示 $5**——`recharge.ts:51-53 toAmountUsd(amountCents)` 除以 100 后写入，`tests/payments/recharge.test.ts:99` 断言 500 cents → `amountUsd===5`；非「美分」)、`source`(:559 text 枚举)、`status`(:560)、`executor`(:561)、`reason`(:562)、`rollbackStatus`(:563)。
  - **充值记录数据源现状（F2 核对）**：billing 页（`dashboard/billing/page.tsx:40-48`）取数走 `listLedgerEntries(user.id)`（`portal.ts:968`）→ `toPublicLedgerEntry`（`portal.ts:162-173`），该投影返回 `id/amountUsd/source/status/reason/rollbackStatus/createdAt/updatedAt`，**不返回 `orderNo`、不 join `order`**。故「无新接口、用 ledger 关联 order 状态展示支付状态」不可行，须新增只读投影（见 §5.8、§6.2）。`order` 表（:203-229）有 `orderNo`(unique :207)、`status`(:212 created/paid/failed)、`paymentProvider`(:218)、`paidAt`(:229)，可经 `ledger.orderNo = order.orderNo` 关联。
  - `newApiBridgeAuditLog`（:583-611）：`action/targetType/targetId/status/idempotencyKey/requestBody/responseBody/errorMessage`。
  - `usageSnapshot`（:478-512）：`status` 取值 `ready/empty/syncing/stale/failed`（:494）、`byModel: text` JSON、唯一索引 `(portalUserId, range)`。

### 3.3 建 Key 链路

- **前端输入清理**：`src/features/api-console/lib/key-input.ts:10-21` `sanitizePortalApiKeyCreateInput` 返回 `{ name, allowedModels: [getDefaultCallableModelId(...)] }`，**无 group**。
- **服务层**：`src/features/newapi-bridge/server/portal.ts:385-416+` `createPortalApiKey` 把 `allowedModels` JSON 序列化写 `newApiKeyBinding`（:404-414 区），状态 `creating_remote`。
- **远端建 Key**：`client.ts:548-592` `createKey` 第 **572 行 `group: ''` 写死**；入参支持 `allowedModels?/quotaLimitUsd?/ipAllowlist?`，无 group 参数。
- **API 路由**：`POST /api/apipool/keys`（`src/app/api/apipool/keys/route.ts:32-63`）调 `sanitizePortalApiKeyCreateInput(body)`。
- **前端组件**：`src/features/api-console/components/api-key-manager.tsx`（`'use client'` :1）；建 Key 表单只输 name（:97 写死 models）；列表列 Name/Masked key/Status/Models/Actions（:216-221），**无分组列、无分组下拉**；完整 key 一次性展示（:185-204）；复制/禁用/删除（:250-289）。
- **状态机**：`src/features/api-console/lib/status.ts:1-68`，`KeyLifecycleStatus` 9 态，`canDisableKeyStatus`(:62-64)=仅 `active`、`canDeleteKeyStatus`(:66-68)=`active|disabled`。
- **门户分组↔New API group 映射**：当前**不存在**（group 恒空、无映射表）。

### 3.4 控制台 dashboard / 用量（大部分已实现）

- **路由**：`/dashboard`（概览）、`/dashboard/api-keys`、`/dashboard/usage`、`/dashboard/billing`；tab 定义 `dashboard-shell.tsx:5-10`（Overview/API Keys/Balance/Usage）。
- **概览**：`dashboard/page.tsx` 4 个 StatCard（Balance/Requests·7d/Tokens·7d/API Keys，:79-106）、Base URL（:67-77）、Add credit / Create key 入口（:54-64）、近 8 条请求表（:124-154）。
- **余额/用量链路**：`getPortalUsage(user, range)`（`portal.ts:761-832`）并行调 `client.getQuota`/`getUsageSummary`/`listUsageLogs`（:768-772 区），缓存写 `usageSnapshot`；`quotaToUsd = quota / quotaPerUnit`（`client.ts:222-224`，`quotaPerUnit=500000`）；`formatUsdAmount` 6 位小数（`src/features/api-console/lib/money.ts:3-10`）。
- **billing 页**：`dashboard/billing/page.tsx` TopUpPackages（套餐来自 i18n `pricing.json`，:51-67）、充值历史表（:101-146，**仅 4 列 Date/Type/Amount/Status**，行字段 `createdAt/source/amountUsd/status`，status 映射 applied→Completed/pending→Processing :127-139）、消费记录表（:157-192）。
- **缺口**：余额不足提示未实现；Key 列表无分组列；调用后无自动刷新（纯 SSR）；充值记录缺「订单时间/支付状态/到账状态」分列。

### 3.5 登录 / 鉴权 / 邮件 / 设置页（99% 就绪，缺设置页接回）

- **Better Auth**：`src/core/auth/config.ts`
  - `emailAndPassword.enabled: true`（:64-65）；动态版 `enabled: configs.email_auth_enabled !== 'false'`、`requireEmailVerification: emailVerificationEnabled`、`autoSignIn`（:152-157）。
  - `emailVerificationEnabled = configs.email_verification_enabled === 'true' && !!configs.resend_api_key`（:76-77）。
  - `emailVerification` hook（:158-204）：`expiresIn = 60*60*24`（24h，:168）、`sendVerificationEmail` 发链接（:169-201）、60s 频限（`VERIFICATION_EMAIL_MIN_INTERVAL_MS = 60_000` :25）。
  - Google OAuth 动态装载（:218-223，条件 `google_client_id && google_client_secret`）；GitHub 同理（:226-231）。**代码已就绪，只差填密钥**。
  - 入口 `src/core/auth/index.ts:8-15` `getAuth()` 运行时 `await getAllConfigs()`（:10）→ `getAuthOptions(configs)`。
- **Resend**：provider `src/extensions/email/resend.ts:24-117`；工厂 `src/shared/services/email.ts:7-20` 按 `configs.resend_api_key` 动态注册；模板 `src/shared/blocks/email/verify-email.tsx:16-81`（链接验证、24h 过期 :59-61）。
- **登录注册 UI（全在）**：`sign-in.tsx`（邮箱+密码、403→/verify-email :99-124）、`sign-up.tsx`（验证提示 :204-208）、`social-providers.tsx`（Google :127-134 / GitHub :136-143，popup OAuth）、`verify-email.tsx`（重发 60s 冷却 :21、跨标签同步 :179-199）。
- **⚠️ admin 设置页是 redirect 桩**：`src/app/[locale]/(admin)/admin/settings/[tab]/page.tsx` 全文仅 `redirect({ href: '/admin/apipool-adjustments', locale })`。
- **设置项定义已就绪**：`src/shared/services/settings.ts`
  - `Setting` 接口（:5-19）：`name/title/type/placeholder?/options?/tip?/value?/group?/tab?/attributes?`，type 含 text/password/switch/select 等。
  - `SettingGroup`（:21-26）、`getSettingTabs()`（:28-96，tabs: general/auth/payment/email/storage/...）、`getSettings()`（:278 起）。
  - `google_client_id`(:405-410 text/auth)、`google_client_secret`(:413-418 password)、`github_client_id/secret`(:428-441)、`email_verification_enabled`(:380-386 switch/auth)、`resend_api_key`(:696-701 password/email)、`resend_sender_email`(:704-709)。
  - 公开白名单 `publicSettingNames`（:938-958）含 `email_verification_enabled/google_auth_enabled/google_client_id/github_auth_enabled/...`（注意：`google_client_secret`、`resend_api_key` 不在白名单，仅服务端可读）。
- **配置存储**：`src/shared/models/config.ts`
  - `getAllConfigs()`（:104-135）优先级 env 大写 > env 小写 > DB > envConfigs。
  - `saveConfigs()`（:20-65）upsert（`onConflictDoUpdate`）+ `revalidateTag('configs', 'max')`（tag `CACHE_TAG_CONFIGS='configs'` :18）。
  - `getConfigs()`（:74-102）`unstable_cache`，tag `['configs']`，revalidate 3600s。

### 3.6 支付 / 额度 / 用户管理（大部分已实现，缺 admin 查看视图）

- **支付**：checkout `src/app/api/payment/checkout/route.ts:22-305`（入参 `product_id/currency/locale/payment_provider/metadata`，出参 `checkoutUrl/sessionId`）；webhook `notify/[provider]/route.ts:18-237`（按 `transactionId + paymentProvider` 幂等 :99-109）；`handleCheckoutSuccess`（`src/shared/services/payment.ts:150-301`，订单 CREATED/PENDING→PAID :185-186，调 `applyApipoolRecharge` 不抛错）；provider stripe/creem/paypal（`src/extensions/payment/*`，密钥从 config 读 `stripe_secret_key/creem_api_key/paypal_client_id` 等）。
- **加额执行器**：`recharge.ts:64-130` `executeRecharge`：调 `client.adjustQuota` 拿 `changeId`，成功置 ledger `status='applied'` + 回填 `newapiChangeId/newapiUserId`（:82-90）；失败按 `TERMINAL_RECHARGE_ERROR_CODES`(`unauthorized/forbidden/malformed_response` :45-49) 分终态 `failed` / 瞬时 `pending`（:104-129）；幂等键 `orderNo`（:55-62 查重）。**注意 `source` 字段在 `executeRecharge` 不设置，由上游 draft 创建时设定**。
- **额度调整**：`POST /api/apipool/admin/adjust-quota`（`route.ts:12-59`，权限 `PERMISSIONS.APIPOOL_QUOTA_ADJUST` :19，入参 `portalUserId/amountUsd(可负)/reason`）→ `adjustPortalQuota`（`portal.ts:978-1065`，写 ledger source=manual_adjustment + audit `newapi.quota.adjust`）；前端 `quota-adjustment-form.tsx:1-78`。
- **retry/reconciliation**：`POST /api/apipool/admin/recharge/retry`（按 orderNo，权限同上）；`GET /api/apipool/admin/recharge/reconciliation`（`RECONCILIATION_LIMIT = 100` 固定上限）。
- **用户管理**：`admin/users/page.tsx:17-153` 列表（id/name/image/email/roles/emailVerified/createdAt/ip/locale/utmSource/actions），action 含 adjust-quota 跳转 `/admin/apipool-adjustments?portalUserId={id}`（:129）。**缺**：用户余额查询、用量查询、API Key 查看、调额历史聚合视图。

### 3.7 RBAC / 权限 / seed / 菜单范式（可照抄）

- **CRUD 范式**：`admin/roles/page.tsx`（列表 `TableCard`，`columns` 含 `type: dropdown` + `callback` 返回 action 数组）；`admin/roles/[id]/edit/page.tsx`（`FormCard` + `form.fields` + `passby` + `submit.handler` 内 `'use server'` + `updateRole` + 返回 `{ status:'success', redirect_url:'/admin/roles' }`）。
- **组件**：`TableCard`（`src/shared/blocks/table/table-card.tsx:22-35`，props `title?/description?/buttons?/tabs?/table/className?`）；`FormCard`（`src/shared/blocks/form/form-card.tsx:28-44`，props `title?/description?/crumbs?/form/className?/collapsible?/defaultCollapsed?`）。
- **服务层**：`src/shared/services/rbac.ts` `getRoles/getRoleById/createRole/updateRole/deleteRole`（:45-96）+ 关联 `getRolePermissions/assignPermissionToRole/removePermissionFromRole`（:134-171），标准 drizzle `db().select/insert/update/delete`。
- **权限常量**：`src/core/rbac/permission.ts:12-66` `PERMISSIONS = { ADMIN_ACCESS:'admin.access', APIPOOL_QUOTA_ADJUST:'admin.apipool.quota.adjust', ROLES_READ:'admin.roles.read', ... } as const`。
- **seed**：`scripts/init-rbac.ts`（`loadSchemaTables()` 按 provider 动态 import schema :19-30、`defaultPermissions` :33-271、role↔permission 先删后插 + 通配符展开 :414-445）。
  - ⚠️ **并发安全性核对（F5）**：`:358-376` 实为「先 `select` 查存在、不存在才 `insert`」，**未用 `onConflictDoNothing/onConflictDoUpdate`、未捕获唯一冲突**。单进程重跑幂等（查到即跳过），但两进程并发 seed 同一 slug 时可能都查空、随后其一 `insert` 触发 unique 冲突抛错。`init-catalog` **不照抄此脆弱模式**（见 D9、§5.1）。
- **菜单**：`src/config/locale/messages/{en,zh}/admin/sidebar.json`（`main_navs[].items[].children[]`，含 `title/url/icon`）。
- **i18n 目录**：`src/config/locale/messages/{en,zh}/`（`landing.json`、`pages/pricing.json`、`settings/*.json`、`admin/sidebar.json`）。

---

## 4. 方案概览

### 4.1 整体思路（一段话）

把硬编码模型目录抽象为一组 DB 实体（供应商 / 能力 / 状态字典 / 分组 / 模型本体 / 分组售卖项），由仿 `admin/roles` 的 CRUD 后台维护；`/models` 与建 Key 的数据源从 `import publicModels` 切到「DB 查询层」（同样在 server 侧、保持纯链接式筛选与零新公共组件），把「分组」作为第四个筛选维度与建 Key 的必选项；建 Key 时把所选分组的 `newapiGroup` 字段写进 `client.createKey` 的 `group`，并把该分组当前可调模型列出作展示；登录增强只需把 redirect 桩换回真实 `FormCard` 渲染（Better Auth 已就绪）；支付与额度运营复用已有核心，仅接回设置页填密钥、补 dashboard 充值记录「到账状态」列、新增 admin 用户详情只读聚合页。门户与 New API 不自动同步，分组↔group 映射由管理员在分组表 `newapiGroup` 字段手动维护。

### 4.2 关键设计决策（含被否备选）

#### D1：价格存储 —— **定点 integer（micro-USD/百万 token，即美元 × 1,000,000）**

- **决策**：分组售卖项的输入/输出价存为 `integer`，单位「micro-USD per 1M tokens」。例：$0.15 → `150000`；$2.50 → `2500000`。展示层除以 1,000,000 再 `toFixed(2)`。
- **理由**：
  - 与全仓约定一致：`amountUsd`(ledger)、`balanceUsd`(snapshot)、quota（`500000=$1`）全是 integer，三方言无 decimal/numeric（§3.2）。引入 text 小数或 decimal 会破坏一致性、引入跨方言类型漂移风险。
  - 门户**只展示不参与 SQL 计算**（计费在 New API 侧），integer 仅做存储与展示，精度足够（micro 级覆盖到 $0.000001/1M，远超现价粒度）。
  - 定点避免浮点 `toFixed` 误差（现状 `pricing.inputPerMillionUsd: number` 是浮点，搬库时正好收敛为定点）。
- **被否**：① text 小数字符串——可读但需运行时 parse、无法 DB 排序/校验、易写入脏数据；② drizzle `real`/浮点——浮点不精确且 mysql/pg 表示不一；③ decimal/numeric——sqlite 无原生 decimal，三方言行为不一，且本块表只落 sqlite（见 D6），过度设计。
- **附**：折扣不单独存数值，存「展示性折扣说明 `discountNote`(text)」+ 可选「划线原价 `listInputMicroUsd/listOutputMicroUsd`(integer 可空)」，对应现状 `officialInput/OutputPerMillionUsd` 划线展示（`models/page.tsx:212-217`）。

#### D2：能力存储 —— **字典表 `catalog_capability` + 模型↔能力关联表 `catalog_model_capability`**

- **决策**：能力是「控制台可配字典 + 一个模型多能力」的多对多，用字典表 + 关联表，不用 JSON 数组列。
- **理由**：
  - 需求要求能力「新增/编辑/禁用」且作为**筛选维度**（§0.3 A1、U5）。筛选维度若存 JSON 需全表扫 + 应用层过滤，且「禁用某能力」要回改所有模型 JSON；关联表可加索引、按能力反查模型、禁用只改字典。
  - 与 RBAC 既有「role↔permission 关联表」范式一致（§3.7），CRUD/seed 可照抄。
  - 模型卡片展示能力标签（`models/page.tsx:195-205`）= join 关联表即可。
- **被否**：JSON 数组 key（如 `newApiKeyBinding.allowedModels` 那样）——写简单但失去可配字典语义、无法对能力做独立 CRUD 与引用完整性（删能力会留悬空 key），与「能力可由控制台配置」需求冲突。

#### D3：状态体系 —— **枚举字典表 `catalog_status` + 行为标志 `isCallable`/`isPublicVisible`，模型售卖项引用 statusId**

- **决策**：状态做成可配字典表，每行带两个布尔行为标志：
  - `isCallable`（是否允许建 Key 后调用）、`isPublicVisible`（是否默认在 `/models` 公开展示）。
  - 首批 seed 三状态：`available`(callable=true, visible=true)、`coming_soon`(callable=false, visible=true)、`retired`(callable=false, visible=false)。
- **理由**：
  - 需求要求状态「控制台可配」（§0.3 A1）**同时**有固定业务语义「可用/即将上线/已下线」对应不同行为（docs/08 2.1：可用允许调用、即将上线只展示、已下线不展示不允许新建调用）。纯枚举无法控制台配，纯自由文本丢业务语义。字典表 + 行为标志两者兼得：管理员可加新状态名/改文案/排序，但「能否调用、是否展示」由标志位驱动，建 Key 校验与 `/models` 过滤读标志位而非硬编码状态名。
  - 「已下线影响已有 Key」按 confirmed Q3 降级为状态标注：`/models` 与 dashboard 读 `isCallable=false` 即打「不可新建调用」标注，不做 Key 级分析。
- **被否**：① 纯枚举 text 列（现状）——不可配；② 纯字典表无行为标志——管理员配了状态但系统不知道该不该放行调用，业务语义丢失；③ 把行为标志放模型售卖项行——同一状态语义会重复且可能不一致。

#### D4：「同一 modelId 跨分组 = 不同售卖项」建模 —— **模型本体表 `catalog_model` ×（一对多）分组售卖项表 `catalog_model_listing`，`/models` 列表行粒度 = listing 行**

- **决策**：
  - `catalog_model`（本体）：`modelId`(全局唯一标识如 `gpt-4o-mini`)、`displayName`、`vendorId`(FK)、`contextWindow`、能力（经关联表）、`category`。承载「模型是什么」。
  - `catalog_model_listing`（分组售卖项）：`modelId`(FK→catalog_model) × `groupId`(FK→catalog_group)，加 `inputMicroUsd/outputMicroUsd/listInput.../listOutput...`、`statusId`(FK)、`discountNote`、`description`(用户可见说明)、`smokeTested`(bool 真实调用验证)、`sortOrder`。唯一约束 `(modelId, groupId)`。承载「这个模型在这个分组里卖什么价、什么状态」。
  - **`/models` 列表每一行 = 一个 listing**（modelId × group），完全满足「同一 modelId 在不同分组重复出现、可有不同价/折扣/状态/说明」（docs/08 2.1）。
- **理由**：
  - 直接映射需求语义「同一 modelId 在不同分组视为不同售卖项」（§0.4 假设、A2）。本体与售卖项分离 → 改一处模型元信息（如 contextWindow）不必跨分组重复维护；价格/状态/说明按 (modelId,group) 独立。
  - 取代现状用 `slug` + `channelTier` 的近似 hack（§3.1），语义更准（分组是一等公民而非 official/deal 二分）。
  - 建 Key 展示「该分组可调模型范围」= 查该 group 下 `statusId.isCallable=true` 的 listing 即可。
- **被否**：① 单宽表（modelId 重复整行）——价格/状态散落、改本体信息要批量更新、无引用完整性；② 把分组做成模型行上的数组列——无法对 (modelId,group) 配独立价/状态，违背「不同售卖项」。

#### D5：门户分组 ↔ New API group 映射 —— **落在 `catalog_group.newapiGroup`(text) 字段**

- **决策**：映射就是分组表的一列 `newapiGroup: text`（New API 侧的 group 名/标识）。建 Key 时读所选分组的 `newapiGroup` 写进 `client.createKey({ group })`。允许为空字符串（= New API 默认分组），对应现状 `group: ''` 的兼容退路。
- **心智模型（2026-06-24 用户确认）**：门户分组是**逻辑/展示名称**，真正的渠道分组在 **New API 那一侧**；`newapiGroup` 就是门户分组指向 New API 分组的引用。门户只负责维护这层「逻辑名 → New API group」的映射关系，不拥有、不校验底层分组本身（故不做连通性自检，Q-D 已决）。
- **公共标识与内部 id 分离（F1 修订，关键）**：
  - 用户输入/提交用面向用户的 **`groupSlug`**（门户侧稳定标识，如 `official`），**绝不**把内部 `catalog_group.id`（UUID PK）送到浏览器或 POST body（违反 confirmed §4「不暴露内部 ID」）。
  - `getGroupsForKeyCreation()` 返回 `{ slug, name, userDescription }`——**不含 `id`、不含 `newapiGroup`**。
  - `POST /api/apipool/keys` **只接收 `groupSlug`**；**服务端**在 `createPortalApiKey` 内按 slug 解析到内部 `catalog_group.id` + `newapiGroup`，**只把内部 id 写 `newApiKeyBinding.groupId`**（可加 `newapiGroup` 快照）。即「浏览器侧只见 slug，内部 id 不出服务端」，杜绝 round-trip 暴露 id 或「拿 slug 当 groupId 落 FK 致语义错配」两条歧路（F1 detail）。
- **理由**：
  - 需求明确「门户分组需要能配置和后台网关分组的对应关系」「分组可标记是否允许用户创建 Key」（docs/08 3.1、A3），且 New API 无读接口、靠管理员手动对齐（§0.2）。把映射作为分组的一个可编辑字段最直接，CRUD 后台一处可改。
  - 不新建独立映射表：一个门户分组对一个 New API group 是 1:1，独立表是过度设计。
  - **公共页绝不暴露 `newapiGroup` 与内部 id**：二者仅服务端/admin 可见，`/models` 与建 Key 展示用门户侧 `name/slug/userDescription`。现有 locale-copy 黑名单（§3.1）含 `New API`/`newapi`/`bridge`/`internal service`，**不含** `group`——但「group」是后台网关术语，公共页同样不应出现，需靠类型边界 + 建议扩展守护测试兜底（见 §8.1 公共页措辞约束）。
- **被否**：① 独立 `group_mapping` 表——1:1 关系无需额外表 + join，增加迁移与维护成本；② 直接把 `catalog_group.id` 作为建 Key 表单 value——暴露内部 UUID，违反硬约束。

#### D6：新建 catalog 表的方言落点 —— **【已定稿】sqlite-only：只在 `schema.sqlite.ts` 定义，pg/mysql 不在 user-mvp 支持面**

- **决策状态**：**已定稿**（2026-06-24 第 1 轮评审 F3=blocker 后由 Orchestrator 拍板，confirmed §6「DB 方言策略」已落定稿条款）。**不再是未决问题**。
- **决策**：所有 `catalog_*` 表只写进 `schema.sqlite.ts`，与既有 bridge/业务表（`newApiKeyBinding`/`apipoolLedgerEntry` 等）落点完全一致（§3.2 关键事实：这些业务表本就只在 sqlite，pg/mysql 文件不含）。`schema.ts` barrel 已只 `export * from './schema.sqlite'`（:5），类型从 sqlite 单源推导，不分裂。**pg/mysql 明确不在 user-mvp 支持面**，生产仅 SQLite（confirmed §6）。
- **「三方言不漂移」的可执行含义**（confirmed 已澄清）= 类型从 sqlite barrel **单源推导、不分裂**，而非「pg/mysql 也要写一套 catalog 表」。只要不往 postgres/mysql 文件加半套表，就不漂移。
- **守护方案（编码须落地，防回归）**：
  1. **单源导出**：catalog 表只在 `schema.sqlite.ts` 定义并经 barrel `export *` 导出；所有运行时/类型路径**只**从 `@/config/db/schema`（barrel）或 `schema.sqlite` 取 catalog 表，**禁止**任何代码 `import` `schema.postgres`/`schema.mysql` 的 catalog 表（pg/mysql 文件根本不含这些表，import 即编译错——天然护栏）。
  2. **构建/类型断言**（新增守护测试 `tests/db/catalog-schema-singlesource.test.ts`，见 §10.1 F1）：① 断言 `schema.postgres.ts`/`schema.mysql.ts` 源码**不含** `catalog_` 表名（grep 文本守护，防有人误补半套）；② 断言从 barrel 能解析出全部 7 个 catalog export（证明单源可推导）。
  3. **migrator 一致**：运行时 migrator（`deploy/entrypoint.sh`）只对 sqlite 库 apply，无 pg/mysql 迁移分支（沿用现状，§0.2）。
- **被否**：三方言各写一套 catalog 表——bridge 表都没这么做，平白三倍维护面、且任一处不一致才会真漂移；生产用不到 pg/mysql，收益为零；若未来真切库，按独立大改补三方言（§9.2 假设表已记录）。

#### D7：`/models` 与建 Key 的数据源切换 —— **新增 server 查询层 `catalog/server/queries.ts`，页面/路由调它取数，保持纯链接式 SSR**

- **决策**：新建 `src/features/api-catalog/server/queries.ts`（`'server-only'`），导出 `getPublicListings(filters)`、`getFilterDimensions()`（四层选项从 DB 字典聚合）、`getCallableListingsByGroup(groupSlug)`、`getGroupsForKeyCreation()` 等（建 Key 相关函数一律以 `groupSlug` 为公共入参/出参，内部 id 不外泄，见 D5/F1）。`/models` 页与建 Key 路由/组件改调这些函数，**不再 import `publicModels`**。`catalog.ts` 的纯函数（`buildModelFilterHref`、价格格式化）保留或迁移，硬编码 `publicModels` 数组删除（或保留为测试夹具，见 §7）。
- **理由**：保持 `/models` 现有「Server Component + 纯 `<Link>` 筛选、无 client JS」架构（§3.1），只换数据源；查询层集中 DB 访问便于缓存（`unstable_cache` + tag，admin 改后 revalidate）与测试。
- **被否**：在页面里直接写 drizzle——破坏分层、无法复用给建 Key、难测。

#### D8：登录/支付/额度运营 —— **接回与补缺口，零核心重写**

- 登录：把 `admin/settings/[tab]/page.tsx` 的 redirect 换回真实渲染（`getSettings()/getSettingTabs()` 过滤当前 tab → `FormCard` → `submit.handler` 内 `'use server'` 调 `saveConfigs()`），至少保 `auth`、`email` 两 tab 可用。Better Auth 已按 config 动态装载（§3.5），填密钥即生效。
- 支付：仅接回设置页填密钥 + 补 dashboard 充值记录展示列（订单时间/金额/支付状态/到账状态/到账处理中），核心 checkout/webhook/recharge 不动。
- 额度运营：沿用 `adjust-quota`，新增 `/admin/users/[id]`（或 `[id]/detail`）只读聚合页（余额/用量/Key/调额历史），数据来自现有 `getPortalUsage` + ledger 查询 + binding 查询；异常复用 retry/reconciliation。

#### D9：`init-catalog` seed 幂等/可重入 —— **按 slug `insert ... onConflictDoNothing`，不照抄 init-rbac 的「先查后插」**

- **决策**：`init-catalog.ts` 每个字典/本体表按业务唯一键（`slug`，关联表按 `(modelId,capabilityId)`）执行 `insert(...).values(...).onConflictDoNothing()`（需更新文案时用 `onConflictDoUpdate`，目标 = 对应 unique index）。多表 seed 按依赖序在**一个事务**内执行，保证整体可重入。**不复制 `init-rbac.ts:358-376` 的「先 select 后 insert、无 onConflict」模式**（§3.7 已核对该模式并发脆弱）。
- **理由**：
  - F5 成立：catalog seed 是「硬编码迁 DB」的地基，必须可重复执行、可中途失败重入（F1 验收要求）。`onConflictDoNothing` 把幂等下沉到 DB 唯一约束，单进程重跑、并发重跑均不抛唯一冲突；而「先查后插」存在查空窗口竞态。
  - 所有字典表已设计 `slug unique`、listing 设 `(modelId,groupId)` unique、能力关联设 `(modelId,capabilityId)` unique（§6.1），`onConflict` 有明确目标。
- **并发风险定级（务实）**：生产为**单实例 compose 部署**（一份 entrypoint 串行 migrate+seed），真正的多进程并发 seed 非主要风险；但「可重入 + 不抛错」是硬要求，`onConflictDoNothing` 同时满足两者，成本极低，故采用。并发用例在 §10.1 F1 列为补充验证（非主风险但可断言）。
- **被否**：① 先查后插（init-rbac 现状）——并发查空窗口竞态、且重跑虽幂等但模式脆弱；② 每次 seed 前 `delete` 再插——会清掉 admin 后续手工编辑的数据，破坏「seed 仅补种子、不覆盖运营改动」语义。

---

## 5. 模块 / 文件级改动计划

> 类型：N=新增，M=修改，D=删除（或弃用）。

### 5.1 数据库 schema 与 seed

| 文件 / 模块 | 类型 | 改什么 | 为什么 |
|---|---|---|---|
| `src/config/db/schema.sqlite.ts` | M | 新增 6 张表：`catalogVendor`、`catalogCapability`、`catalogStatus`、`catalogGroup`、`catalogModel`、`catalogModelCapability`(关联)、`catalogModelListing`（共 7 个 export，含关联表）| 承载模型目录（D1–D5）|
| `src/config/db/schema.ts` | — | 无需改（已 `export * from './schema.sqlite'`，自动导出新表）| D6 |
| `scripts/init-catalog.ts` | N | 借鉴 `init-rbac.ts` 的 `loadSchemaTables()` 动态 import 骨架，但 seed 写入用 **`insert ... onConflictDoNothing`（按 slug / 关联唯一键）+ 事务**（D9，**不照抄 init-rbac 的先查后插**）；seed 首批供应商(OpenAI/Anthropic/Google)、能力(text/vision/video/audio)、状态(available/coming_soon/retired)、≥1 分组(official)、≥1 模型 + ≥1 listing（smokeTested=true，满足 confirmed §0.2「首批 ≥1 分组+1 供应商+1 模型完成真实调用验证」）；保证可重入、重复执行行数稳定不抛错 | 硬编码迁 DB 的初始数据；幂等可重入（F5）|
| `package.json` scripts | M | 加 `init-catalog`（或并入现有 seed 编排）；`deploy/entrypoint.sh` 若串接 seed 则追加（沿用运行时 migrator，不改 Dockerfile）| confirmed §0.2 迁移走 entrypoint |
| `tests/db/catalog-schema-singlesource.test.ts` | N | D6 sqlite-only 守护：断言 `schema.postgres.ts`/`schema.mysql.ts` 源码不含 `catalog_` 表名；断言 barrel 可解析全部 7 个 catalog export（单源可推导）| F3/D6 防有人误补半套三方言表 |

### 5.2 模型目录服务层与查询层

| 文件 / 模块 | 类型 | 改什么 | 为什么 |
|---|---|---|---|
| `src/features/api-catalog/server/catalog-service.ts` | N | admin CRUD 服务：`getVendors/createVendor/updateVendor/...`、capabilities、statuses、groups、models、listings 的 getX/createX/updateX/deleteX（仿 `rbac.ts`）| 后台 CRUD 数据访问 |
| `src/features/api-catalog/server/queries.ts` | N | 公共/建 Key 读层：`getPublicListings(filters)`、`getFilterDimensions()`、`getCallableListingsByGroup(groupSlug)`、`getGroupsForKeyCreation()`（返回 `{slug,name,userDescription}`，**不含 id/newapiGroup**，F1）；`'server-only'` + `unstable_cache` + tag `catalog`，admin 改后 `revalidateTag('catalog')` | D7 数据源切换 + 公共标识用 slug |
| `src/features/api-catalog/lib/catalog.ts` | M | 删除/弃用硬编码 `publicModels`（:111-268）与硬编码 `*_FILTERS`（:51-63）；保留 `buildModelFilterHref`/价格格式化纯函数（改为接受 DB 形状），筛选维度改由 `getFilterDimensions()` 提供 | 去硬编码 |
| `src/features/api-catalog/lib/types.ts` | N（或并入）| 定义 DB 派生的 `ListingRow`/`FilterDimensions` 类型，公共展示形状（**不含 `newapiGroup`**）| 类型与公共/内部边界 |

### 5.3 `/models` 公共页

| 文件 / 模块 | 类型 | 改什么 | 为什么 |
|---|---|---|---|
| `src/app/[locale]/(landing)/models/page.tsx` | M | 数据源由 `import publicModels` 改为 `await getPublicListings(filters)`；`filterGroups` 增第 4 组「分组」（选项来自 `getFilterDimensions()`）；表格增「分组」列（展示门户分组 `name`，**不展示 newapiGroup**）；状态展示读 `statusId` 字典 label + `isCallable` 标注；**取消独立 Deals 区**（Q-B 已决）→ 统一单一 listing 表、折扣行内展示（`discountNote`/划线价）| U5、A2、四层筛选、保持纯链接 SSR |
| `tests/public-content/locale-copy.test.ts` | M | 扩展扫描根：把 `/models` 相关 DB seed 文案 / 动态 label i18n 文件纳入；或新增断言确保 `catalog-service` 暴露给公共层的字段不含 `newapiGroup`/`group`/`newapi`（见 §8.1）| 守护公共页不漏后台痕迹 |

### 5.4 建 Key 选分组

| 文件 / 模块 | 类型 | 改什么 | 为什么 |
|---|---|---|---|
| `src/config/db/schema.sqlite.ts` `newApiKeyBinding` | M | 增列 `groupId: text('group_id')`(可空，FK→catalogGroup，建议不 cascade 删，用 set null/restrict)；可选增 `newapiGroup: text` 冗余快照（避免分组改名后历史 Key 展示漂移）| 持久化 Key 所属分组 |
| `src/features/api-console/lib/key-input.ts` | M | `sanitizePortalApiKeyCreateInput` 增 **`groupSlug`** 解析与必填校验（面向用户标识，**非内部 id**，F1）；**不再写死 allowedModels**（confirmed Q3：不限定模型）——allowedModels 置空/不传，靠 group 路由。同时去掉对 `getDefaultCallableModelId` 的依赖（§7.1）| 建 Key 必选分组、不绑模型、不暴露内部 id |
| `src/features/newapi-bridge/server/client.ts` | M | `createKey` 入参增 `group?: string`（此处 `group` = 已解析的 `newapiGroup` 值，由 portal 层传入）；第 572 行 `group: ''` 改为 `group: input.group ?? ''` | 把分组写进 New API token |
| `src/features/newapi-bridge/server/portal.ts` `createPortalApiKey` | M | 入参公共字段为 **`groupSlug`**；**服务端**按 slug 查 `catalogGroup` 解析内部 `id` + `newapiGroup`，校验 `status=active ∧ allowCreateKey=true`（否则拒绝）；把 `newapiGroup` 传 `client.createKey({ group })`；**只把内部 `id` 写 `newApiKeyBinding.groupId`**（+ 可选 `newapiGroup` 快照）。解析与落库在同一流程内（见 D5/§6.1）| 服务端 slug→id 解析、落库内部 id、路由 group（F1）|
| `src/app/api/apipool/keys/route.ts` | M | 透传 **`groupSlug`** 给 `createPortalApiKey`；本层只做 slug 存在性/格式浅校验，分组 active/allowCreateKey 的权威校验在 portal 服务层（避免重复查库）；未知 slug / disabled / allowCreateKey=false 均返回明确错误 | 入参校验（slug，不收 id）|
| `src/features/api-console/components/api-key-manager.tsx` | M | 建 Key 表单加「分组」下拉，**option value=`slug`**（label=`name`，server 传入 `getGroupsForKeyCreation()` 结果，**不含 id/newapiGroup**）；选分组后展示「该分组可调模型范围」（展示性，来自 `getCallableListingsByGroup(slug)`）；列表加「分组」列（展示门户分组 `name`，来自 binding.groupId join 或 newapiGroup 快照对应门户名）| U6、建 Key 展示模型范围、列表分组列、下拉用 slug（F1）|
| `src/app/[locale]/(landing)/dashboard/api-keys/page.tsx` | M | server 侧取 `getGroupsForKeyCreation()`（slug/name/desc）传给组件；列表数据 join 分组名（server 侧 binding.groupId→门户 name，不下发 id 到 client） | server/client 边界：分组列表在 server 取，下拉在 client 用 slug 选 |

### 5.5 后台模型目录 CRUD（仿 admin/roles）

| 文件 / 模块 | 类型 | 改什么 | 为什么 |
|---|---|---|---|
| `src/app/[locale]/(admin)/admin/catalog/vendors/page.tsx` + `[id]/edit` + `new` | N | `TableCard` 列表 + `FormCard` 编辑/新增（`'use server'` handler 调 `catalog-service`）| 供应商 CRUD（A1）|
| `.../catalog/capabilities/*` | N | 同上，能力字典 CRUD | A1 |
| `.../catalog/statuses/*` | N | 同上，状态字典 CRUD（含 isCallable/isPublicVisible switch 字段）| A1、D3 |
| `.../catalog/groups/*` | N | 同上，分组 CRUD（含 `newapiGroup`、`userDescription`、`allowCreateKey`、`sortOrder`、`status`）| A1、A3、D5 |
| `.../catalog/models/*` | N | 模型本体 CRUD（modelId/displayName/vendor/contextWindow + 能力多选）| A1 |
| `.../catalog/models/[id]/listings/*` | N | 某模型的分组售卖项子表 CRUD（group/价/划线价/状态/折扣说明/描述/smokeTested）——「按供应商+分组添加模型 ID 并配独立价」| A2、A4、A5、D4 |
| `src/app/[locale]/(admin)/admin/categories/page.tsx` | M/D | 当前是 redirect 桩；改为 redirect 到 `/admin/catalog/models` 或直接弃用 | 给目录管理一个入口 |
| `src/config/locale/messages/{en,zh}/admin/sidebar.json` | M | 加「Model Catalog」菜单组（Vendors/Groups/Capabilities/Statuses/Models）| 菜单可达 |
| `src/config/locale/messages/{en,zh}/settings/catalog.json`（或 admin 下）| N | CRUD 页字段 label、状态/能力动态 label 的 en/zh 文案 | i18n |

### 5.6 权限

| 文件 / 模块 | 类型 | 改什么 | 为什么 |
|---|---|---|---|
| `src/core/rbac/permission.ts` | M | 加 `CATALOG_READ:'admin.catalog.read'`、`CATALOG_WRITE:'admin.catalog.write'`（按现有 read/write/delete 范式，必要时加 DELETE）| confirmed §0.2 CATALOG 权限 |
| `scripts/init-rbac.ts` | M | `defaultPermissions` 加 CATALOG 权限；授权给 admin/super-admin 角色（通配符 `admin.catalog.*` 或显式）| 授权 admin |
| 各 catalog admin 页 | — | 页首 `requirePermission({ code: PERMISSIONS.CATALOG_READ/WRITE })`（仿 roles 页）| 权限边界 |

### 5.7 登录增强（接回设置页）

| 文件 / 模块 | 类型 | 改什么 | 为什么 |
|---|---|---|---|
| `src/app/[locale]/(admin)/admin/settings/[tab]/page.tsx` | M | 删 redirect；改为：`requirePermission(SETTINGS read)` → `getSettingTabs()` + `getSettings()` 过滤当前 `tab` → 渲染 `FormCard`（分组 SettingGroup），`submit.handler` `'use server'` 调 `saveConfigs()`（已 `revalidateTag('configs')`）；至少保 `auth`、`email` 两 tab | U1/U2/A6、§3.5 接回 |
| `src/config/locale/messages/{en,zh}/admin/sidebar.json` | M | 加「Settings」菜单（指向 `/admin/settings/auth` 等）| 设置页可达 |
| `src/config/locale/messages/{en,zh}/admin/settings.json`（如缺）| N/M | 设置页 tab/group/字段 label 文案 | i18n |
| （配置项）| — | 无需新增字段：`google_client_id/secret`、`github_client_id/secret`、`email_verification_enabled`、`resend_api_key`、`resend_sender_email` 已在 `settings.ts`（§3.5）| 复用 |

### 5.8 支付展示补缺口

| 文件 / 模块 | 类型 | 改什么 | 为什么 |
|---|---|---|---|
| `src/features/newapi-bridge/server/portal.ts` | M | **新增只读投影 `listBillingLedgerEntries(portalUserId)`**（F2）：在现有 `listLedgerEntries` 基础上 join `order`（`ledger.orderNo = order.orderNo`），返回 `ledger.orderNo`、`order.status/paymentProvider/paidAt`、`ledger.status`、`amountUsd`、`createdAt`。可 join 或按 orderNo 批量查 order。**不改 `toPublicLedgerEntry`**（保持消费页等其他调用方契约），新增独立投影函数 | 充值记录需 order 支付状态，现有 ledger 投影无 orderNo（F2）|
| `src/app/[locale]/(landing)/dashboard/billing/page.tsx` | M | 充值历史取数改用 `listBillingLedgerEntries(user.id)`；表由 4 列扩为：订单时间(`createdAt`)/金额(`formatUsdAmount(amountUsd)`，**amountUsd 已是美元数值，5=$5，直接格式化，不再 /100**，F2)/支付状态(`order.status`: paid→已支付 等)/到账状态(`ledger.status`: applied→已到账 / pending→到账处理中 / failed→到账失败)；新增「到账处理中」可视状态（§3.4 现仅 applied/pending 映射）；接回设置页后 stripe/creem/paypal 密钥可填 | U4、A7、docs/08 2.2 |
| `src/app/[locale]/(landing)/dashboard/*`（余额不足提示）| M | 当 `balanceUsd <= 阈值`（如 0 或可配小额）时，在概览/建 Key/调用相关位置展示「余额不足，请充值」提示 + 充值入口 | docs/08 2.2 余额不足提示 |
| `src/config/locale/messages/{en,zh}/settings/billing.json` | M | 加「到账处理中/到账失败/余额不足」文案（en/zh）| i18n |

### 5.9 管理员额度运营（补只读视图）

| 文件 / 模块 | 类型 | 改什么 | 为什么 |
|---|---|---|---|
| `src/app/[locale]/(admin)/admin/users/[id]/detail/page.tsx`（或 `[id]/page.tsx`）| N | 只读聚合页：余额/额度（`getPortalUsage`）、最近用量（同源 summary + logs）、用户 API Key 列表（查 `newApiKeyBinding` by portalUserId）、额度调整历史（查 `apipoolLedgerEntry` source=manual_adjustment by portalUserId，join operator）；权限 `requirePermission(USERS_READ + APIPOOL_QUOTA_ADJUST 读)` | A8/A9、docs/08 3.2 用户与异常处理 |
| `src/features/newapi-bridge/server/portal.ts` | M（按需）| 若无现成「by portalUserId 列 Key/列 ledger」函数，新增只读查询 `listKeysByPortalUser`、`listAdjustmentLedgerByPortalUser`（admin 用，走 binding 凭据或本地 DB）| 聚合视图数据源 |
| `src/app/[locale]/(admin)/admin/users/page.tsx` | M | action 增「查看详情」跳 `/admin/users/[id]/detail`（现仅 edit/edit-roles/adjust-quota :115-129）| 入口 |
| `quota-adjustment-form.tsx` / adjust 页 | —/M | 沿用；可在详情页内嵌或链接现有 `/admin/apipool-adjustments` | 复用 |

---

## 6. 数据结构 / API / 状态流变化

### 6.1 数据结构（新增表，DDL 草图，sqlite 方言）

> 仅设计草图说明结构，非可运行迁移。命名/类型遵循 §3.2 范式：`text('id').primaryKey()`、`integer(.., {mode:'boolean'})`、`integer(.., {mode:'timestamp_ms'}).default(sqliteNowMs)`、`getUuid()` 应用层生成、FK `.references(...)`。价格 integer = micro-USD/1M（D1）。

**catalog_vendor（供应商）**
```
id            text PK                       -- getUuid()
slug          text unique not null          -- 'openai' 稳定标识
name          text not null                 -- 'OpenAI' 展示名
sortOrder     integer not null default 0
status        text not null default 'active'-- active|disabled（启用/禁用）
createdAt/updatedAt  timestamp_ms
index: idx_catalog_vendor_status (status)
```

**catalog_capability（能力字典）**
```
id            text PK
slug          text unique not null          -- 'text'|'vision'|'video'|'audio'
name          text not null                 -- 展示名（i18n key 或直存，见 §8）
sortOrder     integer not null default 0
status        text not null default 'active'
createdAt/updatedAt
```

**catalog_status（状态字典 + 行为标志，D3）**
```
id              text PK
slug            text unique not null         -- 'available'|'coming_soon'|'retired'
name            text not null                -- 展示名
isCallable      integer{boolean} not null default 0   -- 允许建 Key 后调用
isPublicVisible integer{boolean} not null default 1   -- /models 默认展示
sortOrder       integer not null default 0
status          text not null default 'active' -- 字典项自身启用/禁用
createdAt/updatedAt
```

**catalog_group（分组，D5）**
```
id              text PK
slug            text unique not null         -- 'official'|'deal-1'... 门户侧标识
name            text not null                -- 用户可见分组名
userDescription text                         -- 用户可理解说明（official=稳定路线…）
newapiGroup     text not null default ''     -- ← 门户↔New API group 映射（仅服务端/admin 可见）
allowCreateKey  integer{boolean} not null default 1  -- 是否允许用户建 Key
sortOrder       integer not null default 0
status          text not null default 'active' -- 分组启用/禁用（下线分组 = disabled）
createdAt/updatedAt
index: idx_catalog_group_status (status)
```

**catalog_model（模型本体，D4）**
```
id            text PK
modelId       text unique not null          -- 'gpt-4o-mini' 全局模型标识
displayName   text not null
vendorId      text not null FK→catalog_vendor(id)
category      text not null default 'llm'
contextWindow integer
createdAt/updatedAt
index: idx_catalog_model_vendor (vendorId)
```

**catalog_model_capability（模型↔能力 多对多，D2）**
```
id            text PK
modelId       text not null FK→catalog_model(id) on delete cascade
capabilityId  text not null FK→catalog_capability(id) on delete cascade
uniqueIndex: uniq_catalog_model_capability (modelId, capabilityId)
index: idx_cmc_capability (capabilityId)   -- 按能力反查模型（筛选）
```

**catalog_model_listing（分组售卖项，D1+D4 —— /models 行粒度）**
```
id                text PK
modelId           text not null FK→catalog_model(id) on delete cascade
groupId           text not null FK→catalog_group(id) on delete cascade
statusId          text not null FK→catalog_status(id)
inputMicroUsd     integer not null            -- 价 ×1e6/1M tokens
outputMicroUsd    integer not null
listInputMicroUsd  integer                     -- 划线原价（可空，折扣展示）
listOutputMicroUsd integer
discountNote      text                         -- 折扣/有效期说明（展示性）
description       text                         -- 该售卖项用户可见说明
smokeTested       integer{boolean} not null default 0  -- 真实调用验证标记
featured          integer{boolean} not null default 0
sortOrder         integer not null default 0
createdAt/updatedAt
uniqueIndex: uniq_listing_model_group (modelId, groupId)   -- 同模型同分组唯一
index: idx_listing_group (groupId)
index: idx_listing_status (statusId)
```

**newApiKeyBinding 变更（§5.4）**
```
+ groupId      text  FK→catalog_group(id)   -- 内部 id（服务端按 groupSlug 解析后写入，不来自浏览器）；可空仅为加列迁移零摩擦 + 建 Key 中间态防御（无历史无分组 Key，Q-E 已决；建 Key 必选分组恒有值）；on delete set null/restrict
+ newapiGroup  text  default ''             -- 可选：建 Key 时分组 newapiGroup 的快照（防改名漂移）
index: 可加 idx_newapi_key_binding_group (groupId)
```
> 注（F1）：`groupId` 存内部 id 仅用于服务端 join 展示门户分组名；**不下发浏览器、不出现在公共 API 响应**。建 Key 入参与下拉 value 一律用 `groupSlug`。

**约束/索引设计理由**：
- `(modelId, groupId)` 唯一 → 防止同一售卖项重复，保证「一个模型在一个分组只有一行价」。
- 能力关联表 `(modelId, capabilityId)` 唯一 + capability 侧索引 → 支持「按能力筛选模型」高效反查（D2）。
- 所有字典表 `slug unique` → 供 seed `insert ... onConflictDoNothing` 按 slug 幂等命中（D9，非先查后插）。
- `status='active'/'disabled'` 文本 → 与现有 RoleStatus 文本枚举范式一致（§3.7 `getRoles` where status=ACTIVE）。

### 6.2 API / 服务层签名

**查询层 `api-catalog/server/queries.ts`（`'server-only'`，公共/建 Key 读）**
```ts
type ListingRow = {              // 公共展示形状，绝不含 newapiGroup
  modelId: string; displayName: string; vendorName: string;
  groupName: string; groupSlug: string;           // 门户分组（非 newapiGroup）
  capabilities: string[]; contextWindow: number | null;
  inputMicroUsd: number; outputMicroUsd: number;
  listInputMicroUsd?: number; listOutputMicroUsd?: number;
  discountNote?: string; description?: string;
  statusSlug: string; statusName: string; isCallable: boolean;
};
type FilterDimensions = {        // 四层筛选选项（控制台可配，来自 DB）
  vendors: { slug; name }[]; groups: { slug; name }[];
  capabilities: { slug; name }[]; statuses: { slug; name }[];
};
getPublicListings(filters: { vendor?; group?; capability?; status? }): Promise<ListingRow[]>;
  // 默认仅返回 isPublicVisible=true 的 listing；按四层过滤；按 sortOrder 排序
getFilterDimensions(): Promise<FilterDimensions>;
getCallableListingsByGroup(groupSlug: string): Promise<ListingRow[]>;
  // 建 Key 展示：该分组下 isCallable=true 的售卖项
getGroupsForKeyCreation(): Promise<{ slug; name; userDescription? }[]>;
  // 仅 status=active 且 allowCreateKey=true 的分组；不含 id、不含 newapiGroup（F1）
// 全部用 unstable_cache + tag 'catalog'；admin 写后 revalidateTag('catalog')
```

**CRUD 服务层 `api-catalog/server/catalog-service.ts`（仿 `rbac.ts`）**
```ts
// 每个实体一组（vendor/capability/status/group/model/listing）：
getVendors() / getVendorById(id) / createVendor(data) / updateVendor(id, patch) / deleteVendor(id)
... 同构 capability / status / group / model
getListingsByModel(modelId) / createListing(data) / updateListing(id, patch) / deleteListing(id)
setModelCapabilities(modelId, capabilityIds[])   // 关联表先删后插（仿 init-rbac role↔perm）
// 读 newapiGroup 仅此层与 admin 页可见
getGroupNewapiMapping(groupId): Promise<string>  // 建 Key 服务调
```

**建 Key 相关签名变更（F1：公共入参用 groupSlug，内部 id 不外泄）**
```ts
// key-input.ts —— 用户输入用 slug，不暴露内部 id
sanitizePortalApiKeyCreateInput(body):
  { name: string; groupSlug: string }    // groupSlug 必填校验；移除写死 allowedModels；不再依赖 getDefaultCallableModelId
// client.ts createKey 入参 —— group 此处已是解析后的 newapiGroup 值
createKey(input: { user; remoteName; group?: string; quotaLimitUsd?; ipAllowlist? }): Promise<RemoteCreatedKey>
  // L572: group: input.group ?? ''
// portal.ts —— 服务端 slug→(id, newapiGroup) 解析在此完成
createPortalApiKey(user, input: { name; groupSlug }, client?):
  // 1) 按 groupSlug 查 catalogGroup → 拿内部 id + newapiGroup
  // 2) 校验 group.status=active ∧ allowCreateKey=true（否则拒绝，错误可见）
  // 3) client.createKey({ group: newapiGroup })
  // 4) 写 newApiKeyBinding.groupId = 内部 id (+ newapiGroup 快照)；浏览器侧从不接触内部 id
// 公共 API 响应（POST /api/apipool/keys 返回的 binding 视图）不含 catalog_group.id / newapiGroup
```

**设置页 server action（接回，复用现有）**
```
GET /admin/settings/[tab]  (RSC)
  → getSettingTabs() 校验 tab；getSettings() 过滤 tab；按 group 渲染 FormCard
  → submit.handler 'use server': saveConfigs(formData)  // 已 revalidateTag('configs')
// 无新 HTTP 路由；复用 settings.ts / config.ts（§3.5）
```

**管理员用户详情（只读聚合，RSC，无新写接口）**
```
GET /admin/users/[id]/detail (RSC)
  requirePermission(USERS_READ)
  → getPortalUsage(targetUser)          // 余额 + 用量
  → listKeysByPortalUser(id)            // 该用户 Key（newApiKeyBinding）
  → listAdjustmentLedgerByPortalUser(id)// 调额历史（apipoolLedgerEntry source=manual_adjustment）
// 调额仍走现有 POST /api/apipool/admin/adjust-quota（不变）
```

**充值记录展示（F2：新增只读投影 `listBillingLedgerEntries`，join order）**
```ts
// portal.ts 新增（不改 toPublicLedgerEntry，独立投影）
listBillingLedgerEntries(portalUserId): Promise<Array<{
  orderNo: string | null;
  amountUsd: number;            // 美元数值（5 表示 $5），非美分
  ledgerStatus: string;         // applied | pending | failed
  orderStatus: string | null;   // order.status: created | paid | failed
  paymentProvider: string | null;
  paidAt: number | null;        // order.paidAt (timestamp_ms)
  createdAt: number;            // ledger.createdAt
}>>
  // 实现：listLedgerEntries 基础上按 ledger.orderNo = order.orderNo join/批量查 order
// billing/page.tsx 展示映射：
  orderTime   = createdAt
  amount      = formatUsdAmount(amountUsd)          // 直接格式化，amountUsd 已是美元数；不再 /100
  payStatus   = orderStatus（paid→已支付 / created→待支付 / failed→支付失败 / null→无关联订单）
  applyStatus = ledgerStatus（applied→已到账 / pending→到账处理中 / failed→到账失败）
```

### 6.3 状态流

**模型售卖项状态（catalog_status 驱动，D3）**
```
管理员在 listing 选 statusId →
  available  (isCallable=1, isPublicVisible=1): /models 展示「可用」、建 Key 可选其模型、可调用
  coming_soon(isCallable=0, isPublicVisible=1): /models 展示「即将上线」、不进建 Key 可调列表、不可调用
  retired    (isCallable=0, isPublicVisible=0): /models 默认不展示；若被筛选/已有 Key 受影响 → dashboard/列表打「已下线」标注（confirmed Q3 降级，不做 Key 级分析）
切换由管理员在 CRUD 后台改 statusId 触发；/models 与建 Key 读 isCallable/isPublicVisible 标志位（非硬编码状态名）
```

**建 Key 状态流（沿用现有 status.ts，§3.3，新增分组绑定；F1：输入 slug、服务端解析 id）**
```
用户选分组(下拉 value=slug, 必填) + 输 name → POST /api/apipool/keys (body.groupSlug)
  服务端校验: 按 slug 查到 catalogGroup ∧ group.status=active ∧ group.allowCreateKey=1
            （未知 slug / disabled / allowCreateKey=0 → 拒绝；不阻塞于邮箱验证——confirmed Q3/U3）
  → createPortalApiKey: 解析得 内部 id + newapiGroup → client.createKey({ group: newapiGroup })
  → newApiKeyBinding: status creating_remote → (远端成功+本地保存) active / (失败) failed_*  [现有状态机]
  → 写 binding.groupId = 内部 id (+ newapiGroup 快照)；内部 id 不下发浏览器
列表展示分组列 = binding.groupId → catalogGroup.name（或 newapiGroup 快照对应的门户名）；响应不含 id/newapiGroup
```

**充值到账状态流（沿用现有 recharge.ts，§3.6，仅补展示）**
```
order CREATED/PENDING --payment success--> PAID --applyApipoolRecharge-->
  ledger.status: pending --executeRecharge 成功--> applied（到账）
                         --瞬时错误--> pending（到账处理中，待 retry）
                         --终态错误(unauthorized/forbidden/malformed)--> failed（到账失败，待运营）
dashboard 充值记录按 ledger.status 映射展示「到账/到账处理中/到账失败」
```

---

## 7. 兼容性与迁移风险

### 7.1 向后兼容

- **无历史无分组 Key（Q-E 已决，2026-06-24）**：项目尚未上线给用户、确认无存量旧 Key，故**无需历史 Key 兼容/回填**。建 Key 强制选分组（F9）→ 新建 Key 恒有 `groupId`。`newApiKeyBinding.groupId` 仍设为可空，但**仅为加列迁移零摩擦 + 建 Key 中间态（creating_remote）防御**，非为兼容历史数据。
- **旧客户端**：`/models` 与 dashboard 是 SSR 页面，无前端 API 契约破坏；建 Key 表单新增分组下拉是增量 UI。
- **`catalog.ts` 删硬编码的连带影响（已核对真实引用点，2026-06-24 grep）**：`publicModels` 与 `catalog.ts` 硬编码符号的**实际外部消费者只有两处**：
  1. `src/app/[locale]/(landing)/models/page.tsx`——import `publicModels` + `buildModelFilterHref` + `filterModels` + `parseModelFilters` + 3 个 `*_FILTERS` 常量 + `isDealModel`（:1-10、:50-51）。
  2. `src/features/api-console/lib/key-input.ts`——import `getDefaultCallableModelId`（:1、:19，§5.4 本就要去掉）。
  - **更正第一版表述**：`getFeaturedModels`、`getQuickstartCurl` 虽定义在 catalog.ts（:301、:339），但 **repo-wide grep 确认它们在 `src` 下无任何 import / 调用**（仅 catalog.ts 内部 default 参数自引用），**并非「被首页/quickstart 引用」**。因此删硬编码的真实兼容面比第一版判断**窄得多**，不是「最大兼容风险点」，但仍须按序迁移避免运行时空目录/报错。

### 7.2 迁移步骤（可分步）

1. **加表（非破坏）**：schema 增 7 表 + `newApiKeyBinding.groupId` 列；运行时 migrator（`deploy/entrypoint.sh` 沿用，§0.2）自动建表/加列。SQLite 加可空列安全。
2. **seed（幂等可重入）**：`init-catalog.ts` 用 `insert ... onConflictDoNothing` + 事务写首批数据（含 1 个 smokeTested listing 满足 confirmed §0.2），可重复运行、行数稳定不抛错（D9）。
3. **切数据源（按已核对的 2 个消费者灰度迁移，不一次性删硬编码）**：
   - 3a. 先建 `queries.ts`（DB 查询层）与硬编码**并存**，`publicModels` 暂留。
   - 3b. 迁 `models/page.tsx`：数据源 `publicModels` → `await getPublicListings(filters)`，筛选常量 → `getFilterDimensions()`；**删除独立 Deals 区与 `isDealModel`**（Q-B 已决）→ 统一单 listing 表、折扣行内 `discountNote`/划线价展示；跑 §10.1 F7/F8 测试通过。
   - 3c. 迁 `key-input.ts`：去掉 `getDefaultCallableModelId` 依赖（改为 `groupSlug` 必填、不写 allowedModels，§5.4）；跑 F9 测试通过。
   - 3d. 两消费者均迁完并测试通过后，**再删** `publicModels` 数组与无引用的 `getFeaturedModels`/`getQuickstartCurl`/`isDealModel`/`*_FILTERS`（或按 Q-C 保留 `publicModels` 作 seed 源 / 单测夹具，不再被运行时 import）。
   - 守护：删除前 grep 确认 `publicModels` 在 `src` 下零运行时引用，避免空目录/报错。
4. **接回设置页 / 补展示 / 用户详情页**：相互独立，可各自单独上线。

### 7.3 回滚 / 降级

- **回滚代码**：catalog 新表是新增，回滚到旧镜像后旧代码不读新表，表残留无害（SQLite 不删列亦无害）。`/models` 旧版仍读 `publicModels`（若该步未删硬编码则零风险；若已删，回滚需连带恢复硬编码——**建议保留 `publicModels` 作为种子/夹具直到稳定**，降低回滚成本，见 §11 Q-C）。
- **建 Key 降级**：若分组数据异常或 `newapiGroup` 配错导致建 Key 失败，现有 `status.ts` 失败态 + 错误消息（`getPublicPortalErrorMessage`）已覆盖；管理员可把分组 `newapiGroup` 改回 `''`（= 默认 group，等价现状）即时止血。
- **设置页降级**：接回后若 `FormCard` 渲染异常，可临时改回 redirect 桩（保留原桩代码片段于 git 历史）。
- **数据库备份**：上线走 `apipool-push-deploy` 流程（CLAUDE 记忆：GitHub Actions 自动备份 DB + 上一镜像，可快速回滚）。

---

## 8. 安全、性能、可维护性

### 8.1 安全

- **权限边界**：所有 `/admin/catalog/*`、`/admin/settings/*`、`/admin/users/[id]/detail` 页首 `requirePermission`（catalog 用新 `CATALOG_READ/WRITE`，设置用现有 SETTINGS 权限，用户详情用 `USERS_READ`）。CRUD 写操作在 `'use server'` handler 内二次校验（仿 roles edit `passby` 校验）。
- **公共页不暴露后台痕迹（硬约束）**：
  - `newapiGroup` 字段**仅** `catalog-service`/`queries` 内部与 admin 页可读；`ListingRow`/`getGroupsForKeyCreation` 返回类型**不含** `newapiGroup`（§6.2 类型即边界）。
  - 守护测试 `locale-copy.test.ts` 当前只扫 i18n seed + content，**现有黑名单 = `New API`/`newapi`/`bridge`/`internal service`（不含 `group`）**（§3.1）。**本设计要求**：① 分组/状态/能力的用户可见文案（若进 i18n seed）必须过现有黑名单；并**建议把 `group` 加入黑名单**（公共页不应出现后台网关术语）；② 建议**新增守护测试**断言 `getPublicListings`/`getFilterDimensions` 的输出 JSON 序列化不含 `newapiGroup`/`newapi` 字面（覆盖 DB 动态数据路径，弥补现有测试只扫静态文件的盲区）。
  - 用户可见的分组维度用门户 `name/slug/userDescription`，绝不用 `newapiGroup`。
- **输入校验**：价格输入（admin）校验为非负整数 micro-USD；modelId/slug 校验格式与唯一；建 Key `groupId` 校验存在 + active + allowCreateKey。
- **敏感数据**：`google_client_secret`、`resend_api_key`、`stripe_secret_key` 等不在 `publicSettingNames` 白名单（§3.5），仅服务端 `getAllConfigs()` 可读；设置页这些字段 type=password。
- **建 Key 不被邮箱验证阻塞**（U3/confirmed）：建 Key 路由不校验 `emailVerified`，仅校验登录态 + 分组合法。
- **多租户/越权**：用户详情聚合页是 admin 侧（已 requirePermission）；用户自身 dashboard 只读自己 binding（现有 `getUserInfo()` + portalUserId 绑定，不变）。

### 8.2 性能

- **`/models` 查询**：`getPublicListings` 是 listing join vendor/group/status/能力关联表。listing 数量级小（几十~几百），可一次查 + 内存聚合能力；用 `unstable_cache` + tag `catalog` 缓存，admin 改后 revalidate，命中后无 DB 访问。无 N+1（能力批量 join 或一次性 IN 查）。
- **筛选**：四层筛选用 DB where + 索引（group/status/capability 侧均有索引，§6.1），纯链接式 SSR 无客户端开销，沿用现状架构。
- **建 Key 展示模型范围**：`getCallableListingsByGroup` 单分组查询，走 `idx_listing_group`，量小。
- **用户详情聚合**：`getPortalUsage` 已有缓存快照（`usageSnapshot` 60s 锁，§3.4）；ledger/Key 查询走 `idx_apipool_ledger_portal_created`/`idx_newapi_key_binding_portal_status`（现有索引）。
- **并发/竞态**：seed `init-catalog` 用 `insert ... onConflictDoNothing` + 事务保证**幂等可重入**（D9），把幂等下沉 DB 唯一约束，重复执行行数稳定、不抛唯一冲突——**不采用 init-rbac 的「先查后插」**（该模式有查空窗口竞态，§3.7 已核对）。生产为单实例 compose 串行 seed，多进程并发非主要风险，但 `onConflictDoNothing` 同时覆盖该情形。catalog CRUD 写后 `revalidateTag('catalog')` 与 `config` 的 `revalidateTag('configs')` 同模式（§3.5），无新竞态。建 Key 幂等沿用 `idempotencyKey`（§3.3）。

### 8.3 可维护性 + 可观测性

- **复用范式**：CRUD 全仿 `admin/roles`（TableCard/FormCard/'use server'，零新组件）；服务层仿 `rbac.ts`；seed 仿 `init-rbac.ts`；权限仿现有常量。降低维护认知负担。
- **审计**：建 Key、调额、加额沿用 `newApiBridgeAuditLog` + `apipoolLedgerEntry`（§3.6），catalog CRUD 本身是低频管理操作，可选记入 audit（非必须）。
- **可定位**：建 Key 失败有 `lastRemoteError`（binding 列）+ 错误消息映射；充值到账失败有 ledger `status=failed` + audit `errorMessage`；这些已存在，用户详情页/billing 页把它们暴露给运营查看即满足「能处理异常」（A9、docs/08 3.2 异常处理 = 可见 + 复用 retry）。
- **i18n 漂移防护**：新增 en/zh 文案成对；现有 `locale-copy.test.ts` + 建议新增的 catalog 输出守护测试兜底。

---

## 9. 依赖与前置假设

### 9.1 依赖

- **New API（后台网关）**：建 Key 写 group 依赖 New API 侧已存在对应 group（`newapiGroup` 值）。**New API 无读接口**，管理员须在 New API 后台先建好 group、再在门户分组表填同名 `newapiGroup`（手动对齐，§0.2）。
- **Better Auth + Google/GitHub OAuth + Resend**：代码已就绪（§3.5），依赖管理员在设置页填入有效密钥；OAuth 回调 URL 需在 Google/GitHub 控制台配置为当前部署域名（现有 `client.ts` 注：portal auth 用 current origin，见 commit `925190c`）。
- **drizzle 运行时 migrator**：`deploy/entrypoint.sh`（§0.2），假设其会 apply 新表/新列。
- **现有支付 provider（stripe/creem/paypal）**：充值依赖其密钥配置 + webhook 可达。
- **现有 `getPortalUsage`/`adjustPortalQuota`/`applyRechargeForOrder`**：用户详情/充值展示直接复用。

### 9.2 前置假设（不成立会怎样）

| 假设 | 不成立的后果 | 缓解 |
|---|---|---|
| catalog 业务表只落 sqlite（D6，**已定稿 sqlite-only**）| 若未来切 pg/mysql，需补三方言表（独立大改）| 现状 bridge 表同样只 sqlite，本次范围生产仅 SQLite；单源守护测试防误补半套（§5.1/§10.1 F1）|
| 价格只展示不参与 SQL 计算（D1）| 若未来门户要算账，定点 integer 仍可（除 1e6）| micro 精度足够；真要算账用 BigInt |
| New API group 与门户 1:1（D5）| 若一个门户分组要对多 group，单字段不够 | 需求是 1:1（分组=渠道选择）；多对多是未来扩展 |
| 管理员会手动对齐门户分组与 New API group | 对齐错误 → 建 Key 路由到错/不存在的 group，调用失败 | 建 Key 失败有错误态可见；可加「测试该分组」按钮（非本次，§11）|
| 邮箱链接验证不阻塞建 Key（confirmed）| —（设计已遵守）| 路由不校验 emailVerified |
| 删 `publicModels` 后所有引用点已迁移（§7.1）| 漏改引用 → 首页/quickstart 运行时报错 | §11 Q-C 建议保留硬编码作种子直到全引用迁移并测试通过 |

---

## 10. 测试与验证计划

> **可验证性原则（第 1 轮 F4 修订）**：每个功能点三层验证（单元 / 功能集成端到端 / UI 交互；纯后端标 N/A）+ 失效路径。矩阵覆盖 confirmed §7 全部 18 条验收（U1–U9、A1–A9）。
>
> **测试栈现状（已核对）**：仅 `node:test`（`package.json:19` `tsx --test tests/**/*.test.ts`）+ 端到端脚本 `scripts/smoke-mvp.ts`（`package.json:20` `smoke:mvp`，已含 建 Key→真实 `/v1` 调用→用量可见 闭环）。**无 Playwright/Cypress/vitest-browser**。
>
> **不强制引入 Playwright**（属基础设施决策，易超 mvp 范围）。**但每条用户可见验收必须有至少一个可运行断言兜底**，不接受「仅人工走查」。三类可运行兜底：
> 1. **服务层 / 数据投影单测**（`node:test` + mock `db()`）：如 `getPublicListings`/`getGroupsForKeyCreation`/`listBillingLedgerEntries`/`sanitizePortalApiKeyCreateInput` 的输入→输出与拒绝分支。
> 2. **组件 props / 渲染行为守护**（`node:test`，对组件做纯函数式断言或 RSC props 契约断言）：如「建 Key 下拉 option value=slug、payload 不含 id」「billing 表渲染 4 列且状态映射正确」「余额≤阈值时提示分支为真」——断言**组件接收/产出的数据契约**与**纯展示逻辑**，不依赖浏览器。
> 3. **端到端 `scripts/smoke-mvp.ts` 扩展**：把「建 Key 选分组（传 groupSlug）→ 真实调用 → 用量可见」纳入既有闭环。
>
> **人工走查降为补充**（非主要兜底），仅覆盖纯视觉/交互细节（见 §10.3 明确清单）。若某流确属非浏览器自动化不可覆盖，可**提议引入 Playwright 并标为条件项**（开发中跟踪，非默认）。

### 10.1 功能 × 验证矩阵

| # | 功能点 | 验收标准（怎样算对）| 单元测试（函数/分支 → 输入/输出）| 功能测试（集成/端到端）| UI 交互测试 | 失效路径验证 |
|---|---|---|---|---|---|---|
| F1 | 模型目录建表 + seed（A1 数据地基）| 迁移后 7 表存在；seed 幂等可重入产出首批供应商/能力/状态/≥1分组/≥1模型/≥1 listing(smokeTested) | `init-catalog` 幂等（D9 `onConflictDoNothing`）：连跑 2 次行数稳定不变、不抛错；slug 冲突由 DB 唯一约束吸收 | 跑 migrator + seed，查 DB 各表非空、唯一约束生效；**并发用例（补充）**：`Promise.all([initCatalog(), initCatalog()])` 后行数稳定且不抛唯一冲突（注：单实例 compose 部署下并发非主风险，重点是幂等可重入）| N/A | seed 中途失败可重入；`schema.postgres/mysql.ts` 不含 `catalog_` 表（D6 单源守护测试）|
| F2 | 供应商 CRUD（A1）| admin 新增/编辑/禁用供应商，`/models` 供应商筛选反映 | `createVendor/updateVendor` 服务层：输入→DB 行；禁用置 status=disabled | admin 建供应商→`getFilterDimensions` 含之→`/models` 供应商筛选出现 | 列表 TableCard 显示；FormCard 提交后回跳列表；禁用后筛选不出现 | 重复 slug 拒绝；无权限 403 |
| F3 | 能力 CRUD + 模型打标（A1）| 新增能力字典；模型可多选能力；`/models` 能力筛选反映 | `setModelCapabilities` 先删后插：给定 ids→关联表精确匹配；空 ids→清空 | admin 建能力→给模型打标→`/models` 按能力筛选命中该模型 | 模型表单能力多选；能力筛选链接生效 | 删能力时关联级联（cascade）；打不存在能力 id 被 FK 拒 |
| F4 | 状态字典 + 行为标志（A1, A4, A5）| 状态可配；isCallable/isPublicVisible 驱动展示与调用 | `getPublicListings` 仅返回 isPublicVisible=true；建 Key 可调列表仅 isCallable=true | 把某 listing 从 coming_soon 改 available→`/models` 状态变「可用」且进建 Key 可调列表 | 状态字段含 isCallable/isPublicVisible switch；切换后 `/models` 标注变化 | 改成 retired→`/models` 默认不展示；已有 Key 受影响处打「已下线」标注 |
| F5 | 分组 CRUD + newapiGroup 映射（A1, A3）| 分组含 name/userDescription/newapiGroup/allowCreateKey；映射可配 | `createGroup/updateGroup`：newapiGroup 落库；`getGroupNewapiMapping` 返回该值 | admin 配分组 newapiGroup→建 Key 时 `client.createKey` 收到该 group | 分组表单含 newapiGroup（admin 可见）；allowCreateKey switch | 分组 disabled 或 allowCreateKey=0→建 Key 拒绝 |
| F6 | 同 modelId 跨分组多售卖项（A2）| 同一 modelId 在不同分组出现、配不同价 | `(modelId,groupId)` 唯一：同组重复插被拒；不同组允许 | 给同 modelId 在 official/deal-1 各建 listing 配不同价→`/models` 两行不同价 | listing 子表 CRUD；`/models` 同模型多行、分组列不同、价不同 | 同模型同分组重复 listing 唯一约束拒绝 |
| F7 | `/models` 四层筛选（U5）| 出现供应商/分组/能力/状态四组链接筛选，选项来自 DB，≥1 可用模型可见 | `getFilterDimensions` 聚合四维选项；`getPublicListings(filters)` 按四层过滤 | 访问 `/models?group=official&status=available`→只返回匹配 listing；含 ≥1 可用模型 | 四组筛选链接渲染（纯 `<Link>` 无 client JS）；点击切换 URL 与结果；空结果有「无匹配」态 | 非法筛选参数回退默认；DB 无可用模型时空态文案 |
| F8 | 公共页不暴露后台痕迹（架构约束）| `/models`、建 Key 展示不含 New API/newapi/group/bridge | `ListingRow`/`getGroupsForKeyCreation` 类型不含 newapiGroup（编译期）| 新增守护测试：`getPublicListings` 输出 JSON 不含 `newapi`/`newapiGroup` 字面；`locale-copy.test` 黑名单通过 | 页面文案、分组维度用门户名；DOM 无 newapiGroup | 即使 DB 误填含敏感词的门户 name，守护测试告警（建议扩展）|
| F9 | 建 Key 选分组（U6）| 建 Key 必选分组；不选拒绝；选后 token group 非空；**响应不暴露内部 id/newapiGroup** | `sanitizePortalApiKeyCreateInput`：缺 `groupSlug`→校验错误；有→返回 `{name,groupSlug}`；`getGroupsForKeyCreation` 输出不含 id/newapiGroup | 选分组建 Key（POST groupSlug）→服务端 slug 解析内部 id + newapiGroup→`newApiKeyBinding.groupId`=内部 id 落库 + `client.createKey({group:newapiGroup})`；断言响应 payload 无 `id/newapiGroup`（`smoke:mvp` 扩展 + 服务层单测）| 建 Key 表单分组下拉（option value=slug，必选）；未选禁用提交/报错 | 未知 slug / disabled 分组 / allowCreateKey=false → 均拒绝；New API group 不存在→建 Key 失败态可见 |
| F10 | 建 Key 展示该分组可调模型范围（docs/08 2.2）| 选分组后列出该分组当前可调模型（展示性，不写 token）| `getCallableListingsByGroup(slug)`：返回该组 isCallable=true 模型 | 选 official→展示其 available 模型列表；切分组→列表更新 | 选分组后区域展示模型范围；空分组提示「暂无可调模型」 | 分组无可调模型→展示空态而非报错 |
| F11 | 复制 Key 并真实调用成功（U7）| 完整 key 一次性展示可复制；用该 key + 分组路由真实调用 ≥1 模型成功 | （沿用）`createKey` 返回 fullKey；maskKey 正确 | **`scripts/smoke-mvp.ts` 扩展**（已有 建 Key→`/v1` 调用→用量闭环，:257/:177/:138）：建 Key 改传 `groupSlug`→真实 group 路由调用→200 | 「Full key shown once」展示 + 复制按钮；复制成功反馈 | New API 拒绝（group/quota）→调用方收错误；门户不在推理路径 |
| F12 | 调用后 dashboard 看到余额减少与用量（U8）| 调用后概览余额↓、用量记录出现该次调用 | `getPortalUsage`/`getUsageSummary`：聚合空+日志非空时用日志兜底（现有 client.ts:681-693）| 调用后刷新 dashboard→Balance↓、Usage 列出该模型记录 | 概览 StatCard + Usage 表展示；手动刷新按钮（不做轮询）| New API 聚合延迟→日志兜底；快照 stale→展示 stale 标记 |
| F13 | 余额不足提示（docs/08 2.2）| 余额 ≤ 阈值时明确提示 + 充值入口 | 阈值判断函数：balanceUsd≤0→提示 true | 余额耗尽→dashboard 显示「余额不足，请充值」+ Add credit | 提示横幅/卡片渲染；点击跳 billing | 余额数据获取失败→不误报（fallback 不显示或显示同步异常）|
| F14 | Key 列表分组列（docs/08 2.2）| Key 列表展示所属分组 | binding→groupName 映射：groupId→分组名（建 Key 必选分组、恒有值）| 列表渲染分组列，各行显示分组名 | 表头「分组」列；各行显示 | groupId 指向**已删分组**→显快照 newapiGroup 对应门户名或「—」（注：无历史无分组 Key，Q-E）|
| F15 | 禁用 Key 后不能调用（U9）| 禁用后该 key 调用被拒 | （沿用）`canDisableKeyStatus`=active；状态机 active→disable_pending→disabled | 禁用 Key→New API 侧 status=disabled→`curl` 该 key→拒绝 | Disable 按钮（仅 active 可见）；禁用后状态变「disabled」| 禁用请求失败→保留 active + 错误提示 |
| F16 | Google 登录（U1）| 配置后可用 Google 登录 | （沿用）config.ts 条件装载：有 client_id/secret→provider.google 存在 | 设置页填 Google 密钥→保存→登录页点 Google→OAuth→登录成功 | 登录页 Google 按钮（google_auth_enabled）；popup 流 | 密钥缺失→按钮不显示/登录报错；回调域名不匹配→OAuth 错误 |
| F17 | GitHub 登录（U1）| 配置后可用 GitHub 登录 | （沿用）有 github client_id/secret→provider.github 存在 | 设置页填 GitHub 密钥→登录页点 GitHub→登录成功 | GitHub 按钮（github_auth_enabled）；popup 流 | 同 F16 |
| F18 | 邮箱注册 + 收到验证链接（U1, U2）| 邮箱注册成功；启用验证时收到链接邮件 | （沿用）`emailVerificationEnabled = email_verification_enabled==='true' && resend_api_key`；60s 频限分支 | 启用验证 + 填 Resend→注册→收到含 24h 链接的邮件→点链接验证 | 注册表单；验证提示（sign-up:204-208）；verify-email 页重发 60s 冷却 | Resend 未配→验证关闭仍可注册；60s 内重发被频限 |
| F19 | 已登录建 Key 不被邮箱未验证阻止（U3）| emailVerified=false 仍能建 Key | 建 Key 路由分支：不读 emailVerified | 未验证邮箱用户登录→建 Key→成功 | 建 Key 流程无「需先验证邮箱」拦截 | 即使验证开启，建 Key 不受影响 |
| F20 | 接回设置页（A6）| admin 能在 auth/email tab 填密钥并保存生效 | `node:test`：`getSettings()` 按 tab 过滤返回正确字段集；`saveConfigs` upsert 后 `getAllConfigs` 读到新值（mock db）；空值不覆盖 env 优先级分支（§3.5）| 改 redirect 桩为 FormCard→`saveConfigs`→`getAllConfigs` 读到新值→登录/邮件按 config 动态装载（§3.5）生效 | 设置页 tab 渲染（FormCard/SettingGroup）；password 字段掩码；保存 toast | 无权限 403；保存失败提示；空值不覆盖 env 优先级 |
| F21 | 在线充值看到余额变化（U4, A7）| 充值后余额可见变化；记录展示订单时间/金额/支付状态/到账状态/到账处理中 | `node:test`：`listBillingLedgerEntries` join order 返回 `orderNo/orderStatus/paymentProvider/paidAt/ledgerStatus/amountUsd`（mock db）；展示映射 `(orderStatus,ledgerStatus)→文案` 全分支；**`amountUsd=5 → "$5.00…"`，不被 ×100**（F2 单位）| 充值→webhook→ledger applied→`listBillingLedgerEntries` 关联到 PAID order→dashboard 余额↑、充值记录全字段展示 | billing 充值记录新列（订单时间/金额/支付状态/到账状态）；processing 态可视 | webhook 重发不重复入账（transactionId 幂等）；到账瞬时失败→「到账处理中」；终态→「到账失败」；ledger 无 orderNo（手工调额条目）→支付状态列空而非报错 |
| F22 | 管理员调额增/减（A8）| admin 可增可减用户额度，记录操作人/金额/原因/时间 | （沿用）adjust-quota 校验 amountUsd 非零可负 + reason 必填；`adjustPortalQuota` 写 ledger source=manual_adjustment + audit | admin 调额→ledger 增/减条目 + audit log→用户 dashboard 余额变化 | quota-adjustment-form：金额（可负）/原因；提交反馈 | 缺 reason/零额度→拒绝；New API 失败→audit failed + 错误返回 |
| F23 | 用户详情聚合只读视图（A9）| admin 查看用户余额/用量/Key/调额历史 | `listKeysByPortalUser`/`listAdjustmentLedgerByPortalUser`：by portalUserId 返回正确集 | 访问 `/admin/users/[id]/detail`→余额+用量+Key 列表+调额历史齐 | 详情页四区块渲染；从用户列表「查看详情」进入 | 用户无 binding→余额区显空/未初始化；查询失败优雅降级 |
| F24 | 下线模型/分组用户侧看到状态（A5）| 下线 listing/分组后用户侧明确状态 | 分组 status=disabled→不进 `getGroupsForKeyCreation`；listing retired→isPublicVisible=0 | 下线分组→建 Key 下拉无该组；下线模型→`/models` 默认不显，受影响处标注 | 建 Key 下拉不含已下线分组；`/models` 已下线标注/不展示 | 已绑定该（被下线）分组的 Key 仍在列表显分组名 + 「已下线」标注（不做 Key 级精确分析，Q3）|

### 10.2 验收 → 功能点映射（确认 18 条全覆盖）

| 验收 | 覆盖功能点 | | 验收 | 覆盖功能点 |
|---|---|---|---|---|
| U1 Google/GitHub/邮箱登录 | F16, F17, F18 | | A1 新增供应商/分组/能力/模型 | F2, F3, F4, F5 |
| U2 邮箱收到验证链接 | F18 | | A2 同 modelId 不同分组不同价 | F6 |
| U3 建 Key 不被未验证阻止 | F19 | | A3 配置门户↔网关分组映射 | F5 |
| U4 在线充值看到余额变化 | F21 | | A4 即将上线改可用并可调 | F4 |
| U5 `/models` 找到 ≥1 可用模型 | F7 (+F1) | | A5 下线模型/分组看到状态 | F24, F4 |
| U6 选分组建 Key | F9 (+F5) | | A6 配置 Google/GitHub/邮箱验证 | F20 (+F16/17/18) |
| U7 复制 Key 真实调用成功 | F11 (+F10) | | A7 查看支付订单与到账状态 | F21 |
| U8 调用后看到余额减少与用量 | F12 | | A8 额度增加与扣减 | F22 |
| U9 禁用 Key 不能调用 | F15 | | A9 查看调额记录与用户用量 | F23 |

### 10.3 测试数据 / 环境 / 工具

- **夹具**：seed 首批数据（OpenAI/Anthropic/Google 供应商、text/vision/video/audio 能力、available/coming_soon/retired 状态、official 分组 newapiGroup 对齐烟测环境、1 个 smokeTested listing）。可保留旧 `publicModels` 作单测夹具（§11 Q-C）。
- **mock**：服务层单测 mock `db()`；建 Key 单测 mock `client.createKey` 断言收到的 `group`（= newapiGroup）；支付/加额沿用现有测试 mock New API；billing 投影单测 mock `db()` join order 返回。
- **环境**：单元/集成走 `node:test`（`npm test` → `tsx --test tests/**/*.test.ts`）+ SQLite 内存/临时库跑 migrator；端到端走 `npm run smoke:mvp`（`scripts/smoke-mvp.ts`，连真实 New API 烟测环境，confirmed §0.2 首批真实调用验证）。

- **UI 层验证策略（F4 修订）—— 关键用户可见流均有可运行兜底，人工走查仅补充**：

  | 用户可见流 | 可运行兜底（命令 + 断言）| 人工走查（补充，纯视觉/交互细节）|
  |---|---|---|
  | 建 Key 选分组（F9/F10）| ① `node:test`：`sanitizePortalApiKeyCreateInput` 缺 groupSlug→错、含→`{name,groupSlug}`；下拉 option 数据契约（value=slug、不含 id）。② `smoke:mvp` 扩展：传 `groupSlug` 建 Key→`client.createKey` 收到正确 `group`→真实调用 200。③ 响应 payload 断言不含 `id/newapiGroup`。| 下拉视觉、未选时提交按钮禁用态、空分组「暂无可调模型」文案位置 |
  | 设置页保存 OAuth/Resend（F20）| `node:test`：`getSettings()` 按 tab 过滤返回正确字段集；`saveConfigs` upsert 后 `getAllConfigs` 读到新值（mock db）；空值不覆盖 env 优先级分支。| FormCard tab 切换、password 字段掩码、保存成功 toast |
  | 充值记录状态列（F21/A7）| `node:test`：`listBillingLedgerEntries` join order 返回 orderNo/orderStatus/ledgerStatus/amountUsd（mock db）；展示映射函数 `(orderStatus,ledgerStatus)→文案` 全分支（含 processing/failed）；`amountUsd=5 → "$5.00…"` 不被 ×100。| 表格列对齐、processing 态颜色/图标 |
  | 余额不足提示（F13）| `node:test`：阈值判断 `balanceUsd<=阈值→true`；提示组件按该 prop 渲染/不渲染的契约断言。| 横幅位置、跳 billing 链接、视觉强调 |
  | `/models` 四层筛选（F7）| `node:test`：`getFilterDimensions` 四维选项、`getPublicListings(filters)` 过滤+排序、空结果态；`getPublicListings` 输出 JSON 不含 `newapi/newapiGroup`（F8）。| 四组链接渲染、选中态、移动端布局 |

- **明确的人工走查清单**（仅以下纯视觉/交互细节走查，每条记录一次；功能正确性已由上表可运行兜底覆盖）：
  1. 建 Key 流：下拉展开样式、必选校验提示文案、key「一次性展示 + 复制」反馈。
  2. 设置页：auth / email 两 tab 渲染、password 掩码、保存 toast。
  3. billing：充值记录四列视觉、「到账处理中」态可视化。
  4. dashboard：余额不足横幅、Key 列表分组列。
  5. `/models`：四层筛选链接交互、折扣行内展示（`discountNote`/划线价；Q-B 已决取消独立 Deals 区）。

- **条件项（默认不做）**：若评审认为上述 node:test + smoke 仍不足以覆盖某关键浏览器交互（如 OAuth popup 跨窗口回调），可提议引入 Playwright 写该单条 e2e，**标为开发中跟踪的条件项**，不阻塞冻结。

- **守护**：`locale-copy.test.ts`（扩展 + 新增 catalog 输出守护，F8）；新增 `catalog-schema-singlesource.test.ts`（D6 sqlite-only 守护）。

---

## 11. 未决问题

> 需用户/团队拍板或评审确认的取舍；及无法验证项。
>
> **更新（2026-06-24）**：原 GO with conditions 的 3 个待拍板取舍 Q-B / Q-D / Q-E 已由用户拍板落定（见下，均标「已决」并回填进相关小节）；Q-A 早前已决（sqlite-only）。仅余 Q-C 为开发中可定细节。**至此无阻塞项。**

- **~~Q-A（方言落点，关联 D6）~~ —— 已决（第 1 轮评审 F3=blocker 后 Orchestrator 拍板）**：catalog 表 **sqlite-only**，pg/mysql 不在 user-mvp 支持面；「三方言不漂移」= 类型从 sqlite barrel 单源推导、不分裂；守护见 D6（禁止 import pg/mysql catalog 表 + `catalog-schema-singlesource.test.ts` 断言）。confirmed §6「DB 方言策略」已落定稿条款。**不再上交。**
- **~~Q-B（Deals 区去留）~~ —— 已决（2026-06-24 用户拍板）：不保留独立 Deals 视觉分区**。`/models` 取消「标准模型表 + Deals 区」两块结构，统一为单一 listing 表；折扣完全由分组（如 official 分组 + 限时折扣分组）+ 行内 `discountNote`/划线价（`listInput/OutputMicroUsd`）表达。**删除 `channelTier`/`isDealModel` 概念**（迁移见 §7.2 step 3b、§5.3）。
- **Q-C（删硬编码 publicModels 的时机，关联 §7.1/§7.2/§7.3/§9.2）**：**事实更正**——repo-wide grep 确认 `catalog.ts` 硬编码符号的真实外部消费者只有 `models/page.tsx`（`publicModels` + 筛选常量 + `isDealModel`）与 `key-input.ts`（`getDefaultCallableModelId`）两处；`getFeaturedModels`/`getQuickstartCurl` 在 `src` 下**无任何引用**（第一版「被首页/quickstart 引用」表述有误，已在 §7.1 更正）。因此删硬编码风险面比第一版判断窄。**设计决策（不再纯未决）**：按 §7.2 step 3a–3d **灰度迁移**——先 DB 查询层与硬编码并存→逐个迁 `models/page.tsx`、`key-input.ts` 并测试通过→再删 `publicModels`（或保留作 seed 源/单测夹具，不再被运行时 import）。剩余可选项：`publicModels` 删除 vs 永久保留作夹具，倾向保留作夹具（零运行时引用即无害），此细节可在开发中定。
- **~~Q-D（分组↔group 连通性自检）~~ —— 已决（2026-06-24 用户拍板）：不做连通性自检**。心智模型确认：**门户分组只是逻辑/展示名称，真正的渠道分组在 New API 那一侧**，门户 `catalog_group.newapiGroup` 字段就是指向 New API 分组的引用；门户只需保证两侧存在映射关系，不验证连通性（管理员手动对齐，对齐错误由建 Key 失败态暴露——§9.2）。
- **~~Q-E（历史无分组 Key 展示）~~ —— 已决（2026-06-24 用户拍板）：场景不存在**。项目尚未上线给用户使用、**无历史无分组的旧 Key**，故无需历史 Key 兼容/迁移/展示文案设计；建 Key 强制选分组（F9）保证所有 Key 恒有分组（相关兼容论述已从 §7.1 删除）。
- **无法验证项**：暂无功能点被判定为不可验证。U7「真实调用成功」依赖连真实 New API 烟测环境（非纯本地可断言），已在 §10.3 标注为端到端需外部环境——这是「需要外部依赖」而非「设计缺陷导致不可验证」，故保留在矩阵 F11 而不移除。
