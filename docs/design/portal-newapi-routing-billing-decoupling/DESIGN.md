# 门户与 New API 路由及计费解耦设计

> 状态：当前实现架构基线。
>
> 需求见 [路由与计费解耦需求](../../requirements/portal-newapi-routing-billing-decoupling/requirements.md)；钱包与售卖定价分别以 [支付与钱包账本](../../06-payments-ledger.md) 和 [分组定价档案](../group-pricing-profiles/DESIGN.md) 为准。

## 1. 领域边界

APIPool 存在两条相互独立的数据面：

```text
Portal Key 客户
  └─ app.apipool.dev/v1*
       └─ 门户网关：鉴权、路由、准入、计价、钱包、请求账本
            └─ 容器内网 New API：运行凭证、协议适配、渠道选择和上游转发

New API 原生 Key 客户
  └─ api2.apipool.dev/v1*
       └─ New API 原生数据面：原生账户、Key 和 quota
```

- `app.apipool.dev/v1*` 是 Portal Key 的唯一公开入口，客户不能绕过门户钱包直接使用门户运行凭证。
- `api2.apipool.dev/v1*` 是独立的 New API 原生 Key 数据面，不是门户 API 的别名、过渡域名或回滚入口。
- 两条数据面的用户凭证、余额事实源和账本彼此独立；New API 原生 quota 不参与门户余额计算。
- `newapi.apipool.dev` 是运营管理域名，其 `/v1*` 永久返回 404。

门户网关使用 Next.js Route Handler `src/app/v1/[...path]/route.ts`。转发核心位于
`src/features/gateway/`，不依赖 `next/*`；协议适配、渠道健康检测和上游重试仍由 New API
承担。

## 2. 请求处理

### 2.1 准入与转发

```text
1. 从 Authorization Bearer 或 x-api-key 提取 Portal Key
2. 校验 Key、用户、分组、模型、钱包和冻结状态
3. 解析活动路由与不可变价格版本
4. 查找“门户用户 × New API 分组”的运行凭证
5. 原子创建 request_ledger(open) 并占用风险槽
6. 剥离客户端全部凭证和 hop-by-hop 头，注入唯一运行凭证
7. 经容器内网请求 New API，并捕获 X-Oneapi-Request-Id
8. 在同一背压链路中向客户流式透传并提取 usage
9. 按响应证据结算或进入不计费终态
```

`src/proxy.ts` 必须排除 `/v1`，避免数据面进入 locale middleware。门户自产错误使用稳定错误码，
携带 Portal 请求 ID；响应和日志不得暴露 New API 请求 ID、运行 Key、内部域名或管理信息。

### 2.2 请求与响应体

- JSON 请求只解析路由、模型和定价所需字段；转发时保持原协议语义。
- multipart 请求最多整体缓冲 25 MiB，只读取白名单文本字段，不解码或记录文件内容。
- 流式响应使用单条 `TransformStream`：同一管道一边受客户端背压透传，一边调用
  `extractor.push(chunk)`；禁止 `.tee()` 形成无界旁路缓存。
- 客户端携带的 `Authorization`、`x-api-key`、`x-goog-api-key`、`api-key`、cookie 和内部
  `x-apipool-*` 头必须全部移除，再注入运行凭证。

### 2.3 错误语义

- New API 返回 401/403 表示运行凭证失效：凭证标记为 `invalid`，请求不计费，并向客户统一
  返回 502 `upstream_error`。
- 其它上游 4xx/5xx 保留上游状态和响应体协议语义，同时把门户请求置为
  `failed_unbilled`。
- 无法持久化 New API 请求 ID、转发失败、超时或未取得可靠成功证据时不扣费。

## 3. 身份与运行凭证

门户用户与 New API 用户一一对应。New API `username` 必须等于门户规范化邮箱；邮箱过长时
修复 New API 能力，不得在门户生成截断、哈希或技术别名。

运行 Key 按 `(portal_user_id, newapi_group)` 唯一维护：

1. 热路径没有活动凭证时只写持久化待办，返回可重试 503。
2. 串行 worker 使用稳定名称完整分页精确查找远端 token。
3. 只收编唯一、启用、分组匹配且不在 `credential_retirement` 或历史 token 黑名单中的候选。
4. 没有候选时只允许调用一次创建接口，再完整分页并按相同规则收编。
5. 多枚同名候选或分组不符时记录 `adoption_mismatch`、告警并停止，禁止盲目新建。

用户失权时保留用户、钱包、请求账本和审计历史，但撤销会话、认证账户、角色、Portal Key、
New API token、运行凭证和绑定的有效访问能力。恢复后不得复用已退休 token。

## 4. 路由与定价快照

- 路由粒度为“门户分组 × 门户模型”，活动版本唯一，历史版本不可变。
- v1 强制 `newapi_model_id == portal_model_id`；网关不改写请求体模型 ID。模型重定向必须另行
  设计。
- listing 独立选择 New API 分组和售卖定价档案；请求准入时锁定路由版本和
  `model_price_version`。
- `model_price_version.pricing_spec_json` 保存完整折后规格、meter/SKU 费率、规则 hash 与
  长上下文配置；结算不读取活目录。
- New API 价格、quota 和分组倍率只作上游成本观测。成本缺失或倒挂只告警，不覆盖售价、
  不隐藏 listing，也不阻断已经确认的售卖配置。
- 不使用 New API quota 与历史 `newapiRef*` 列反推门户账单，也不做“成本金额与售价金额必须
  匹配”的发布硬门。

价格档案、meter、SKU 和图片任务的完整约束见
[分组定价档案](../group-pricing-profiles/DESIGN.md)。

## 5. 钱包、准入与结算

### 5.1 事实源和原子性

- `wallet_account` 是物化余额，必须等于该用户追加式 `wallet_ledger.signed_amount_micro_usd`
  之和。
- 风险槽获取与 `request_ledger(open)` 创建使用单条条件写入；余额不足、冻结、Key 或模型不可用
  时必须在访问 New API 前失败。
- 请求终态、`wallet_ledger(request_charge)` 和 `wallet_account` 余额更新在一个数据库事务中
  提交。
- `wallet_ledger.request_ledger_id` 的唯一约束保证同一请求最多扣费一次；重复响应、worker 或
  对账处理不得产生第二笔扣费。
- 金额使用整数 micro-USD 和 `BigInt`；所有 meter 分子求和后只向上舍入一次，非零成功请求
  最低扣 1 micro-USD。

### 5.2 usage 与终态

Token usage 归一化为互不重叠的 meter。OpenAI cached 字段是输入子集，必须从总输入扣除；
Anthropic 的输入、缓存读和缓存写桶按互斥字段直接映射；reasoning 计入输出价格。

终态规则：

- 成功且取得完整、可靠的 Token usage：按锁定价格快照结算为 `settled`。
- Token 响应成功但 usage 缺失或不完整：直接进入 `failed_unbilled`，写入
  `usage_missing_waived` 并告警；不得等待日志后补扣。
- 按次请求：按响应中实际成功交付数量和锁定 SKU 结算；请求参数 `n` 不是最终数量。
- 客户流中断且未取得完整计费证据：`failed_unbilled`。若完整 Token usage 已在中断前取得，
  该计费证据仍然有效。
- 失败、崩溃或无法归因：`failed_unbilled`，由运营承担上游成本。

Schema 中的 `pending_backfill`、`usage_source=log_backfill` 和回填字段仅用于兼容历史数据；
当前请求路径不创建可由日志补扣的状态。`usage_worker` 只把历史 `pending_backfill` 和超时
`open` 收束为不计费终态并释放风险槽。

## 6. 对账与孤儿观测

`reconcile_worker` 拉取 New API 日志用于观测，不作为客户结算凭证：

- 已结算请求：核对模型和 Token 数量，并使用该请求自己的 `pricing_spec_json` 重算门户扣费。
- `open` 或历史 `pending_backfill`：除仍由异步任务持有的请求外，收束为
  `usage_missing_waived`；日志只能补充观测字段，不能触发扣费。
- 已失败请求：记录 `waived_by_failure` 及上游观测。
- New API 有消费而门户无对应请求：以 `newapi_request_id` 唯一写入
  `reconcile_orphan_observation`，不得伪造缺少 Portal Key、路由或价格快照的请求账本。

管理员关闭孤儿观测只表示调查完成；若确认需要收费，必须另走带理由和审计记录的
`manual_adjustment`，系统默认不自动追扣。

每小时校验钱包不变量；异常只告警，不自动覆盖账本。核心指标包括 usage 缺失豁免、孤儿
观测、Token/模型不一致、门户金额重算不一致、钱包不变量、风险槽水位和凭证创建失败。

## 7. 管理与安全边界

- 管理面负责路由、定价档案、请求、钱包流水、冻结/解冻、人工调额、孤儿观测和审计。
- 发布至少校验目标 New API 分组存在且绑定用户可用、模型支持已注册端点、定价档案和
  `pricing_spec_json` 完整。上游成本状态不属于 callable 硬门。
- Portal Key 只保存哈希；运行 Key 使用 AES-256-GCM 加密，只在转发瞬间解密，不进入响应、
  结构化日志或审计正文。
- `newapi.apipool.dev` 的 Caddy 配置必须在同一 `route` 内使用两个互斥 `handle`：
  `handle /v1*` 只返回 404；无 matcher 的 fallback `handle` 才应用 Basic Auth/IP guard 和
  管理面反代。不得让认证指令先于 `/v1*` 返回 401。

部署验收至少证明：

- 带或不带凭据访问 `newapi.apipool.dev/v1/models` 均返回 404；
- `newapi.apipool.dev` 管理路径未认证时被拒绝；
- `app.apipool.dev/v1*` 只接受 Portal Key 并走门户钱包；
- `api2.apipool.dev/api/status` 不暴露管理接口，`api2.apipool.dev/v1/models` 无原生 Key 时
  返回 401；
- 真实 `caddy adapt` 和 `caddy validate` 均通过。

## 8. 当前限制

- SQLite 原子准入只适用于共享同一数据库文件的进程组；跨机器部署前必须迁移数据库方案。
- 风险槽是对并发成本敞口的近似；默认值需按真实客户端并发校准。
- 已消费但未向客户成功交付、无法归因或 usage 缺失的成本由运营承担，并依靠观测和告警控制。
- 网关与门户同进程，故障隔离依赖模块边界、发布门禁和可验证回滚。
