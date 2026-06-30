# User MVP 逐行测试与实现确认报告

> 日期：2026-06-30  
> 输入文档：`docs/08-user-mvp-requirements.md`  
> 目标：按原文行号逐行核对 user-mvp 需求，确认本地可自动化验证的功能已实现，并标记必须依赖真实/沙箱外部环境的人工作业。  
> 说明：空行、标题、背景说明和代码块按相邻行段合并；每条有验收意义的需求按最小可验证行段记录。

## 1. 本轮执行结果

| 验证项 | 命令 | 结果 | 备注 |
| --- | --- | --- | --- |
| 全量自动化测试 | `npm.cmd test` | 通过 | 270/270 pass |
| TypeScript | `npm.cmd exec -- tsc --noEmit --pretty false` | 通过 | 无错误输出 |
| lint | `npm.cmd run lint` | 通过 | 0 errors，189 warnings；本轮修正 ESLint 忽略本地 `.tmp`/`tmp` 生成目录 |
| MVP smoke 脚本 | `npm.cmd run smoke:mvp` | 阻塞 | 当前 `.env.development` 包含 live smoke 变量，但 New API health fetch 失败；需启动/提供真实或等价 New API 环境 |
| production build | `npm.cmd run build` | 阻塞 | 受限网络下无法从 Google Fonts 拉取 `Geist`/`JetBrains Mono`；已请求联网重跑但审批系统拒绝 |

## 2. 逐行核对矩阵

状态含义：

- ✅ 已实现并由本地自动化/静态审查覆盖。
- 🟡 代码路径已实现，本地只能等价验证；真实外部依赖需人工/沙箱复验。
- ➖ 背景、标题、非目标或默认假设，不是单独功能测试点。
- ⛔ 本轮阻塞，不代表代码缺失，表示当前环境缺少必要外部服务或网络。

| 原文行号 | 核对内容 | 证据 | 状态 |
| --- | --- | --- | --- |
| L1-L12 | 文档状态、参考材料、以本需求为准 | 已读取 `06-payments-ledger.md`、`07-runbook.md`、`design/user-mvp/DESIGN.md`、`PLAN.md` 的相关实现边界；本报告以 `08-user-mvp-requirements.md` 为准 | ➖ |
| L16-L18 | MVP 是门户，不重做 New API 网关能力 | `tests/deploy/mvp-workflow.test.ts`、`tests/newapi-bridge/server-only.test.ts`、`tests/public-content/indexing.test.ts` 验证门户/New API 分工和非公开边界 | ✅ |
| L20-L22 | 用户最小闭环 | `tests/smoke/mvp-smoke-script.test.ts` 覆盖 DB catalog、Key、调额、调用、用量、禁用；真实 `npm.cmd run smoke:mvp` 当前因 New API 不可达阻塞 | 🟡/⛔ |
| L24-L31 | 六个核心范围 | 对应测试簇：`api-catalog`、`config`、`payments`、`newapi-bridge`、`api-console`、`smoke` 全量 270 项通过 | ✅ |
| L35-L37 | `/models` 展示模型、价格、分组、折扣、状态 | `tests/api-catalog/models-filter.test.ts`、`tests/api-catalog/queries.test.ts`、`tests/api-catalog/catalog.test.ts` | ✅ |
| L39-L45 | 供应商、分组、分类、能力、状态可配置筛选 | `tests/api-catalog/catalog-admin-pages.test.ts`、`tests/api-catalog/catalog-service.test.ts`、`tests/api-catalog/queries.test.ts` | ✅ |
| L49-L51 | 同模型 ID 可在不同分组作为独立售卖项 | `tests/api-catalog/catalog-service.test.ts` 覆盖 listing 唯一性；`tests/api-catalog/catalog-pricing.test.ts` 覆盖分组价格 | ✅ |
| L52 | 表格字段至少包含模型、供应商、分组、分类、能力、价格、折扣、状态 | `tests/api-catalog/queries.test.ts` 验证 public listing 输出字段；`src/app/[locale]/(landing)/models/page.tsx` 渲染这些字段 | ✅ |
| L53-L55 | 分组说明、折扣说明、划线价一致 | `tests/api-catalog/catalog-admin-pages.test.ts` 覆盖 group/listing 表单字段；`tests/api-catalog/catalog-pricing.test.ts` 覆盖价格格式 | ✅ |
| L56-L58 | 可用/即将上线/已下线的调用与展示边界 | `tests/api-catalog/queries.test.ts` 覆盖 public/callable 状态过滤、disabled 维度过滤、可建 Key 分组过滤 | ✅ |
| L59 | 普通用户不暴露 New API 后台名、入口、内部 ID、`newapiGroup` | `tests/api-catalog/queries.test.ts`、`tests/newapi-bridge/portal.test.ts`、`tests/api-console/key-input.test.ts` | ✅ |
| L61-L65 | 目录由 `/admin` 维护，首发至少 1 个供应商/分组/可用模型，后台 CRUD | `tests/db/init-catalog.test.ts`、`tests/api-catalog/catalog-admin-pages.test.ts`、`tests/api-catalog/catalog-service.test.ts` | ✅ |
| L67-L73 | Google、GitHub、邮箱登录方式 | `tests/config/auth-options.test.ts` 验证 OAuth/email 配置路径；真实 OAuth 需 Client 配置 | 🟡 |
| L75-L82 | 邮件链接验证、非验证码、Resend 管理配置、邮箱未验证不阻塞 Key | `tests/config/settings-page.test.ts`、`tests/api-console/key-creation-kill-switch.test.ts`、`tests/newapi-bridge/portal.test.ts` | ✅/🟡 |
| L83-L86 | 登录渠道不影响额度、价格、模型权益 | 权益由 portal user、catalog group、ledger 控制；无 provider 分支；`tests/newapi-bridge/portal.test.ts` 和 `tests/api-catalog/queries.test.ts` 覆盖 | ✅ |
| L88-L98 | `/dashboard` 首页余额、用量、API Base URL、入口、同步状态 | `tests/api-console/dashboard-auth.test.ts`、`tests/api-console/status.test.ts`、`tests/api-console/usage-page.test.ts`、`tests/api-console/balance-warning.test.ts` | ✅ |
| L100-L109 | API Key 创建必须选择 `groupSlug`、服务端映射 New API、只绑定用户+分组、完整 Key 只展示一次、失败可诊断清理 | `tests/api-console/key-input.test.ts`、`tests/api-console/api-key-manager.test.ts`、`tests/newapi-bridge/portal.test.ts`、`tests/newapi-bridge/client.test.ts` | ✅ |
| L111-L119 | 在线充值、余额可见、订单/支付/到账状态、到账处理中、失败提示、低余额、管理员调额后可见 | `tests/payments/recharge.test.ts`、`tests/newapi-bridge/billing-ledger.test.ts`、`tests/api-console/billing.test.ts`、`tests/api-console/balance-warning.test.ts` | ✅/🟡 |
| L121-L127 | 最近调用记录、记录字段、按模型聚合、余额/用量变化、避免重复计算 | `tests/newapi-bridge/portal.test.ts`、`tests/newapi-bridge/client.test.ts`、`tests/api-console/usage-page.test.ts`、`tests/smoke/mvp-smoke-script.test.ts` | ✅ |
| L129-L138 | 管理员维护供应商，字段包含名称、标识、排序、状态 | `tests/api-catalog/catalog-admin-pages.test.ts`、`tests/api-catalog/catalog-service.test.ts`、`tests/api-catalog/admin-write-authz.test.ts` | ✅ |
| L140-L147 | 管理员维护分组、New API 映射、允许创建 Key、手动对齐 | `tests/api-catalog/catalog-admin-pages.test.ts`、`tests/api-catalog/queries.test.ts`、`tests/db/init-catalog.test.ts` | ✅ |
| L148-L152 | 管理员维护分类，分类不承担 New API 路由语义 | `tests/api-catalog/catalog-admin-pages.test.ts`、`tests/api-catalog/catalog-service.test.ts`、`tests/db/catalog-schema-singlesource.test.ts` | ✅ |
| L154-L157 | 管理员维护能力标签，首批文本/图片/视频/语音 | `tests/db/init-catalog.test.ts`、`tests/api-catalog/catalog-admin-pages.test.ts` | ✅ |
| L159-L167 | 管理员按供应商+分组添加模型、价格折扣、能力、状态、说明、公开展示、真实调用验证标记 | `tests/api-catalog/catalog-admin-pages.test.ts`、`tests/api-catalog/catalog-service.test.ts`、`tests/smoke/mvp-smoke-script.test.ts` | ✅ |
| L169-L180 | 在线支付、订单/到账状态、成功入账、重复 webhook 幂等、失败重试/人工、流水与错误记录 | `tests/payments/recharge.test.ts`、`tests/apipool-ledger/ledger.test.ts`、`tests/newapi-bridge/billing-ledger.test.ts` | ✅/🟡 |
| L182-L188 | 管理员额度增加/扣减、记录操作者/目标/金额/原因/时间、历史可查、用户余额可见 | `tests/api-console/admin-permission.test.ts`、`tests/newapi-bridge/portal.test.ts`、`tests/newapi-bridge/admin-user-detail.test.ts` | ✅ |
| L190-L198 | 管理员查看用户、余额、API Key、用量，处理 Key/额度/用量异常，留审计，不建独立告警平台 | `tests/newapi-bridge/admin-user-detail.test.ts`、`tests/newapi-bridge/portal.test.ts`、`tests/deploy/mvp-deployment-runbook.test.ts` | ✅ |
| L200-L210 | 管理员配置 OAuth、GitHub、Resend、验证开关、发件方，并最小确认邮件可用 | `tests/config/settings-page.test.ts`；真实发送需 Resend 配置和可投递域名 | ✅/🟡 |
| L212-L228 | API Key 用户可见状态：创建中、可用、禁用中、已禁用、删除中、已删除、失败 | `tests/api-console/status.test.ts`、`tests/api-console/api-key-manager.test.ts`、`tests/newapi-bridge/portal.test.ts` | ✅ |
| L230-L236 | 完整 Key 只展示一次、禁用/删除尽力同步 New API、远端失败保留错误、已删除不显示、内部状态不暴露 | `tests/newapi-bridge/portal.test.ts`、`tests/api-console/public-errors.test.ts`、`tests/api-console/api-key-manager.test.ts` | ✅ |
| L238-L248 | 支付状态和到账状态分离、回调幂等、账本 `pending/applied/failed`、到账处理中、失败可处理、pending 提示 | `tests/payments/recharge.test.ts`、`tests/newapi-bridge/billing-ledger.test.ts`、`tests/api-console/billing.test.ts`、`tests/api-console/balance-warning.test.ts` | ✅ |
| L250-L260 | 用量状态 `ready/empty/syncing/stale/failed`，统计请求数、token、消费金额、按模型聚合、去重 | `tests/api-console/status.test.ts`、`tests/api-console/usage-page.test.ts`、`tests/newapi-bridge/portal.test.ts` | ✅ |
| L262-L277 | 用户验收 12 项 | 本地自动化覆盖登录配置、邮箱链接路径、Key、模型、充值、账单、用量；真实 OAuth/邮件/支付/New API 需实环复验 | ✅/🟡 |
| L279-L290 | 管理员验收 10 项 | `tests/api-catalog/*`、`tests/config/settings-page.test.ts`、`tests/newapi-bridge/admin-user-detail.test.ts`、`tests/api-console/admin-permission.test.ts` | ✅ |
| L292-L303 | 外部依赖验收：OAuth、Resend、支付、New API、真实调用 | 本地自动化覆盖等价链路；真实/沙箱 smoke 当前因 New API health fetch 失败阻塞 | 🟡/⛔ |
| L305-L309 | 发布前 live smoke 命令 | 已执行 `npm.cmd run smoke:mvp`，当前失败为 `fetch failed`；需启动/提供 New API live/sandbox 环境后重跑 | ⛔ |
| L311-L329 | 明确不做项 | 通过范围审查和负向测试确认未把 docs/playground/team/export/invoice/marketing/auto-sync/key budget/rate limit/observability 等作为 user-mvp 功能暴露 | ➖ |
| L331-L343 | 默认假设 | 与实现一致：支付进入范围、调额支持增减、分组为公开价格/渠道选择、模型目录由门户维护、邮箱链接不阻塞 Key、New API 为网关 | ✅/➖ |
| L345-L354 | 12 个月方向，不进 user-mvp | 当前测试和实现未将这些方向作为上线门槛；相关能力不在本轮验收范围 | ➖ |

## 3. 本轮修正

- `eslint.config.mjs`：新增忽略 `.tmp/**` 和 `tmp/**`，与 `.gitignore` 对齐，避免本地测试/开发生成产物被 `eslint .` 扫描并导致假失败。
- `tests/api-catalog/queries.test.ts`：补充同模型 ID 多分组独立售卖项、未知筛选不回退全量的特殊场景。
- `tests/api-console/status.test.ts`：补充用量同步刚好 5 分钟/2 小时临界点的特殊场景。
- `tests/user-mvp/requirements-coverage.test.ts`：新增报告元测试，防止逐行验收矩阵遗漏章节、行段或关键特殊场景。

## 4. 特殊场景覆盖

| 场景 | 覆盖方式 | 结果 |
| --- | --- | --- |
| 同模型 ID 多分组独立售卖项 | `tests/api-catalog/queries.test.ts` 验证 `gpt-4o-mini` 在 `official` 与 `partner` 分组下同时出现，且价格、折扣说明相互独立 | ✅ |
| 未知筛选不回退全量 | `tests/api-catalog/queries.test.ts` 验证未知供应商、分组、分类、能力、状态均返回空列表，不误展示全部模型 | ✅ |
| 禁用供应商/分组/分类/能力 | `tests/api-catalog/queries.test.ts` 验证 public listing、filter dimensions、callable groups、smoke candidates 全部排除禁用维度 | ✅ |
| 无 callable 模型分组 | `tests/api-catalog/queries.test.ts` 验证无可调用模型的分组不会进入 Key 创建候选 | ✅ |
| 完整 Key 只展示一次 | `tests/newapi-bridge/portal.test.ts` 与 `tests/api-console/api-key-manager.test.ts` 验证列表只保留掩码 Key，创建成功响应才带一次完整 Key | ✅ |
| 远端同步失败 | `tests/newapi-bridge/portal.test.ts` 覆盖创建、禁用、删除失败时保留 `failed_retriable`、`failed_terminal`、`remote_created_binding_failed` 等可诊断状态 | ✅ |
| 重复 webhook | `tests/payments/recharge.test.ts` 验证重复支付回调不会重复加额，也不会重复写入 credit/ledger | ✅ |
| 非 USD | `tests/payments/recharge.test.ts` 验证非 USD 订单跳过 APIPool 充值账本，不产生错误入账 | ✅ |
| 零金额 | `tests/payments/recharge.test.ts` 验证零金额订单跳过账本，不产生无意义额度流水 | ✅ |
| `reconciliation_required` | `tests/payments/recharge.test.ts` 与 `tests/newapi-bridge/portal.test.ts` 覆盖远端已成功但本地应用失败时进入人工对账状态，避免重复补偿 | ✅ |
| `ready/empty/syncing/stale/failed` | `tests/api-console/status.test.ts`、`tests/api-console/usage-page.test.ts` 覆盖全部用量同步状态和用户可读文案 | ✅ |
| 刚好 5 分钟/2 小时 | `tests/api-console/status.test.ts` 验证 5 分钟边界仍为 `ready`，2 小时边界仍为 `stale`，超过边界才降级 | ✅ |
| OAuth | `tests/config/auth-options.test.ts`、`tests/config/settings-page.test.ts` 覆盖配置路径；真实 Google/GitHub 登录仍需真实 Client 验收 | 🟡 |
| Resend | `tests/config/auth-options.test.ts`、`tests/config/settings-page.test.ts` 覆盖链接验证配置路径；真实投递仍需 Resend 域名与 API Key 验收 | 🟡 |
| 支付 Provider | `tests/payments/recharge.test.ts` 覆盖本地等价回调链路；真实/沙箱支付 Provider 与 webhook 仍需人工验收 | 🟡 |
| Google Fonts | `npm.cmd run build` 当前因受限网络无法拉取字体失败；需联网构建或改成本地字体资源 | ⛔ |

## 5. 结论

- 本地可自动化验证的 user-mvp 门户功能、New API 对齐逻辑、账本幂等、Key 生命周期、用量同步、管理后台和非泄露边界均已通过测试。
- 真实外部依赖仍不能由本地自动化“保证”：Google/GitHub OAuth、Resend 真实邮件、支付 Provider/webhook、真实或沙箱 New API 调用必须在对应环境中验收。
- 当前环境下发布前完整门禁还剩两个阻塞：`smoke:mvp` 需要可访问的 New API 环境；`build` 需要允许访问 Google Fonts 或改为本地字体资源。
