# 04 New API 对接契约（修正版）

> 本文档替换旧版 04-newapi-bridge-contract.md。旧版端点矩阵（`/api/admin/users`、`/api/admin/keys` 等）是虚构接口，开源 New API（Calcium-Ion/new-api）并不存在；本版按真实接口重写。标注 ⚠️Spike 的条目必须在 M1 首日对所部署版本实测确认后回填。

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
| `NEWAPI_QUOTA_PER_UNIT` | quota 整数与 1 美元的换算系数，默认 `500000` ⚠️Spike：与部署实例 `QUOTA_PER_UNIT` 核对 |
| `NEXT_PUBLIC_APIPOOL_API_BASE_URL` | 客户 API 端点，`https://api.apipool.dev/v1` |

## 3. 认证模型

New API 的 API 访问使用**双 header**：

```http
Authorization: Bearer <访问令牌>
New-Api-User: <该令牌所属用户的 ID>
```

桥接需要维护两种凭据上下文：

1. **管理员上下文**：`NEWAPI_ADMIN_TOKEN` + `NEWAPI_ADMIN_USER_ID`，用于建用户、查全量日志、生成兑换码、调额。
2. **用户上下文**：每个门户用户绑定的 New API 用户自己的 access token + 用户 ID，用于建/管理 token（New API 的 token 归属用户，管理员不能直接替用户建 token）、查自身用量。

### 用户供给链路（⚠️Spike 首日实测后回填精确字段）

```
1. 管理员 POST /api/user/          → 创建用户（随机用户名 + 强随机密码）
2. POST /api/user/login            → 以该用户登录获取 session
3. GET  /api/user/token            → 生成/获取该用户的 access token
4. 门户加密保存 access token + newapiUserId 至 newApiUserBinding
```

凭据存储规则：access token 与密码使用应用级加密（AES-256-GCM，密钥来自 env）落库，永不明文存储、永不出现在日志与审计明细中。

额度策略：新建 New API 用户初始额度为 0，余额只能来自门户充值（见 06-payments-ledger.md）或运营调额，两者均落账本与审计。

## 4. 端点矩阵（门户操作 → 真实 New API 接口）

| 门户操作 | 凭据上下文 | 方法与路径 | 说明 |
|---|---|---|---|
| 健康检查 | 无 | `GET /api/status` | 公开接口，返回版本与配置 |
| 创建用户 | 管理员 | `POST /api/user/` | 注册时绑定 |
| 读取用户额度 | 用户 | `GET /api/user/self` | 响应内 `quota` 为整数 |
| 创建 Key | 用户 | `POST /api/token/` | 字段：`name`、`remain_quota`/`unlimited_quota`、`expired_time`、`model_limits_enabled`+`model_limits`、`allow_ips` ⚠️Spike 核对字段名 |
| 列出 Key | 用户 | `GET /api/token/?p=1` | 分页 |
| 禁用/启用 Key | 用户 | `PUT /api/token/?status_only=true`（status 字段）⚠️Spike | |
| 删除 Key | 用户 | `DELETE /api/token/:id` | |
| 用量汇总 | 用户 | `GET /api/data/self` | 模型分布、请求数、token 数 ⚠️Spike 核对时间范围参数 |
| 消费日志 | 用户 | `GET /api/log/self?p=1` | 最近调用日志 |
| 生成兑换码 | 管理员 | `POST /api/redemption/` | 支付加额用（见 06-payments-ledger.md） |
| 兑换加额 | 用户 | `POST /api/user/topup` | body `{ key: <兑换码> }` |
| 手动调额（兜底） | 管理员 | `PUT /api/user/` 全量更新 quota | 读改写有竞态，只作降级方案且需串行化 |

响应包络统一为 `{ success: boolean, message: string, data: ... }`；`success=false` 一律按错误处理，不看 HTTP 200。

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

## 10. M1 Spike 验证清单

在测试环境对所部署 New API 版本逐项实测，回填本文档后才能动 client.ts：

- [ ] `POST /api/user/` 创建用户的必填字段与响应（确认返回 user id）
- [ ] 用户 access token 获取方式（`GET /api/user/token` 的行为：生成 or 读取；是否会使旧 token 失效）
- [ ] `POST /api/token/` 创建 token 的字段名与响应（确认返回完整 key 明文的时机）
- [ ] token 禁用的精确调用方式（`PUT /api/token/?status_only=true` 或其他）
- [ ] `GET /api/data/self` 的时间范围参数与聚合粒度
- [ ] `POST /api/redemption/` 生成兑换码的字段（金额单位是 quota 还是美元）
- [ ] `QUOTA_PER_UNIT` 实际值
- [ ] `success=false` 时的 message 是否含敏感信息（决定能否透传给审计日志）
