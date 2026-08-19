# 01 产品定位

## 1. 背景

当前 APIPool 源自 sub2api 改造，本质是 API 反代与模型调度系统。它已经具备真实网关、API Key、用户余额、用量日志、模型路由、账号池和运维排障能力，但产品表达仍偏后台系统，不适合承担新品牌的获客、展示、文档和商业转化。

APIPool v2 的目标不是给现有 APIPool 后台换皮，而是建立一个新的 API 门户网站，面向开发者提供模型市场、文档、客户控制台、API Key 管理、充值与用量查询。

## 2. 产品定位

APIPool v2 定位为多模型 API 门户和商业控制台，而不是统一运维后台。

面向用户：

- 开发者：想用一个 Base URL 和一个 Key 调用多个模型。
- 小团队/SaaS 开发者：关心接入简单、价格透明、余额可控、模型更新快。
- 高消耗工具用户：例如 OpenClaw、Codex、Claude Code、图像/视频生成工作流用户。

核心价值主张：

- 一个端点接入多类模型。
- 价格透明，能看到官方价、本站价、折扣和计费单位。
- 支持 Google、GitHub 与邮箱三种登录方式；注册权益、赠额和后续账户能力不按登录渠道区分。
- 注册后可自助充值、自助获取 API Key，并能查看余额、消耗和充值记录。
- 文档和示例代码足够清楚，降低接入成本。

## 3. 架构边界

采用“门户站 + 门户网关 + New API 上游运行层”的架构。

- 门户站负责品牌展示、市场、文档、登录、支付充值、门户 API Key 管理和统计展示。
- 门户网关负责鉴权、目录驱动的模型路由、本地钱包准入、请求计费和请求账本。
- New API 负责运行凭证、上游分组与渠道接入；其用户 quota 不作为门户余额。
- sub2api/APIPool 作为 New API 的首批下游渠道之一，继续承接现有反代和账号池能力。
- 用户只看到 APIPool 门户、APIPool 控制台和公开 API Base URL，不需要知道后台服务名称或进入后台网关控制台。

默认域名：

- 当前门户站与用户 API Endpoint：`https://app.apipool.dev`；OpenAI 兼容路径、Anthropic 原生路径等由具体协议附加。
- 品牌根域：`https://apipool.dev` 在老站排空期继续归老站保温 SEO，cutover 后回收给 v2 营销站。
- 正牌 API 域：`https://api.apipool.dev` 在老站排空期继续服务老用户，cutover 后回收给 v2。
- New API 原生数据面：`api2.apipool.dev`，仅使用 New API 原生 Key，不是门户 API Endpoint。
- New API 管理后台：`newapi.apipool.dev`，仅运营人员访问

## 4. 商业账本边界

- 门户本地 `wallet_account` 与追加式 `wallet_ledger` 是余额唯一事实源；请求扣费以门户 `request_ledger` 及其锁定的价格版本为准。
- 支付成功时订单与本地钱包充值流水在同一事务提交，不再同步增加 New API quota，也不再写模板 `credit` 余额。
- 门户展示的余额、请求数、Token 和消费日志读取本地钱包与请求账本。New API 用量只可作为上游诊断与价格对账证据，不参与门户余额计算。

## 5. 长期非目标

以下能力明确不阻塞 MVP，属于后续迭代或长期方向：

- 现有 APIPool 用户资产自动迁移。
- 面向用户的后台网关控制台入口。
- 通用 Gateway Adapter 或多网关抽象层。
- Playground。
- 复杂 Admin CMS。
- 大规模 SEO 内容矩阵（博客按需恢复）。
