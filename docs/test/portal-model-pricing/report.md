# 门户模型定价与调用计费本地用户验收报告

- 日期：2026-07-21
- 实施计划：[`docs/plan/portal-model-pricing/PLAN.md`](../../plan/portal-model-pricing/PLAN.md)
- 测试基线：`96b2add7bb5a60292e5e1453b7decb21c4f76fc0`
- 测试方式：独立 detached worktree、本地浏览器用户验收、门户网关真实请求、本地 NewAPI 日志与门户账本交叉核对
- 测试范围：除支付之外的用户端、管理端、模型目录、API Key、网关协议、真实上游、计费、钱包和对账流程

## 结论

**不通过，当前版本不建议发布。**

真实上游调用、门户计费和钱包账本主链路基本成立，但存在两个发布阻断问题：

1. 管理后台无法保存模型和分组折扣，导致运营无法通过正常界面配置、定价和发布模型。
2. New API 运行用户/运行凭证缺少与门户钱包解耦的内部运行池；新注册用户即使门户本地钱包有余额，真实调用仍会被 New API 用户 quota 拒绝。

此外，用量页、账单页、公共模型价格展示和按次图片对账存在多项用户可见错误。完整未解决项见 [`issues.md`](issues.md)。

## 测试环境

| 项目          | 状态                                                               |
| ------------- | ------------------------------------------------------------------ |
| 测试 worktree | `/Users/afreecoder/.codex/worktrees/uat-portal-pricing/APIPool_v2` |
| Git 状态      | detached HEAD，基线与实施分支 HEAD 一致                            |
| 门户          | 本地开发服务，`http://localhost:3100`                              |
| NewAPI        | 本地服务，已连接 RunAPI 与 sub2api 上游                            |
| 门户数据库    | worktree 内独立 SQLite 副本，15 个迁移已应用                       |
| 数据库检查    | `PRAGMA integrity_check` 通过；无外键异常                          |
| 支付          | Checkout 关闭；未点击、未创建、未验证任何支付订单                  |

## 通过项

| 范围                  | 验证结果                                                                                                        |
| --------------------- | --------------------------------------------------------------------------------------------------------------- |
| 未登录访问            | 受保护页面跳转到登录页，并携带回跳地址                                                                          |
| 注册与登录            | 注册、错误密码提示、正确登录、退出均符合预期；注册后钱包与 NewAPI 绑定自动创建                                  |
| 权限隔离              | 普通用户访问管理后台会跳转到中文无权限页面                                                                      |
| 移动端                | 390×844 视口下控制台和模型目录布局可用，移动菜单可正常开关                                                      |
| 模型目录              | 分组筛选可用；token 制模型能展示基准价、折后价和折扣标签                                                        |
| API Key               | 分组 Key 创建、错误 Key、错分组模型、禁用和删除均按预期生效                                                     |
| sub2api               | `gpt-5.6-terra` Responses 真实请求返回 200；NewAPI 日志确认命中 sub2api 上游及目标分组                          |
| RunAPI OpenAI 协议    | Responses、Chat Completions、Chat 流式和 Embeddings 均真实返回 200                                              |
| RunAPI Anthropic 协议 | Messages 与 Messages 流式均真实返回 200，流式事件完整结束                                                       |
| 图片生成与编辑        | `gpt-image-2` 低质量 1024×1024 生成和 multipart 编辑均返回 200；门户按 SKU、调用次数和单价完成结算              |
| 安全门禁              | 未开放图片 SKU 返回 400；未声明 web search 返回 400；长上下文关闭时返回 413；开启后成功并应用长上下文价格       |
| 失败请求计费          | 无效 Key、错分组、禁用 Key 和其他失败请求均未错误扣费                                                           |
| 钱包与账本            | 钱包余额与追加账本求和完全一致；请求扣费与余额变化一致                                                          |
| 管理端部分流程        | 分组到 NewAPI 分组的映射可编辑；修正映射后成本同步由 partial 变为 success；对账人工关闭要求填写说明并能成功提交 |

## 真实调用与计费证据

本轮共形成 12 条门户请求记录：

- 10 条 `settled`，2 条 `failed_unbilled`。
- 输入 token 4,763，输出 token 117。
- 门户账本累计扣费 29,189 micro-USD，即 `$0.029189`。
- 测试结束时钱包余额为 9,970,811 micro-USD，与该用户全部钱包流水求和一致。
- NewAPI 日志记录到 sub2api 的 `gpt-5.6-terra`，以及 RunAPI 的 `gpt-5-nano`、`text-embedding-3-small`、Anthropic 模型和 `gpt-image-2`。
- 对账状态为 8 条 `matched`、2 条图片 `token_mismatch`、2 条 `pending`；图片差异原因均为 `ref_missing:per_call`。

## 发布阻断与主要缺陷

### P0：后台模型和分组折扣无法保存

模型编辑和分组折扣编辑提交时均触发 Next Server Action 序列化错误：

`Functions cannot be passed directly to Client Components`

相关入口：

- `src/app/[locale]/(admin)/admin/catalog/models/[id]/edit/page.tsx:85`
- `src/app/[locale]/(admin)/admin/catalog/models/[id]/listings/[listingId]/edit/page.tsx:126`

该问题阻断正常模型录入、基准价格修改、折扣修改和发布操作。

### P0：运行凭证缺少与门户钱包解耦的内部运行池

当前管理端调额接口只调用门户钱包的 `applyManualAdjustment()`：

- `src/app/api/apipool/admin/adjust-quota/route.ts:52`

这符合既定单钱包架构：APIPool 调额不得同步 New API quota。问题出在运行凭证供应没有实现既定阶段二的“大额内部运行池 + 定期人工补充”。实测门户本地钱包增加 `$10` 后，合成用户第一次真实请求仍被 New API 以用户额度不足拒绝；当前运行 token 虽设置 `unlimited_quota=true`，仍不能绕过远端用户 quota 检查。

- `src/features/gateway/server/credentials.ts:301`
- `docs/04-newapi-contract.md:59`
- `docs/06-payments-ledger.md:35`

这会导致“注册 → 门户入账 → 创建 Key → 真实调用”无法自然闭环。修复不得恢复双余额同步，必须用独立内部池承接 New API 的用户 quota 门禁，并与用户可见余额彻底解耦。

### P1：用量与账单页面数据错误

- 用量页把每个模型的 token 数硬编码为 0，把 Key 固定显示为 `—`，且两张表的表头和数据列数量不一致，导致状态、输入和输出列错位：`src/app/[locale]/(landing)/dashboard/usage/page.tsx:32`。
- 账单页把所有钱包流水映射为“充值记录”，同时把用量扣费列表初始化为空：`src/app/[locale]/(landing)/dashboard/billing/page.tsx:86`。
- micro-USD 级请求扣费在界面中会显示为 `$-0.00`，容易误导用户。

### P1：公共模型目录价格展示不完整

- Embedding 只有输入价格时会因输出价格为空而被整体判定为隐藏：`src/features/api-catalog/lib/pricing.ts:303`。
- `per_call` 图片分档价格没有映射到公共模型价格表，图片模型显示为 `—`，与实际可调用、可计费状态不一致。

### P1：按次图片请求持续进入对账差异

两条成功图片请求都进入 `token_mismatch`，同时带有 `ref_missing:per_call` note。两者不是同一原因：前者表示 New API 日志与门户账本的 token 汇总不一致；后者表示 per_call 尚无自动成本参照契约。人工关闭流程可用，但当前行为会持续制造无效人工审核任务。

### P2：错误语义、文案与状态提示

- 图片编辑缺少文件时返回 500 `convert_request_failed`，属于客户端请求错误但被表现为服务端错误。
- 对账表和审计表分别显示原始翻译 key：`admin.apipool.routing.model`、`admin.apipool.wallet.reason`。
- 中文文档把余额不足描述为 402，实测为 429；示例模型与当前 callable 目录不一致，并缺少 Embeddings、Images 和按次价格说明。
- 已经位于中文页面时，文档页仍提示“检测到你的浏览器语言是中文，是否切换”。
- Checkout 已关闭，但账单页仍展示外观可操作的充值按钮；本轮未点击这些按钮。
- 新分组首次创建运行凭证后，请求可能先返回一次 503；worker 激活凭证后重试成功，用户侧缺少明确的预热提示或自动重试。

## 测试介入与边界

由于两个 P0 问题会阻断后续真实调用，为继续验证其余链路，本轮进行了以下仅限隔离测试环境的介入：

1. 在 detached worktree 的独立门户数据库中插入 `uat-*` 模型、分组 listing、价格和按次图片分档夹具。
2. 在确认运行凭证仍被 New API 用户 quota 拦截后，手工为合成 New API 用户设置测试额度，再继续执行真实上游请求；该介入不代表建议恢复额度同步。
3. 实际执行了两次低质量 1024×1024 图片调用，分别覆盖生成和 multipart 编辑；上游实际成本以本地 NewAPI 日志为准。

这些介入证明网关、用量解析和门户结算在给定配置下可以工作，但不能替代被阻断的正常运营配置流程。

## 清理结果

- 门户开发服务已停止，3100 端口已关闭。
- 合成 NewAPI 用户及其两个运行令牌已禁用，调用日志保留用于复核。
- detached worktree、隔离门户数据库和测试证据保留，便于修复后复测。
- 实施分支未因本轮验收产生任何源代码改动。

## 复测门槛

至少完成以下条件后，才能重新判断是否可发布：

1. 后台模型与分组折扣可以通过浏览器正常保存，并能立即影响公共目录与新建 Key 的 callable 集合。
2. 新注册用户在门户钱包入账后，无需手工修改 NewAPI 数据即可完成首次真实调用。
3. 用量页、账单页和公共模型目录展示与请求账本一致。
4. 按次图片成功请求不再无条件生成无效对账差异，或产品明确接受并记录该人工审核策略。
5. 对本报告的全部 P0/P1 项完成浏览器和真实上游回归。
