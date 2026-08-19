# 门户与 New API 路由及计费解耦需求

> 状态：当前需求基线，2026-08-19 更新。
>
> 本文只记录现行边界。详细实现见 [设计文档](../../design/portal-newapi-routing-billing-decoupling/DESIGN.md)；钱包与售卖定价分别以 [支付与钱包账本](../../06-payments-ledger.md) 和 [分组定价档案设计](../../design/group-pricing-profiles/DESIGN.md) 为准。

## 1. 目标

- 用户只持有 APIPool Portal Key，不接触 New API 用户凭证或运行 Key。
- 门户以“分组 × 模型”为售卖与路由单元，可独立选择 New API 分组。
- 门户钱包、价格快照和请求账本独立于 New API quota 与日志。
- 请求可从门户请求 ID 追溯到用户、Portal Key、路由版本、价格版本、用量与扣费。
- New API 继续承担协议适配、渠道选择、渠道健康检测和上游转发。

## 2. 非目标

- 不向浏览器或客户 SDK 暴露 New API 管理接口、内部域名、用户 ID、token ID 或运行 Key。
- 不把 New API quota、日志金额或分组倍率作为门户余额或售价事实源。
- 不在门户维护第二套逐渠道健康状态。
- v1 不改写请求体中的模型 ID；模型重定向必须另立 feature。

## 3. 身份与用户绑定

- 门户用户与 New API 用户一一对应，不使用共享服务账号。
- New API `username` 必须等于门户规范化邮箱 `email.trim().toLowerCase()`；不得截断、哈希或改写为技术别名。
- 邮箱长度超出 New API 能力时，应修复 New API 的字段或校验限制，门户不得用另一个用户名绕过。
- 门户创建、禁用或恢复用户时，同步维护 New API 用户绑定状态；历史用户、账本和审计记录不得因失权而物理删除。

## 4. Portal Key 与运行凭证

- Portal Key 是本地凭证，明文只在创建时展示一次；数据库只保存哈希、前缀和掩码。
- Portal Key 绑定门户分组；同一用户、同一分组可以创建多把 Portal Key。
- New API 运行 Key 按“门户用户 × New API 分组”维护，多把 Portal Key 可以共享同一运行 Key。
- 请求发现运行 Key 不存在时，只创建持久化待办并返回可重试 503；串行 worker 在热路径外创建或收编凭证。
- worker 必须完整分页精确查找远端 token，只收编唯一、启用、分组匹配且未进入退休黑名单的候选；无候选时只允许创建一次，再完整分页收编。
- 远端存在多枚同名 token 或分组不符时，必须记录 `adoption_mismatch`、告警并停止，禁止盲目新建。
- New API 返回 401/403 表示内部运行凭证失效：标记凭证 `invalid`，对客户统一返回 502 `upstream_error`，不得透传内部鉴权错误。

## 5. 路由与模型身份

- 路由粒度为“门户分组 × 门户模型 ID”，每次发布生成不可变版本；在途请求继续使用准入时锁定的版本。
- v1 强制 `newapi_model_id == portal_model_id`，发布非恒等配置必须拒绝。
- listing 必须选择独立的 New API 分组映射；该映射与售卖定价档案解耦。
- `/v1/models` 只返回当前 Portal Key 分组下可调用的模型，不暴露 New API 分组或内部版本 ID。
- 路由发布至少校验目标分组存在且可供绑定用户使用、模型支持白名单端点、售卖价格版本完整。
- New API 成本参照缺失或高于售价只产生运营告警，不得自动改价、隐藏 listing 或覆盖已确认售卖快照。

## 6. 网关数据面

- 门户承载 `/v1/chat/completions`、`/v1/responses`、`/v1/messages`、`/v1/embeddings` 及已明确接入的图片任务端点；新增端点前必须定义鉴权、模型字段、usage 和错误语义。
- 鉴权后必须剥离客户端携带的全部凭证载体，至少包括 `Authorization`、`x-api-key`、`x-goog-api-key`、`api-key`、cookie 和内部 `x-apipool-*` 头，再注入唯一 New API 运行凭证。
- 请求体原则上原字节透传。multipart 请求只在有界大小内读取计价所需白名单字段，不记录文件内容。
- 流式响应使用单条 `TransformStream` 管道，在同一背压链路内透传并提取 usage；禁止使用 `.tee()` 形成无界旁路缓存。
- 上游其它 4xx/5xx 保持协议语义；门户自产错误必须使用稳定错误码并携带门户请求 ID。
- 对外响应和日志不得出现 New API 请求 ID、运行凭证、内部域名或管理端信息。

## 7. 钱包、计价与结算

- `wallet_account` 与追加式 `wallet_ledger` 是用户余额唯一事实源；金额使用整数 micro-USD。
- 支付成功时，订单 PAID、`wallet_ledger(recharge)` 和 `wallet_account` 余额更新必须在同一数据库事务提交。
- 充值不写模板 `credit`、`apipool_ledger_entry` 或 New API 用户 quota；New API quota 只作为内部运行池维护。
- 售卖价格来自分组定价档案生成的不可变价格版本；请求准入时锁定价格版本，结算不读取活目录或 New API 价格。
- token usage 必须归一化为互不重叠的计费桶；OpenAI cached 子集从总输入扣除，Anthropic 独立桶直接映射。
- token 制请求缺少可靠 usage 时，该笔零计费并记录 `usage_missing_waived` 与告警；不得使用 New API 日志金额反向生成客户账单。
- 按次请求按实际成功交付数量和锁定 SKU 结算；usage 缺失只影响成本核对，不推翻已确认的交付数量。
- 请求终态、钱包扣费流水和物化余额必须原子写入；同一请求最多扣费一次。
- 请求对用户失败、崩溃或无法归因时不向用户扣费。New API 存在消费但门户没有可结算请求时，写入唯一的 `reconcile_orphan_observation`；不得伪造 `request_ledger` 行。

## 8. 风险控制与生命周期

- 余额 `<= 0`、账户禁用/冻结、Portal Key 禁用或模型不可调用时，请求必须在访问 New API 前拒绝。
- 风险槽位获取与 `request_ledger(open)` 创建必须是跨进程原子操作；只有成功持有槽位的请求才能访问 New API。
- 风险槽位覆盖 `open` 和 `pending_backfill`；进入可确认终态时原子释放，重复终态处理不得重复释放。
- 用户失权时，必须撤销会话、认证账户、角色、Portal Key、New API token、运行凭证与绑定的有效访问能力；用户、钱包、请求账本和审计历史保留。
- 恢复用户后不得复用已退休运行 token，必须由 worker 创建或收编新的有效凭证。

## 9. 安全与部署边界

- Portal Key 客户只通过 `app.apipool.dev/v1*` 进入门户网关；该链路访问 New API 时只走容器内网，客户不得取得或使用门户运行凭证绕过钱包。
- `api2.apipool.dev/v1*` 保留为独立的 New API 原生 Key 数据面；它不接受 Portal Key，不是门户 API 的别名，其账户、Key 和 quota 与门户钱包隔离。
- `newapi.apipool.dev/v1*` 必须始终返回 404；Caddy 在同一 `route` 内用互斥 `handle /v1*` 和 fallback `handle`，避免认证指令先返回 401。
- 发布时必须用真实 `caddy adapt/validate` 验证：带或不带凭据的 `/v1*` 都是 404，管理路径未认证仍被拒绝。
- 密钥、token、私钥和客户数据不得写入仓库文档、Issue、测试报告或部署日志。

## 10. 验收标准

- OpenAI Bearer 和 Anthropic `x-api-key` 客户端均能通过同一 Portal Key 边界完成支持端点调用。
- 抓取到达 New API 的请求时，不存在客户凭证残留，且只携带内部运行凭证。
- 流式慢客户端下内存保持有界，token usage 提取失败会进入明确的豁免状态，不重复扣费。
- 同一请求经响应路径、对账路径或重复 worker 处理，最多生成一条请求扣费流水。
- 禁用 Portal Key、禁用用户、冻结钱包和余额不足路径均在上游调用前失败。
- 孤儿消费只进入观测表；管理员关闭观测不自动收费，确认应收时另走有审计的人工调额。
- 兼容性复测遵循 [New API 对接契约](../../04-newapi-contract.md)；更换 New API 版本后必须重新验证请求 ID、凭证头优先级、token 收编、Responses usage 和日志查询。
