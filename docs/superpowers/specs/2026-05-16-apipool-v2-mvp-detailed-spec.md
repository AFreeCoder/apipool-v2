# APIPool v2 MVP 详设 Spec

## 0. 文档定位

本文是 `APIPool v2 品牌升级设计方案` 和 `APIPool v2 MVP 快速上线方案` 的下钻版本，用于约束第一版可开发、可验收的 MVP。

本文只回答一件事：基于 ShipAny 模板启动 APIPool v2 门户时，第一版具体要做哪些页面、数据、交互、后台对接、状态和验收。

来源文档：

- `docs/superpowers/specs/2026-05-15-apipool-v2-brand-upgrade-design.md`
- `docs/superpowers/specs/2026-05-16-apipool-v2-mvp-launch-design.md`

MVP 一句话目标：

> 在 `apipool.dev` 上线一个可信的多模型 API 门户，完成首页、API 市场、模型详情、文档入口、登录、客户控制台和 New API 真实对接；用户可以在 APIPool 门户创建真实 API Key、查看真实额度/用量，并通过 `https://api.apipool.dev/v1` 发起真实模型调用。

## 1. 核心原则

### 1.1 产品边界

APIPool v2 是面向客户的新 API 门户，不是现有 APIPool 运维后台换皮。

MVP 必须坚持四条边界：

- 门户站负责展示、获客、文档入口、登录、客户控制台、用户侧 API Key 管理和统计展示。
- New API 负责真实 API Key、模型路由、渠道接入、额度扣减和调用日志，是内部后台服务与运营后台。
- sub2api/APIPool 作为 New API 的首批下游渠道之一，不直接暴露给终端用户。
- 用户只看到 APIPool 品牌、APIPool 控制台和 `https://api.apipool.dev/v1`，不需要知道后台服务名称或进入后台网关控制台。

### 1.2 MVP 取舍

MVP 要做出“新平台已经可用”的闭环，而不是只做展示站。

必须优先：

- 清晰定位：一个 Base URL 接入 OpenAI / Anthropic 等首批模型。
- 清晰转化：用户从首页、市场、详情页都能进入文档或控制台。
- 真实接入：登录用户能创建或获取真实可调用的 API Key。
- 真实统计：门户能展示真实额度、请求数、Token、消费日志和模型分布的最小集合。
- 清晰边界：后台网关控制台只服务运营，不作为用户侧产品入口。

必须避免：

- 在用户可见文案里暴露 New API、后台接线方式或内部服务域名。
- 把后台网关控制台链接做成用户入口。
- 把网关路由、账号池、风控、供应商运维搬进门户站。
- 在支付能力未接通时展示“已支付、已自动入账”等自助支付状态。

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
4. 作为开发者，我能从导航进入文档模块，看到文档入口、Base URL 和后续文档结构。
5. 作为登录用户，我能在 APIPool 控制台创建、查看、禁用或删除 API Key。
6. 作为登录用户，我能看到自己的真实余额/额度、请求数、Token、消费日志和模型分布。
7. 作为开发者，我能用门户创建的 Key 调用 `https://api.apipool.dev/v1` 下至少一个首批模型。

## 3. MVP 范围

### 3.1 必须交付

MVP 必须包含以下页面和能力：

- 首页 `/`
- API 市场 `/models`
- 模型详情 `/models/[slug]`
- 文档模块入口 `/docs`
- 登录/注册入口，优先复用 ShipAny 模板能力
- 控制台总览 `/dashboard`
- API Key 管理页 `/dashboard/api-keys`
- 用量页 `/dashboard/usage`
- 账单/额度页 `/dashboard/billing`
- 门户用户与 New API 用户映射
- 门户 API Key 与 New API Key 映射
- New API Key 创建、列表、状态读取、禁用/删除的最小闭环
- New API 额度、请求数、Token、消费日志、模型分布的读取或同步
- `https://api.apipool.dev/v1` 到 New API 的真实调用链路
- New API 接入 sub2api/APIPool 作为首批下游渠道
- OpenAI / Anthropic 首批模型 seed 数据
- SQLite 本地运行配置；如部署形态要求多实例或稳定账本，切换 PostgreSQL
- 基础品牌替换：APIPool、`apipool.dev`、`api.apipool.dev`

### 3.2 可以保留但不作为验收核心

以下能力可复用模板已有入口，但不作为 MVP 核心验收：

- 更新日志 `/changelog`
- 博客 `/blog`
- 自助充值套餐 UI
- 折扣码输入框
- 兑换码入口
- 主题切换
- 多语言切换
- Admin 后台入口

这些入口如果存在，页面必须保持清晰状态。未接通支付时不能伪装成真实自助充值成功。

### 3.3 明确不做

MVP 不做：

- 现有 APIPool 用户资产迁移。
- Stripe / PayPal 自助支付回调、余额自动入账和订单对账。
- 任何面向用户的后台网关控制台相关页面。
- Playground。
- 邀请返佣。
- 复杂 Admin CMS。
- 大规模 SEO 内容矩阵。
- 图像、视频、音频模型完整市场。
- 多网关抽象层或通用 Gateway Adapter。

说明：

- 真实 API 调用扣费和真实用量查询属于 MVP 必做，因为它们来自 New API 对接。
- 真实充值可以先以运营调额、内部工单或手工入账方式完成；自助支付闭环不阻塞第一版。

## 4. 信息架构与路由

### 4.1 公共导航

顶部导航：

- APIPool Logo/品牌名：跳转 `/`
- Models：跳转 `/models`
- Docs：跳转 `/docs`
- Pricing：MVP 可跳转 `/models` 或 `/dashboard/billing`
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
- Base URL：`https://api.apipool.dev/v1`

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
   - 必须展示 Base URL：`https://api.apipool.dev/v1`。

2. 热门模型
   - 展示 6 个首批模型。
   - 每个卡片包含模型名、模型 ID、供应商、最低价格、能力标签。
   - 点击进入 `/models/[slug]`。

3. 快速接入
   - Step 1：Create an account。
   - Step 2：Get an API key。
   - Step 3：Use the APIPool Base URL。
   - Step 4：Call OpenAI / Anthropic models。
   - 不在这段文案中提 New API 或后台服务名称。

4. 平台优势
   - Multi-model catalog。
   - Transparent pricing。
   - Usage visibility。
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
   - Base URL：`https://api.apipool.dev/v1`
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
- 简短说明：APIPool 接入文档会随着平台能力逐步补齐。
- Base URL 展示：`https://api.apipool.dev/v1`。
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
- 页面不暴露后台服务名称。

### 5.5 控制台总览 `/dashboard`

目标：

建立客户控制台的信息架构，让用户能在 APIPool 门户侧查看真实 API Key、余额、用量和最近调用状态。

页面模块：

1. 接入卡片
   - Base URL。
   - 当前默认模型。
   - Docs 链接。
   - API Key 页面链接。

2. 统计卡片
   - Balance / available quota：来自 New API 或门户同步层。
   - Requests：当前时间范围请求数。
   - Tokens：input / output token 汇总。
   - Spend：当前时间范围消费。

3. 近期消耗趋势
   - 7 天折线或柱状图。
   - 数据来自 New API 统计接口或门户同步快照。
   - 无数据时展示真实空状态，不使用演示数字。

4. 最近请求
   - 字段：时间、模型、状态、Token、Cost。
   - 至少展示最近 20 条或空状态。

5. 同步状态
   - 显示最近同步时间或“统计同步中”。
   - 不能引导用户去后台网关控制台查看数据。

验收标准：

- 普通用户能从总览进入 API Key、Usage、Billing。
- 页面展示真实数据或真实空状态。
- 如果 New API 统计接口临时不可用，页面展示错误/同步中状态，而不是假数据。

### 5.6 API Key 管理页 `/dashboard/api-keys`

目标：

让用户在 APIPool 门户创建并管理真实可调用 Key。

页面模块：

1. Header
   - 标题：API Keys。
   - 描述：Manage keys for `https://api.apipool.dev/v1`。
   - 主按钮：Create key。

2. Key 列表
   - Name。
   - Masked key。
   - Status。
   - Models。
   - Monthly limit / quota limit。
   - IP allowlist。
   - Created at。
   - Last used。
   - Actions：Copy、Edit、Disable、Delete。

3. 创建 Key 弹窗
   - Name。
   - Allowed models。
   - Monthly budget 或 quota limit。
   - IP allowlist。
   - Submit 后调用门户后端，由门户后端调用 New API 创建真实 Key。

4. Key 创建结果
   - 只在创建成功后展示一次完整 Key。
   - 列表里只展示 masked key。
   - 创建失败时显示可操作错误，不生成本地假 Key。

5. 空状态
   - 文案：No API keys yet。
   - CTA：Create key。

验收标准：

- 创建 Key 后可以通过 `https://api.apipool.dev/v1` 调用至少一个可售模型。
- 禁用或删除 Key 后，真实调用应失效。
- 复制动作只复制真实 Key 或 masked key 对应的一次性展示值。
- 不提供后台网关控制台入口。

### 5.7 用量页 `/dashboard/usage`

目标：

展示真实统计口径，包括请求数、Token、消费金额、模型分布和请求日志。

页面模块：

- 时间范围切换：7 days、30 days、This month。
- 指标卡：Requests、Input tokens、Output tokens、Spend。
- 模型分布：按模型聚合。
- 请求日志：时间、Key、模型、状态、Token、Cost。
- 同步状态：最近同步时间、同步失败提示。

验收标准：

- 用户能在门户查看真实用量。
- 不显示后台网关控制台链接。
- 无请求时展示真实空状态。
- 统计接口失败时展示错误状态，不回退成演示数据。

### 5.8 账单/额度页 `/dashboard/billing`

目标：

让用户查看真实可用余额/额度、历史调额或订单记录，并为后续 Stripe / PayPal 自助支付留入口。

页面模块：

- 当前余额/可用额度：来自 New API 或门户同步层。
- 额度记录：充值、扣费、调额、退款等记录；MVP 可先展示运营调额和网关扣费记录。
- 充值套餐：$10、$50、$100、$500，可标记为 Coming soon 或 Contact sales。
- 支付方式：Stripe、PayPal 可保留入口但默认 Disabled，除非真实支付已接通。
- 交易记录：真实订单或真实调额记录；没有数据时展示空状态。

验收标准：

- API 调用产生的扣费或额度消耗能在门户可查。
- 未接支付时不能创建真实支付订单。
- 不显示“已入账”类状态，除非确实来自真实订单或运营调额。

## 6. 数据设计

### 6.1 模型 seed

MVP 使用 seed 数据展示模型市场，不要求后台 CMS。

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

### 6.3 门户到 New API 映射

```ts
type NewApiUserBinding = {
  portalUserId: string;
  newapiUserId: string;
  status: "pending" | "active" | "disabled";
  createdAt: string;
  updatedAt: string;
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
  allowedModels: string[];
  quotaLimit?: number;
  ipAllowlist: string[];
  createdAt: string;
  lastUsedAt?: string;
};
```

规则：

- 门户不保存完整明文 Key；创建成功后只做一次性展示。
- 门户只保存映射、masked key、状态、展示名和用户可见限制。
- 如果 New API 原生字段不足，门户后端做 DTO 转换，不让前端依赖 New API 数据库结构。

### 6.4 用量与额度快照

```ts
type UsageSummary = {
  portalUserId: string;
  newapiUserId: string;
  range: "7d" | "30d" | "month";
  balanceUsd?: number;
  quotaRemaining?: number;
  requestCount: number;
  inputTokens: number;
  outputTokens: number;
  spendUsd?: number;
  daily: Array<{
    date: string;
    requests: number;
    tokens: number;
    spendUsd?: number;
  }>;
  byModel: Array<{
    modelId: string;
    requests: number;
    tokens: number;
    spendUsd?: number;
  }>;
  syncedAt: string;
};
```

```ts
type UsageLogItem = {
  id: string;
  portalUserId: string;
  newapiRequestId?: string;
  keyMasked: string;
  modelId: string;
  status: "success" | "failed" | "cancelled";
  inputTokens: number;
  outputTokens: number;
  spendUsd?: number;
  createdAt: string;
};
```

规则：

- 用量页、总览页共用同一份真实统计或同步快照。
- 无数据时展示空状态。
- 同步失败时展示错误状态和最近成功同步时间。

### 6.5 数据库

MVP 可使用 SQLite，但要以真实映射和统计为前提。

环境变量建议：

```env
DATABASE_PROVIDER=sqlite
DATABASE_URL=file:./data/apipool-v2.db
DB_SCHEMA_FILE=./src/config/db/schema.sqlite.ts
DB_SINGLETON_ENABLED=true
```

SQLite 适合单机第一版。如果门户、新 API、支付和对账进入多实例生产形态，应切换 PostgreSQL。

## 7. New API 对接边界

### 7.1 内部架构固定项

所有用户可见页面统一展示：

- API Base URL：`https://api.apipool.dev/v1`
- 首批模型供应商分组：OpenAI / Anthropic
- 用户控制台：APIPool 门户控制台

内部实现固定项：

- 真实网关后台：New API
- 内部管理域名：`newapi.apipool.dev`
- 首批下游渠道：sub2api/APIPool

### 7.2 MVP 必须对接

MVP 必须完成以下 New API 对接：

- 用户映射：创建或绑定 `portal_user_id -> newapi_user_id`。
- Key 管理：创建、列表、状态读取、禁用/删除。
- 调用链路：`api.apipool.dev/v1 -> New API -> sub2api/APIPool -> 上游模型`。
- 额度/余额：读取可用额度或余额。
- 用量统计：读取或同步请求数、Token、消费、模型分布。
- 消费日志：展示最小日志列表或可分页列表。

### 7.3 不允许的替代方案

以下方式不能作为 MVP 验收通过：

- 只做 Key 管理页面，但不生成真实可调用 Key。
- 只展示静态统计数字，而没有 New API 统计或同步来源。
- 让用户进入 New API 控制台查看余额、请求数或消费日志。
- 在前端直连 New API 数据库。
- 在用户文案中解释后台服务名称或内部域名。

### 7.4 接口不稳定时的降级

如果 New API 管理接口能力不足，MVP 仍必须给出用户侧闭环：

- Key 自动创建不可用时，可短期采用“门户提交申请 -> 运营开通 -> 门户展示 Key 状态”的半自动流程，但上线验收时至少要有一条真实 Key 能通过门户状态流转给用户。
- 统计实时查询不可用时，可由门户后端定时同步只读快照。
- 消费日志不可用时，至少展示额度、请求数、Token、消费的聚合统计，并把日志列表显示为“同步中/暂不可用”。

降级状态必须在门户侧表达，不能把后台网关控制台作为用户替代入口。

## 8. 关键交互与状态

### 8.1 CTA 行为

- `Start building`：未登录进入登录/注册；已登录进入 `/dashboard/api-keys`。
- `View models`：进入 `/models`。
- `Get API key`：未登录进入登录/注册；已登录进入 `/dashboard/api-keys`。
- `View docs`：进入 `/docs`。

### 8.2 Key 创建状态

Key 创建至少覆盖：

- `idle`：未提交。
- `creating`：门户正在创建本地记录并调用后台服务。
- `active`：真实 Key 创建成功，可调用。
- `pending_manual_activation`：需要运营开通或补充额度。
- `failed`：创建失败，展示错误和重试入口。

### 8.3 统计状态

统计展示至少覆盖：

- `ready`：有最新统计。
- `empty`：真实无调用记录。
- `syncing`：后台同步中。
- `stale`：统计可展示但不是最新数据。
- `failed`：统计读取失败。

### 8.4 价格提示

模型列表和详情页必须有价格提示：

> Displayed prices are for reference. Final billing follows actual APIPool API usage.

中文等价：

> 页面价格用于接入前参考，最终以 APIPool API 实际用量扣费为准。

### 8.5 错误与空状态

MVP 至少覆盖：

- 模型筛选无结果。
- 模型 slug 不存在。
- API Key 列表为空。
- Key 创建失败。
- 统计同步中。
- 统计读取失败。
- 账单/额度记录为空。
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
- 用户可见区域不出现 New API、后台接线方式或内部服务域名。
- 不承诺未完成的自助支付、迁移、Playground、导出等能力。

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
  components/api-key-table.tsx
  components/create-api-key-dialog.tsx
  components/usage-summary.tsx
  components/usage-log-table.tsx
  components/sync-status-banner.tsx
  lib/format-usage.ts

src/features/newapi-bridge/
  server/client.ts
  server/users.ts
  server/keys.ts
  server/usage.ts
  server/quota.ts
  types.ts

src/content/docs/
  index.mdx
```

具体路径可按 ShipAny 模板实际目录调整，但责任边界应保持：

- catalog 只关心模型展示和价格。
- console 只关心用户侧控制台体验和状态展示。
- newapi-bridge 只关心门户后端到 New API 的内部接入。
- docs 只关心文档入口和后续接入文档承载位置。

### 10.3 配置项

建议集中配置：

```ts
export const APIPOOL_CONFIG = {
  brandName: "APIPool",
  siteUrl: "https://apipool.dev",
  apiBaseUrl: "https://api.apipool.dev/v1",
  supportEmail: "support@apipool.dev",
  isNewApiIntegrationEnabled: true,
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
- 控制台能展示真实 API Key 管理、Base URL、额度、统计、用量和账单/额度记录。
- 用户能用门户创建或获取的 Key 调用 `https://api.apipool.dev/v1` 下至少一个首批模型。
- 门户不提供后台网关控制台入口。
- 用户可见文案不暴露 New API。

### 11.2 技术验收

MVP 完成时应满足：

- 本地能启动。
- SQLite 配置可用；如部署需要多实例，已切换 PostgreSQL。
- 主要页面无运行时错误。
- 所有导航和 CTA 链接有效。
- 模型 seed 数据能被首页、市场、详情页复用。
- 门户后端能创建或绑定 New API 用户。
- 门户后端能创建、列出、禁用或删除 New API Key。
- 门户后端能读取或同步 New API 额度、请求数、Token、消费日志和模型分布。
- 文档入口页面构建通过。

### 11.3 风险验收

上线前必须确认：

- 没有把后台网关控制台链接做成用户侧入口。
- 没有在用户可见文案里写 New API 或内部域名。
- 没有开放未接通的自助支付入口。
- 没有展示静态假用量冒充真实数据。
- 价格都带参考提示。
- 未确认供给的模型标为 Coming soon 或不展示。

## 12. 测试清单

### 12.1 手工测试

- 打开 `/`，检查第一屏品牌、卖点、CTA、Base URL。
- 打开 `/models`，检查模型列表、筛选、空状态。
- 打开每个首批模型详情页，检查 model ID、价格、示例代码。
- 打开 `/docs`，检查文档入口、Base URL 和 Coming soon 状态。
- 未登录访问 `/dashboard`，应进入登录流程。
- 登录后访问 `/dashboard`，检查真实数据或真实空状态。
- 在 `/dashboard/api-keys` 创建 Key，检查一次性完整 Key 展示和列表 masked key。
- 使用创建的 Key 调用 `https://api.apipool.dev/v1` 下至少一个模型。
- 禁用/删除 Key 后再次调用，应失败。
- 打开 `/dashboard/usage`，检查请求数、Token、消费日志、模型分布。
- 打开 `/dashboard/billing`，检查余额/额度和调额/扣费记录。
- 确认页面没有后台网关控制台入口。

### 12.2 自动化测试建议

后续实现时至少补：

- `filterModels` 单元测试。
- 模型 slug 查找测试。
- 价格格式化测试。
- New API bridge client 错误映射测试。
- API Key 创建/禁用 action 测试。
- 用量 DTO 格式化测试。
- smoke test：`/`、`/models`、`/models/[slug]`、`/docs`、`/dashboard`。

### 12.3 浏览器验收

MVP 页面完成后需要用浏览器检查：

- 桌面端首页、市场、详情、控制台。
- 移动端首页、市场、详情、控制台。
- 文案不溢出按钮或卡片。
- 导航、筛选、弹窗、复制按钮可交互。
- 空状态、错误状态和 disabled 状态视觉清楚。

## 13. 后续专题

以下事项不塞进本 MVP spec：

- New API 部署与安全加固细案。
- New API 管理接口鉴权方案细案。
- Stripe / PayPal 支付成功后给 New API 加额度的对账流程。
- 现有 APIPool 用户资产迁移。
- 模型价格自动同步。
- 真实 Playground。
- Admin CMS。

## 14. 当前结论

MVP 的正确交付物不是纯展示站，而是一个可信、可访问、能真实调用的 APIPool 门户。

只要第一版能让用户完成“了解平台 -> 查看模型 -> 进入文档入口 -> 登录控制台 -> 创建真实 Key -> 调用 APIPool API -> 查看真实额度和用量”的闭环，就达到了 MVP 目标。自助支付、现有用户迁移、Playground、完整文档和复杂后台可以后置。
