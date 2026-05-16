# APIPool v2 MVP 详设 Spec

## 0. 文档定位

本文是 `APIPool v2 品牌升级设计方案` 和 `APIPool v2 MVP 快速上线方案` 的下钻版本，用于约束第一版可开发、可验收的 MVP。

本文不替代完整品牌方案，也不展开 New API 后台部署细节。它只回答一件事：基于 ShipAny 模板启动 APIPool v2 门户时，第一版具体要做哪些页面、数据、交互、状态和验收。

来源文档：

- `docs/superpowers/specs/2026-05-15-apipool-v2-brand-upgrade-design.md`
- `docs/superpowers/specs/2026-05-16-apipool-v2-mvp-launch-design.md`

MVP 一句话目标：

> 在 `apipool.dev` 上线一个可信的多模型 API 门户，完成首页、API 市场、模型详情、文档、登录入口和控制台占位闭环；真实 API Key、真实用量和支付入账留到 New API 接入阶段。

## 1. 核心原则

### 1.1 产品边界

APIPool v2 是面向客户的新 API 门户，不是现有 APIPool 运维后台换皮。

MVP 必须坚持三条边界：

- 门户站负责展示、获客、文档、登录、控制台入口和演示数据。
- New API 负责真实 API Key、模型路由、渠道接入、额度扣减和调用日志。
- sub2api/APIPool 作为 New API 的下游渠道之一，不直接暴露给终端用户。

### 1.2 MVP 取舍

MVP 要做出“新平台已经成立”的感知，但不做未验证的复杂闭环。

必须优先：

- 清晰定位：一个 Base URL 接入 OpenAI / Anthropic 等首批模型。
- 清晰转化：用户从首页、市场、详情页都能进入文档或控制台。
- 清晰边界：控制台里的 Key、余额、统计都明确是演示或待接入状态。
- 清晰后路：数据结构和页面布局为 New API 接入留接口。

必须澄清的架构边界：

- New API 在本架构中是后台服务和运营后台，只由门户后端或运营侧访问；它不是用户产品面，也不是门户要提供的客户控制台。

必须避免：

- 把 mock Key 写成真实可调用凭证。
- 在 MVP 中把充值、扣费、用量查询描述为已真实可用能力；MVP 只能保留占位入口和演示数据，真实能力需等 New API 接入、支付回调和账本对账完成后验收。
- 把网关路由、账号池、风控、供应商运维搬进门户站。

## 2. 用户与场景

### 2.1 目标用户

MVP 面向三类用户：

- 开发者：想用一个 API 入口快速发现并调用 OpenAI / Anthropic 等首批模型。
- 小团队/SaaS 开发者：关心价格透明、接入简单、余额可控。
- 高消耗工具用户：例如 OpenClaw、Codex、Claude Code 等工具链用户。

### 2.2 MVP 核心用户故事

1. 作为新访客，我打开首页后能立刻知道 APIPool 是多模型 API 平台。
2. 作为开发者，我能在市场里看到 OpenAI / Anthropic 模型分组、模型 ID 和价格。
3. 作为开发者，我能进入模型详情页复制 Base URL 和示例请求。
4. 作为开发者，我能从导航进入文档模块，看到后续接入文档会在这里补齐。
5. 作为登录用户，我能进入控制台看到 API Key 管理 UI、Base URL 和统计占位。
6. 作为登录用户，我能明确知道当前 Key/统计是演示数据，真实能力后续由门户对接 New API。

## 3. MVP 范围

### 3.1 必须交付

MVP 必须包含以下页面和能力：

- 首页 `/`
- API 市场 `/models`
- 模型详情 `/models/[slug]`
- 文档模块入口 `/docs`
- 登录/注册入口，优先复用 ShipAny 模板能力
- 控制台总览 `/dashboard`
- API Key 占位页 `/dashboard/api-keys`
- 用量占位页 `/dashboard/usage`
- 账单占位页 `/dashboard/billing`
- OpenAI / Anthropic 首批模型 seed 数据
- SQLite 本地运行配置
- 基础品牌替换：APIPool、`apipool.dev`、`newapi.apipool.dev`

### 3.2 可以保留但不作为验收核心

以下能力可复用模板已有入口，但不作为 MVP 核心验收：

- 更新日志 `/changelog`
- 博客 `/blog`
- 充值套餐 UI
- 折扣码输入框
- 兑换码入口
- 主题切换
- 多语言切换
- Admin 后台入口

这些入口如果存在，页面必须保持清晰空状态，不能伪装成真实已完成能力。

### 3.3 明确不做

MVP 不做：

- 真实 New API 管理接口对接。
- 真实 API Key 自动创建、禁用、额度限制、模型白名单、IP 白名单。
- New API 余额、额度、请求数、Token、消费日志同步。
- 真实支付回调、余额入账、订单对账。
- 现有 APIPool 用户资产迁移。
- 任何面向用户的 New API 控制台相关页面；New API 只作为后台服务承接真实网关能力。
- Playground。
- 邀请返佣。
- 复杂 Admin CMS。
- 大规模 SEO 内容矩阵。
- 图像、视频、音频模型完整市场。

## 4. 信息架构与路由

### 4.1 公共导航

顶部导航：

- APIPool Logo/品牌名：跳转 `/`
- Models：跳转 `/models`
- Docs：跳转 `/docs`
- Pricing：MVP 可跳转 `/models`
- Dashboard：登录后跳转 `/dashboard`
- Sign in / Start：未登录时进入认证流程

导航设计要求：

- 第一屏必须把 APIPool 作为显著品牌信号，不只放在导航小字里。
- 桌面端导航保持简洁，不放超过 6 个主入口。
- 移动端导航使用抽屉或折叠菜单，必须包含 Models、Docs、Dashboard。

### 4.2 页脚

页脚至少包含：

- 品牌一句话：多模型 API 门户，统一接入 OpenAI / Anthropic 等首批模型。
- Product：Models、Docs、Dashboard。
- Resources：Docs、Models、Dashboard。
- Legal：Terms、Privacy 可先占位。
- Base URL：`https://newapi.apipool.dev/v1`

## 5. 页面详设

### 5.1 首页 `/`

目标：

让访客在 30 秒内理解 APIPool 是“一个 Base URL 接入 OpenAI / Anthropic 等首批模型”的 API 门户，并进入市场、文档或控制台。

页面模块：

1. Hero
   - 标题：强调 `One API for OpenAI, Anthropic and more` 或等价中文/英文表达。
   - 副标题：说明多模型入口、价格透明、统一 Base URL。
   - 主 CTA：Start building，跳转登录或 `/dashboard/api-keys`。
   - 次 CTA：View models，跳转 `/models`。
   - 必须展示 Base URL：`https://newapi.apipool.dev/v1`。

2. 热门模型
   - 展示 6 个首批模型。
   - 每个卡片包含模型名、模型 ID、供应商、最低价格、能力标签。
   - 点击进入 `/models/[slug]`。

3. 快速接入
   - Step 1：Create an account。
   - Step 2：Get an API key。
   - Step 3：Replace Base URL。
   - Step 4：Call OpenAI / Anthropic models。
   - 需要明确 MVP 阶段真实 Key 后续由 New API 接入或运营开通。

4. 平台优势
   - Multi-model catalog。
   - Transparent pricing。
   - Multi-model access。
   - Built for developers。

5. 文档 CTA
   - 指向 `/docs`。

验收标准：

- 首页第一屏能看到 APIPool 品牌、核心卖点、两个 CTA 和 Base URL。
- 用户不滚动也能知道这是 API 平台，不是普通 SaaS landing。
- 热门模型卡片全部来自统一 seed 数据。
- CTA 不出现死链。

### 5.2 API 市场 `/models`

目标：

展示 OpenAI / Anthropic 首批模型，承担模型发现、价格比较和详情页转化。

页面模块：

1. 页面标题区
   - 标题：Models。
   - 描述：按 OpenAI / Anthropic 等正式供应商分组展示首批模型。

2. 筛选区
   - Provider：All、OpenAI、Anthropic。
   - Capability：Text、Vision、Reasoning、Coding。
   - Pricing：All、Lowest input、Lowest output。
   - MVP 只需要前端过滤 seed 数据。

3. 模型列表
   - 卡片字段：模型名、模型 ID、供应商、简介、能力标签、输入价、输出价、上下文窗口。
   - 卡片操作：View details、Quickstart。
   - 至少 10 个模型；如果实际供给未确认，至少 6 个模型也可上线，但必须覆盖 OpenAI 和 Anthropic。

4. 空状态
   - 文案：No models match these filters。
   - 操作：Clear filters。

验收标准：

- 筛选在前端可用。
- 模型卡片字段齐全，不出现空价格或空供应商。
- 每个模型都能进入详情页。

### 5.3 模型详情 `/models/[slug]`

目标：

让开发者知道这个模型是什么、怎么计费、如何调用。

页面模块：

1. Header
   - 模型展示名。
   - 模型 ID。
   - 供应商。
   - 能力标签。
   - CTA：Get API key、View docs。

2. Pricing
   - 输入价。
   - 输出价。
   - 官方价。
   - 本站展示价。
   - 折扣标签。
   - 计费单位。
   - 价格提示：最终以实际扣费为准。

3. Quickstart
   - Base URL：`https://newapi.apipool.dev/v1`
   - Endpoint：优先展示 `/chat/completions`。
   - curl 示例。
   - JavaScript 示例。
   - Python 示例。

4. Capabilities
   - 文本生成。
   - 视觉理解。
   - 推理。
   - 编程。
   - 只展示 seed 中声明的能力。

5. Use cases
   - 3 到 5 个使用场景。
   - 首批 LLM 模型的场景可复用：代码生成、客服、文档处理、Agent、数据抽取。

6. FAQ
   - 如何接入这个模型。
   - 如何获取 API Key。
   - 价格是否实时。
   - 是否支持用量统计。

7. Related models
   - 同供应商或同能力模型。

验收标准：

- 所有详情页使用同一组件结构。
- 示例代码里的 Base URL 和 model ID 与当前模型一致。
- 价格缺失时不能渲染空白，应展示“Contact support”或隐藏对应价格行。

### 5.4 文档模块 `/docs`

目标：

MVP 只需要保留文档模块入口，不要求填充完整接入文档。文档入口的作用是证明门户信息架构完整，并给后续接入文档留下稳定位置。

MVP 页面内容：

- 标题：Docs。
- 简短说明：APIPool 接入文档会在 New API 接入阶段逐步补齐。
- Base URL 展示：`https://newapi.apipool.dev/v1`。
- 占位卡片：Quickstart、API Keys、Pricing、SDK Migration、Errors。
- 每张卡片可以标记 `Coming soon` 或 `Draft`，不需要进入完整详情页。

MVP 不要求：

- 编写完整 quickstart。
- 编写 SDK 迁移教程。
- 编写完整 API Key 生命周期说明。
- 编写计费与价格规则长文。
- 编写错误码手册。
- 编写完整 API Reference。

验收标准：

- `/docs` 入口可访问。
- 导航和 CTA 不出现死链。
- 页面明确提示详细文档后续补齐。
- 页面不承诺真实 Key、真实调用、真实充值或真实用量已经可用。

### 5.5 控制台总览 `/dashboard`

目标：

建立客户控制台的信息架构，让用户知道后续余额、用量、Key 状态都会在门户侧展示；New API 控制台不是用户产品面。

页面模块：

1. 接入卡片
   - Base URL。
   - 当前默认模型。
   - Docs 链接。
   - API Key 页面链接。

2. 统计卡片
   - Balance：mock。
   - Requests：mock。
   - Tokens：mock。
   - Spend：mock。

3. 近期消耗趋势
   - 7 天 mock 折线或柱状图。
   - 标记为 Demo data。

4. 最近请求
   - mock 列表或空状态。
   - 字段：时间、模型、状态、Token、Cost。

5. 状态提示
   - 文案必须明确：真实 API Key 和用量统计将在 New API 接入后启用。

验收标准：

- 普通用户能从总览进入 API Key、Usage、Billing。
- 页面没有真实扣费暗示。
- 所有 mock 数据在 UI 中有明确 demo 标识。

### 5.6 API Key 占位页 `/dashboard/api-keys`

目标：

展示最终 API Key 管理形态，但不生成真实可调用 Key。

页面模块：

1. Header
   - 标题：API Keys。
   - 描述：Manage keys for `https://newapi.apipool.dev/v1`。
   - 主按钮：Create key。

2. Key 列表
   - Name。
   - Masked key。
   - Status。
   - Models。
   - Monthly limit。
   - IP allowlist。
   - Created at。
   - Last used。
   - Actions：Copy、Edit、Disable、Delete。

3. 创建 Key 弹窗
   - Name。
   - Allowed models。
   - Monthly budget。
   - IP allowlist。
   - Submit 后只新增本地 mock 记录。

4. Key 创建结果
   - 展示一个 mock Key：`apipool_demo_...`。
   - 必须提示：This demo key is not active yet。

5. 空状态
   - 文案：No API keys yet。
   - CTA：Create key。

验收标准：

- 创建、复制、禁用、删除等前端交互可演示。
- 任何地方都不能把 mock key 描述为真实可调用。
- 不提供 New API 控制台入口。

### 5.7 用量占位页 `/dashboard/usage`

目标：

展示未来统计口径，包括请求数、Token、消费金额、模型分布。

页面模块：

- 时间范围切换：7 days、30 days、This month。
- 指标卡：Requests、Input tokens、Output tokens、Spend。
- 模型分布：按模型聚合。
- 请求日志：时间、Key、模型、状态、Token、Cost。
- Demo data 标识。

验收标准：

- 用户能理解未来会在门户查看用量。
- 不显示 New API 控制台链接，因为它不是用户产品面。
- 所有数据都来自 mock/seed。

### 5.8 账单占位页 `/dashboard/billing`

目标：

为后续 Stripe / PayPal 支付留入口，但 MVP 不做真实支付。

页面模块：

- 当前余额：mock。
- 充值套餐：$10、$50、$100、$500。
- 支付方式：Stripe、PayPal 标记为 Coming soon 或 Disabled。
- 交易记录：mock 或空状态。
- 提示：真实充值和余额入账将在支付接入阶段启用。

验收标准：

- 不能创建真实支付订单。
- 不显示“已入账”类真实状态，除非是明确 demo。

## 6. 数据设计

### 6.1 模型 seed

MVP 使用 seed 数据，不做后台 CMS。

推荐结构：

```ts
type ApiModel = {
  slug: string;
  modelId: string;
  displayName: string;
  provider: "openai" | "anthropic";
  category: "llm";
  capabilities: Array<"text" | "vision" | "reasoning" | "coding">;
  shortDescription: string;
  longDescription: string;
  contextWindow?: number;
  featured: boolean;
  status: "available" | "coming_soon";
  sortOrder: number;
  pricing: ApiModelPricing[];
  examples: ApiModelExample[];
  faqs: ApiModelFaq[];
};
```

```ts
type ApiModelPricing = {
  billingMode: "token";
  unit: "1M input tokens" | "1M output tokens";
  sitePriceUsd: number;
  officialPriceUsd?: number;
  discountLabel?: string;
  source: "manual" | "apipool-litellm-seed" | "newapi-reference";
  note?: string;
};
```

```ts
type ApiModelExample = {
  language: "curl" | "javascript" | "python";
  endpoint: "/chat/completions" | "/responses";
  code: string;
};
```

```ts
type ApiModelFaq = {
  question: string;
  answer: string;
};
```

### 6.2 首批模型建议

首批模型以实际供给为准，MVP seed 建议先覆盖：

- `gpt-4o`
- `gpt-4o-mini`
- `gpt-4.1`
- `gpt-4.1-mini`
- `gpt-5.x` 系列中的实际可售型号
- `claude-3.5-sonnet`
- `claude-3.7-sonnet`
- `claude-sonnet-4`
- `claude-opus-4`
- `claude-haiku` 系列中的实际可售型号

如果某些型号供给未确认，状态应设为 `coming_soon`，不要以可用模型展示。

### 6.3 API Key mock 数据

```ts
type ApiKeyMock = {
  id: string;
  name: string;
  maskedKey: string;
  status: "active" | "disabled" | "demo";
  allowedModels: string[];
  monthlyBudgetUsd?: number;
  ipAllowlist: string[];
  createdAt: string;
  lastUsedAt?: string;
  isDemo: true;
};
```

规则：

- mock Key 前缀使用 `apipool_demo_`。
- masked key 展示格式：`apipool_demo_****abcd`。
- 新建 Key 后必须将 `isDemo` 设为 `true`。
- 复制动作可以复制 mock 字符串，但 toast 必须提示该 Key 尚未激活。

### 6.4 用量 mock 数据

```ts
type UsageSummaryMock = {
  range: "7d" | "30d" | "month";
  balanceUsd: number;
  requestCount: number;
  inputTokens: number;
  outputTokens: number;
  spendUsd: number;
  daily: Array<{
    date: string;
    requests: number;
    tokens: number;
    spendUsd: number;
  }>;
  byModel: Array<{
    modelId: string;
    requests: number;
    tokens: number;
    spendUsd: number;
  }>;
};
```

规则：

- 用量页、总览页共用同一份 mock 统计。
- mock 数据必须稳定，避免刷新后随机变化影响评审。
- UI 必须带 `Demo data` 或中文等价标识。

### 6.5 数据库

MVP 可使用 SQLite。

环境变量建议：

```env
DATABASE_PROVIDER=sqlite
DATABASE_URL=file:./data/apipool-v2.db
DB_SCHEMA_FILE=./src/config/db/schema.sqlite.ts
DB_SINGLETON_ENABLED=true
```

SQLite 只用于 MVP 单机上线，不作为长期账本方案。进入真实支付、真实用量同步、用户迁移前，应重新评估 PostgreSQL。

## 7. New API 边界

### 7.1 MVP 固定展示

所有页面统一展示：

- API Base URL：`https://newapi.apipool.dev/v1`
- 真实网关后台：New API
- 首批下游渠道：sub2api/APIPool

### 7.2 MVP 不调用

MVP 不调用 New API 管理接口，也不读取 New API 统计接口。

原因：

- 首版重点是门户站和信息架构。
- New API 的用户、Key、额度、统计接口稳定性需要单独验证。
- 不把真实业务状态混进前端演示，避免用户误解。

### 7.3 后续接入预留

后续阶段需要补三类映射：

```ts
type NewApiUserBinding = {
  portalUserId: string;
  newapiUserId: string;
  status: "pending" | "active" | "disabled";
};
```

```ts
type NewApiKeyBinding = {
  portalUserId: string;
  newapiUserId: string;
  newapiKeyId: string;
  keyMasked: string;
  displayName: string;
  status: "active" | "disabled" | "revoked";
};
```

```ts
type NewApiStatsSnapshot = {
  portalUserId: string;
  newapiUserId: string;
  balanceUsd?: number;
  quotaUsed?: number;
  requestCount: number;
  inputTokens: number;
  outputTokens: number;
  spendUsd?: number;
  rangeStart: string;
  rangeEnd: string;
  syncedAt: string;
};
```

这些类型只作为后续接口边界，不要求 MVP 建表。

## 8. 关键交互与状态

### 8.1 CTA 行为

- `Start building`：未登录进入登录/注册；已登录进入 `/dashboard/api-keys`。
- `View models`：进入 `/models`。
- `Get API key`：未登录进入登录/注册；已登录进入 `/dashboard/api-keys`。
- `View docs`：进入 `/docs`。

### 8.2 Mock 能力提示

控制台必须有全局提示：

> API Key and usage data on this page are demo data. Real New API integration will be enabled in the next phase.

如页面中文化，可使用：

> 当前 API Key 和用量为演示数据。真实 New API 开通、禁用、额度和统计将在下一阶段启用。

### 8.3 价格提示

模型列表和详情页必须有价格提示：

> Displayed prices are for reference. Final billing follows the actual gateway charge.

中文等价：

> 页面价格用于接入前参考，最终以实际网关扣费为准。

### 8.4 错误与空状态

MVP 至少覆盖：

- 模型筛选无结果。
- 模型 slug 不存在。
- API Key 列表为空。
- 用量数据为空。
- 账单记录为空。
- 用户未登录访问控制台。

处理规则：

- 模型不存在：展示 404 或回到 `/models` 的 CTA。
- 未登录控制台：进入登录流程，不展示控制台内容。
- 空状态必须给下一步操作，不只显示空白。

## 9. 视觉与内容约束

### 9.1 品牌

MVP 品牌名固定为 APIPool。

Logo 和主色未定稿时：

- 可以使用临时文字 Logo。
- 可以先采用中性的深色文本、白底、单一强调色。
- 必须避免把临时视觉写死在业务组件中，后续能集中替换。

### 9.2 页面气质

这是开发者 API 门户，不是营销型工具站。

设计要求：

- 首页可以有明确第一屏，但不能把核心体验藏在纯宣传页之后。
- 模型市场和控制台要偏工作台风格，信息密度适中。
- 卡片半径不超过 8px，除非模板设计系统已有不同规范。
- 按钮、筛选、表格、复制操作要使用常见图标和明确 hover/disabled 状态。
- 文档入口优先清晰说明模块状态和后续补齐范围，不做重装饰。

### 9.3 文案语气

文案要直接、开发者友好：

- 少用夸张营销词。
- 初期不把兼容性作为首页主卖点；兼容模式只放在文档补充层说明。
- 明确“New API integration coming next”。
- 不承诺未完成能力。

## 10. 技术落地约束

### 10.1 基座

基座使用 `/Users/afreecoder/project/shipany-template`。

优先复用：

- Next.js / React。
- Tailwind。
- shadcn/radix 组件。
- Fumadocs / MDX 文档。
- Better Auth。
- Settings / Billing / Credits / API Keys 页面骨架。
- SQLite/libsql 能力。

### 10.2 推荐模块划分

后续实现时建议拆成以下边界：

```text
src/features/api-catalog/
  data/models.ts
  components/model-card.tsx
  components/model-filters.tsx
  components/pricing-table.tsx
  lib/filter-models.ts

src/features/api-console/
  data/demo-api-keys.ts
  data/demo-usage.ts
  components/api-key-table.tsx
  components/create-api-key-dialog.tsx
  components/demo-data-banner.tsx
  components/usage-summary.tsx

src/content/docs/
  index.mdx
```

具体路径可按 ShipAny 模板实际目录调整，但责任边界应保持：

- catalog 只关心模型展示和价格。
- console 只关心用户侧控制台演示和未来接入边界。
- docs 只关心文档入口和后续接入文档承载位置。
- New API 真实调用不进入 MVP 前端模块。

### 10.3 配置项

建议集中配置：

```ts
export const APIPOOL_CONFIG = {
  brandName: "APIPool",
  siteUrl: "https://apipool.dev",
  apiBaseUrl: "https://newapi.apipool.dev/v1",
  supportEmail: "support@apipool.dev",
  isNewApiIntegrationEnabled: false,
};
```

UI 不应在多个组件里硬编码 Base URL。

## 11. 验收标准

### 11.1 产品验收

MVP 完成时应满足：

- 首页能清晰表达多模型 API 门户定位。
- API 市场能展示 OpenAI / Anthropic 首批模型。
- 模型详情页能展示模型 ID、价格、示例和 FAQ。
- 文档模块入口可访问，并清楚标注详细接入文档后续补齐。
- 登录用户能进入控制台。
- 控制台能展示 API Key 管理 UI、Base URL、统计、用量、账单占位。
- 所有演示数据都有清晰 demo 标识。
- 门户不提供 New API 控制台入口，New API 仅作为后台服务存在。

### 11.2 技术验收

MVP 完成时应满足：

- 本地能启动。
- SQLite 配置可用。
- 主要页面无运行时错误。
- 所有导航和 CTA 链接有效。
- 模型 seed 数据能被首页、市场、详情页复用。
- mock API Key 创建、复制、禁用、删除交互不依赖真实后端。
- 文档入口页面构建通过。

### 11.3 风险验收

上线前必须确认：

- 没有把 mock Key 当真实 Key 展示。
- 没有开放真实支付入口。
- 没有把 New API 控制台链接做成用户侧入口。
- 没有承诺真实余额、用量、充值已启用。
- 价格都带参考提示。
- 未确认供给的模型标为 Coming soon 或不展示。

## 12. 测试清单

### 12.1 手工测试

- 打开 `/`，检查第一屏品牌、卖点、CTA、Base URL。
- 打开 `/models`，检查模型列表、筛选、空状态。
- 打开每个首批模型详情页，检查 model ID、价格、示例代码。
- 打开 `/docs`，检查文档入口、Base URL 和 Coming soon 状态。
- 未登录访问 `/dashboard`，应进入登录流程。
- 登录后访问 `/dashboard`，检查 demo 数据提示。
- 在 `/dashboard/api-keys` 创建 mock Key，检查提示和列表新增。
- 复制 mock Key，toast 应说明该 Key 未激活。
- 禁用/删除 mock Key，列表状态正确更新。
- 打开 `/dashboard/usage`，检查 demo 标识和范围切换。
- 打开 `/dashboard/billing`，确认不能创建真实支付订单。

### 12.2 自动化测试建议

后续实现时至少补：

- `filterModels` 单元测试。
- 模型 slug 查找测试。
- 价格格式化测试。
- API Key mock reducer/action 测试。
- smoke test：`/`、`/models`、`/models/[slug]`、`/docs`、`/dashboard`。

### 12.3 浏览器验收

MVP 页面完成后需要用浏览器检查：

- 桌面端首页、市场、详情、控制台。
- 移动端首页、市场、详情、控制台。
- 文案不溢出按钮或卡片。
- 导航、筛选、弹窗、复制按钮可交互。
- 空状态和 disabled 状态视觉清楚。

## 13. 阶段交接

### 13.1 MVP 完成后的下一步

MVP 完成后进入 New API 接入阶段，优先级：

1. 部署 New API 到 `newapi.apipool.dev`。
2. New API 接入 sub2api/APIPool。
3. 门户建立 `portal_user_id` 到 `newapi_user_id` 的映射。
4. 门户 API Key 页面接真实创建、禁用、状态读取。
5. 门户读取 New API 余额、请求数、Token、模型分布和消费日志。
6. 再接 Stripe / PayPal 支付入账。

### 13.2 需要单独设计的后续专题

以下事项不塞进本 MVP spec：

- New API 部署与安全加固。
- New API 管理接口鉴权方案。
- 门户订单支付成功后给 New API 加额度的对账流程。
- 现有 APIPool 用户资产迁移。
- 模型价格自动同步。
- 真实 Playground。
- Admin CMS。

## 14. 当前结论

MVP 的正确交付物不是一个完整可扣费网关，而是一个可信、可访问、边界清楚的新 APIPool 门户。

只要第一版能让用户完成“了解平台 -> 查看模型 -> 进入文档入口 -> 进入控制台 -> 看见未来 API Key 和用量管理形态”的闭环，就达到了 MVP 目标。真实 Key、真实用量、真实支付和完整接入文档应在 New API 接入和支付账本设计完成后再进入验收。
