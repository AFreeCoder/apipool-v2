# user-mvp 现状调研摘要（阶段 0，客观代码事实）

> 由 4 个 Explore 子 Agent（very thorough）产出，已给 `文件:行` 指针。
> 这是**客观现状**，供 Author 写「当前系统现状」时核对（写前请抽查真实代码再下笔）。
> 其中「影响面/建议」仅供参考，**设计方案由 Author 自行从需求推导**。

## A. 模型目录 / 分组 / 价格（最大新建块）

- **完全硬编码、无 DB**：`src/features/api-catalog/lib/catalog.ts:3-34` 定义 `ApiModel` 类型；`:111-268` 硬编码 7 个模型（`publicModels: ApiModel[]`）。枚举：provider 仅 `'OpenAI'|'Anthropic'`（:3）、capability `'text'|'vision'|'reasoning'|'coding'`（:4）、status `'available'|'coming_soon'`（:5）、channelTier `'official'|'deal'`（:8）。
- **无分组（group）概念**；deal/正价靠 `channelTier` + `officialInput/OutputPerMillionUsd` 两条目表达。
- **`/models` 页**：`src/app/[locale]/(landing)/models/page.tsx` —— 已有**三层**筛选（provider/capability/status，`*_FILTERS` 常量，:51-63 of catalog.ts），**缺分组筛选**；数据源 = import 的硬编码 `publicModels`；纯链接式筛选（`buildModelFilterHref`，catalog.ts:94-109），无 client JS。
- **建 Key**：`src/features/api-console/lib/key-input.ts:10-21` `sanitizePortalApiKeyCreateInput` 写死返回 `[defaultCallableModelId]`、**无 group**；`src/features/newapi-bridge/server/client.ts:548-592` `createKey` 第 **572 行 `group: ''` 写死**；`portal.ts:385-537` `createPortalApiKey` 把 allowedModels 存 JSON；DB `newApiKeyBinding`（`schema.sqlite.ts:441-476`）有 `allowedModels` text 但**无 group/groupId 列**。
- **门户分组 ↔ New API group 映射**：当前**不存在**（group 恒为空，无映射表）。
- **后台 CRUD 范式（可复用，零新组件）**：`admin/roles/page.tsx`（列表 `TableCard`，:33-61）、`admin/roles/[id]/edit/page.tsx`（`FormCard` + `'use server'` handler，:53-90）；服务层 `src/shared/services/rbac.ts:45-96`（drizzle getX/createX/updateX/deleteX）。当前**无** models/vendors/groups/capabilities 管理页（`/admin/categories` 是 redirect 桩）。
- **schema 风格**：`schema.sqlite.ts` —— `text('id').primaryKey()`+`getUuid()`、`integer(..,{mode:'boolean'})`、`integer(..,{mode:'timestamp_ms'})`、FK + JSON text 列 + 索引注释（参考 :414-476 binding 表、:614-715 RBAC 多表 cascade）。RBAC 已有 DB+服务层成熟范式。
- **三方言**：schema 有 sqlite/postgres/mysql 三文件，需同步避免类型推导漂移。
- **权限/菜单**：`core/rbac/permission.ts` 加权限；`scripts/init-rbac.ts` `defaultPermissions` + 授权；`config/locale/messages/{en,zh}/admin/sidebar.json` 加菜单。
- **seed 范式**：`scripts/init-rbac.ts`（`loadSchemaTables()` 动态 import、`db()`、`getUuid()`、`onConflictDoNothing` 幂等）。

## B. 控制台 dashboard / 用量（大部分已实现）

- **路由**：`/dashboard`（`src/app/[locale]/(landing)/dashboard/page.tsx:27-159` 概览）、`/dashboard/api-keys`、`/dashboard/usage`、`/dashboard/billing`；tab 定义 `src/features/api-console/components/dashboard-shell.tsx:5-10`。
- **首页概览（已有）**：4 个 StatCard（Balance/Requests·7d/Tokens·7d/Key 数）、Base URL、Add credit/Create key 入口、近 8 条请求表。
- **余额/用量链路（已有）**：`getPortalUsage(user,'7d')`（`portal.ts:761-966`）并行调 New API：`getQuota`→`/api/user/self`（`client.ts:450-466`）、`getUsageSummary`→`/api/data/self`（`client.ts:644-715`，含按模型聚合 :654-693）、`listUsageLogs`→`/api/log/self`（`client.ts:717-722`）；缓存写 `usageSnapshot`（`schema.sqlite.ts:478-512`，syncing/ready/stale/failed，锁 TTL 60s）。`quotaToUsd`=quota/500000（`client.ts:222-224`）；`formatUsdAmount`（`lib/money.ts:3-10`）。
- **API Key 管理（已有）**：创建 `POST /api/apipool/keys`→`createPortalApiKey`（`portal.ts:385-537`），完整 key 一次性展示（`api-key-manager.tsx:185-205`）；列表字段 name/keyMasked/status/allowedModels/createdAt；复制/禁用（`keys/[id]/disable`）/删除（`keys/[id]`）；状态机 `lib/status.ts:1-83`。**创建不需选分组**（group 空）；列表**无分组列**。
- **充值入口（已有）**：billing 页 `<TopUpPackages>`（套餐来自 i18n `pricing.json`）→ `POST /api/payment/checkout`（`route.ts:22-306`）→ checkoutUrl 重定向；充值历史 + 消费记录已展示（`billing/page.tsx:94-193`）。
- **缺口**：余额不足提示（未实现）、调用后实时刷新（纯 SSR、无轮询，需手动刷新；且 New API `/api/data/self` 本身有延迟）、Key 分组列。

## C. 登录 / 鉴权 / 邮件 / 设置页（99% 就绪，缺设置页接回）

- **Better Auth**：`src/core/auth/config.ts` —— emailAndPassword 已启用（:64-66）；Google OAuth（:218-223，按 `google_client_id/secret` 动态装载）、GitHub OAuth（:226-231）**代码已就绪只差填密钥**；emailVerification 条件启用（`email_verification_enabled==='true' && resend_api_key`，:76-77）；`sendVerificationEmail` hook 已实现发链接（:169-201，含 60s 频限）。入口 `src/core/auth/index.ts:8-15` 运行时读 `getAllConfigs()`。
- **Resend（就绪）**：provider `src/extensions/email/resend.ts:24-110`；工厂 `src/shared/services/email.ts:7-40`（按 `resend_api_key` 动态注册）；验证邮件模板 `src/shared/blocks/email/verify-email.tsx:16-81`（链接验证、24h 过期）。`resend` 包已装。
- **登录/注册页 UI（全在）**：`sign-in.tsx`（邮箱+密码 :145-206、社交按钮 :208-213、LegalNotice :215）、`sign-up.tsx`（含邮箱验证提示 :204-208）、`social-providers.tsx`（Google :127-134 / GitHub :136-143，popup OAuth 流）、`verify-email.tsx`（轮询/重发/继续）。
- **⚠️ admin 设置页是 redirect 桩**：`src/app/[locale]/(admin)/admin/settings/[tab]/page.tsx:1-13` 直接 redirect 到 `/admin/apipool-adjustments`。原 ShipAny 设置页结构：tab（general/auth/payment/email/...）+ SettingGroup + Setting（type=text/password/switch/...）。设置项定义已在 `src/shared/services/settings.ts:278-970`（Google :405-419、GitHub :428-442、Resend/email tab 等），公开白名单 :942-958。
- **配置存储**：`config` 表 key-value（`schema.sqlite.ts:130-133`）；读 `src/shared/models/config.ts:104-135` `getAllConfigs()`（优先级：env 大写 > env 小写 > DB > envConfigs）；存 `:20-65` `saveConfigs()`（upsert + `revalidateTag`）。
- **接回设置页需要**：把 redirect 换回真实渲染（复用 `getSettings()/getSettingTabs()` + `FormCard` + `saveConfigs()`）；本次至少保证 email、auth 两个 tab 可用。

## D. 支付 / 额度 / 用户管理（大部分已实现，缺 admin 查看视图）

- **支付（已实现，三商）**：checkout `src/app/api/payment/checkout/route.ts:22-306`；webhook `src/app/api/payment/notify/[provider]/route.ts:18-237`（幂等 transactionId）；成功处理 `src/shared/services/payment.ts:150-301`（`handleCheckoutSuccess`，订单 CREATED→PAID，调 `applyApipoolRecharge` 但**绝不抛错** :165-166）；provider：stripe/creem/paypal（`src/extensions/payment/*`）。密钥从 `config` 表读（`stripe_secret_key`/`creem_api_key`/...）。
- **套餐**：硬编码 i18n `src/config/locale/messages/en/pages/pricing.json:4-54`（topup_5/10/50，字段 product_id/amount/currency/credits/...）。
- **加额执行器（幂等完善）**：`src/features/newapi-bridge/server/recharge.ts:136-195` `applyRechargeForOrder`（幂等键 `orderNo`，pending→applied/failed；终态 vs 瞬时错误分类 :104-129）；账本 `apipoolLedgerEntry`（`schema.sqlite.ts:545-581`：orderNo unique、newapiChangeId unique、status、operatorUserId、reason、source=recharge/manual_adjustment/api_usage）；webhook 重放自愈（`payment.ts:162-168`）。
- **retry/reconciliation（MVP 级已有）**：`POST /api/apipool/admin/recharge/retry`（按 orderNo）；`GET /api/apipool/admin/recharge/reconciliation`（扫近 100 条 PAID 交叉对账，固定 100 条上限）。
- **管理员额度调整（已有，缺历史视图）**：`POST /api/apipool/admin/adjust-quota`（portalUserId/amountUsd 可负/reason，权限 `APIPOOL_QUOTA_ADJUST`）→ `adjustPortalQuota`（`portal.ts:978-1065`，写 ledger source=manual_adjustment + audit log `newApiBridgeAuditLog` `schema.sqlite.ts:583-611`）；前端表单 `quota-adjustment-form.tsx:10-78`。**无独立「调整历史」视图**（需查 ledger 手工关联）。
- **用户管理（基础已有，缺额度/用量/Key 查看）**：`admin/users/page.tsx` 列表（id/name/email/roles/emailVerified/...，action 含 adjust-quota 跳转 :129）。**缺**：用户余额查询 API、用户用量查询、用户 API Key 查看、充值历史明细。
- **异常处理**：有 status 追踪（`lib/status.ts` failed_terminal/retriable）、retry API、错误消息转换（`lib/public-errors.ts`）；**无**统一异常面板/批量工具/告警（本次按澄清 Q4 不做）。
