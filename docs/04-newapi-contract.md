# 04 New API 对接契约（修正版）

> 本文档替换旧版 04-newapi-bridge-contract.md。旧版端点矩阵（`/api/admin/users`、`/api/admin/keys` 等）是虚构接口，开源 New API（QuantumNous/new-api）并不存在；本版按真实接口重写。
>
> **Spike 已完成（2026-06-12）**：以下内容已在本地 Docker 实例 `calciumion/new-api:latest`（`v1.0.0-rc.10`）逐项实测验证，✅ 标注实测结论。换版本部署时按第 10 节清单复测。

## 1. 边界规则（沿用，不变）

- 门户永不从浏览器调用 New API；所有调用 server-only，从当前 `portalUserId` 出发。
- 浏览器永不接收 `newapiUserId`、`newapiKeyId`、access token、admin token 或内部域名。
- 用户可见文案不出现 "New API" 或任何后台痕迹（守护测试：`tests/public-content/locale-copy.test.ts`）。

## 2. 环境变量

| 变量 | 说明 |
|---|---|
| `NEWAPI_INTEGRATION_ENABLED` | 桥接总开关，非 `false` 即启用 |
| `NEWAPI_BASE_URL` | New API 内部服务地址（如 `http://newapi-internal:3000`），不暴露给浏览器 |
| `NEWAPI_ADMIN_TOKEN` | 管理员系统访问令牌（server-only） |
| `NEWAPI_ADMIN_USER_ID` | 管理员在 New API 中的用户 ID（`New-Api-User` header 需要） |
| `NEWAPI_QUOTA_PER_UNIT` | quota 整数与 1 美元的换算系数，默认 `500000` ✅实测：`GET /api/status` 返回 `quota_per_unit: 500000` |
| `NEXT_PUBLIC_APIPOOL_API_BASE_URL` | 客户 API 端点，`https://api.apipool.dev/v1` |

## 3. 认证模型

New API 的 API 访问使用**双 header**：

```http
Authorization: Bearer <访问令牌>
New-Api-User: <该令牌所属用户的 ID>
```

✅实测：本版本**所有** `/api/*` 调用都要求 `New-Api-User` header，包括 session cookie 会话——缺失时返回 `Unauthorized, New-Api-User header not provided`。

桥接需要维护两种凭据上下文：

1. **管理员上下文**：`NEWAPI_ADMIN_TOKEN` + `NEWAPI_ADMIN_USER_ID`，用于建用户、查全量日志、生成兑换码、调额。
2. **用户上下文**：每个门户用户绑定的 New API 用户自己的 access token + 用户 ID，用于建/管理 token（New API 的 token 归属用户，管理员不能直接替用户建 token）、查自身用量。

### 用户供给链路（✅已实测）

```
1. 管理员 POST /api/user/  body {username, password, display_name}
   → 仅返回 {success:true}，不返回用户 ID
2. 管理员 GET /api/user/search?keyword=<username>
   → 反查取得 newapiUserId（创建接口不返回 ID，必须反查）
3. POST /api/user/login  body {username, password}（cookie 会话）
4. GET  /api/user/token  + New-Api-User: <id>（cookie 会话）
   → 返回 32 字符 access token（每次调用重新生成，旧 token 失效）
5. 门户加密保存 access token + newapiUserId 至 newApiUserBinding
```

注意：步骤 4 的 token 是"重新生成"语义——门户保存后不得再次调用该接口，否则已存 token 失效。

凭据存储规则：access token 与密码使用应用级加密（AES-256-GCM，密钥来自 env）落库，永不明文存储、永不出现在日志与审计明细中。

额度策略：新建 New API 用户初始额度为 0，余额只能来自门户充值（见 06-payments-ledger.md）或运营调额，两者均落账本与审计。

## 4. 端点矩阵（门户操作 → 真实 New API 接口）

| 门户操作 | 凭据上下文 | 方法与路径 | 实测说明 |
|---|---|---|---|
| 健康检查 | 无 | `GET /api/status` | ✅公开接口，返回 `version`、`quota_per_unit` |
| 创建用户 | 管理员 | `POST /api/user/` | ✅body `{username, password, display_name}`；**不返回 ID**，需 `GET /api/user/search?keyword=` 反查 |
| 读取用户额度 | 用户 | `GET /api/user/self` | ✅`data.quota` 为整数 |
| 创建 Key | 用户 | `POST /api/token/` | ✅字段：`name`、`remain_quota`、`unlimited_quota`、`expired_time`(-1 永久)、`model_limits_enabled`+`model_limits`、`allow_ips`、`group`；**响应不含 key**；自带 `key` 字段会被忽略 |
| 读取完整 Key | 用户 | `POST /api/token/:id/key` | ✅返回 48 字符明文（限流保护）；**用户实际调用需加 `sk-` 前缀**；列表/单查接口的 key 一律掩码 |
| 列出 Key | 用户 | `GET /api/token/?p=1&size=N` | ✅分页 `{items, total, page}`；key 掩码 |
| 禁用/启用 Key | 用户 | `PUT /api/token/?status_only=true` | ✅body `{id, status}`；1=启用 2=禁用 |
| 删除 Key | 用户 | `DELETE /api/token/:id` | |
| 用量汇总 | 用户 | `GET /api/data/self` | ✅参数 `start_timestamp`/`end_timestamp`/`default_time=hour\|day` |
| 消费日志 | 用户 | `GET /api/log/self?p=1&page_size=N&type=0` | ✅分页；type=1 为充值记录、type=2 为消费记录 |
| 生成兑换码 | 管理员 | `POST /api/redemption/` | ✅body `{name, quota, count}`（quota 为整数额度单位）；**响应 `data` 直接返回码值数组**；name 写 order_no 便于对账 |
| 兑换加额 | 用户 | `POST /api/user/topup` | ✅body `{key}`；返回 `data:<加额数>`；**一码一兑实测成立**，重复兑换报错 |
| 手动调额（兜底） | 管理员 | `PUT /api/user/` 全量更新 quota | 读改写有竞态，只作降级方案且需串行化 |

响应包络统一为 `{ success: boolean, message: string, data: ... }`；`success=false` 一律按错误处理，不看 HTTP 200。

**一次性实例初始化（✅实测，写入 07-runbook.md）**：

1. 全新实例需先 `POST /api/setup`（body 含 root `username/password/confirmPassword`），未初始化前所有登录失败。
2. 兑换码/支付功能默认被合规开关禁用：需 root 以 **dashboard 会话**（cookie，API token 不可）调 `POST /api/option/payment_compliance` body `{confirmed:true}` 确认一次，之后 `POST /api/redemption/` 才可用。

## 5. 金额换算

- New API `quota` 为整数：`quota = usd × QUOTA_PER_UNIT`（默认 500000/$1）。
- 门户对用户只展示美元；换算只发生在桥接层，系数取 `NEWAPI_QUOTA_PER_UNIT`。
- 换算取整规则：充值入账向下取整到整数 quota；展示余额保留 2 位小数。

## 6. 幂等策略（重要变更）

**New API 不支持 `Idempotency-Key` header**，旧契约的远端幂等机制无效。幂等全部在门户侧实现：

- 创建 Key：`newApiKeyBinding.idempotencyKey` 唯一索引（已有），插入冲突即返回已有记录。
- 支付加额：`apipoolLedgerEntry` 按 `order_no` 唯一索引去重；兑换码本身一码一兑，天然幂等（见 06）。
- 用户绑定：`newApiUserBinding.portalUserId` 唯一索引，重复绑定直接复用。
- 重试策略：GET 可重试；写操作仅在确认远端未生效（明确的 4xx/超时前未发出）时重试，否则先查询远端状态再决定。

## 7. 错误映射与重试（沿用旧契约，微调）

| HTTP/运行时结果 | 桥接错误码 | UI 行为 |
|---|---|---|
| 桥接未启用/缺配置 | `not_configured` | 显示服务暂不可用 |
| 401 | `unauthorized` | 失败，需运营检查令牌 |
| 403 | `forbidden` | 失败，需运营检查权限 |
| 429 | `rate_limited` | 可重试失败 |
| 超时（默认 15s） | `timeout` | 可重试失败 |
| 非 2xx 或 `success=false` | `remote_error` | 可重试或失败 |
| JSON 形状不符 | `malformed_response` | 失败，本地状态保守 |

## 8. 本地状态规则（沿用旧契约，不变）

- Key 创建仅在远端成功 + 本地绑定成功后写 `active`；远端成功本地失败进入 `remote_created_binding_failed`，人工补偿。
- 禁用/删除先写 `disable_pending`/`delete_pending`，New API 确认后才完成。
- 远端写失败保持 `failed_retriable`/`failed_terminal`，永不静默显示成功。
- 调额先写 pending 账本行，远端确认后置 `applied`；失败保持 `failed`，不计入展示余额。

## 9. 审计（沿用旧契约，不变）

每次桥接写操作记录 `new_api_bridge_audit_log`：操作者、门户用户、目标类型/ID、状态、幂等键、脱敏请求/响应体、错误信息。凭据字段一律脱敏。

## 10. Spike 验证清单（✅2026-06-12 已对 v1.0.0-rc.10 完成；换版本部署时复测）

- [x] `POST /api/user/` 创建用户的必填字段与响应——**不返回 user id**，需 `GET /api/user/search?keyword=` 反查
- [x] 用户 access token 获取方式——`GET /api/user/token` 为**重新生成**语义，旧 token 失效；返回 32 字符
- [x] `POST /api/token/` 创建 token 的字段名与响应——响应不含 key；完整 key 走 `POST /api/token/:id/key`，调用时加 `sk-` 前缀
- [x] token 禁用的精确调用方式——`PUT /api/token/?status_only=true` body `{id, status:2}`
- [x] `GET /api/data/self` 的时间范围参数——`start_timestamp`/`end_timestamp`/`default_time=hour|day`
- [x] `POST /api/redemption/` 生成兑换码的字段——`{name, quota, count}`，quota 为整数额度单位；响应直接返回码值；需先做一次合规确认（见第 4 节）
- [x] `QUOTA_PER_UNIT` 实际值——500000
- [x] `success=false` 的 message——未见敏感信息（如 "Redemption failed, please try again later"），可透传审计
- [x] 额外发现：所有 `/api/*` 调用（含 cookie 会话）都要求 `New-Api-User` header；`/v1/chat/completions` 鉴权链路验证通过（无渠道时报 `model_not_found`，属渠道配置问题而非鉴权问题）
