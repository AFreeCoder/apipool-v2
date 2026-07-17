# 04 New API 对接契约（修正版）

> 本文档替换旧版 04-newapi-bridge-contract.md。旧版端点矩阵（`/api/admin/users`、`/api/admin/keys` 等）是虚构接口，开源 New API（QuantumNous/new-api）并不存在；本版按真实接口重写。
>
> **Spike 已完成（2026-06-12）**：以下内容已在本地 Docker 实例 `calciumion/new-api:latest`（`v1.0.0-rc.10`）逐项实测验证，✅ 标注实测结论。换版本部署时按第 10 节清单复测。

## 1. 边界规则（沿用，不变）

- 门户永不从浏览器调用 New API；所有调用 server-only，从当前 `portalUserId` 出发。
- 浏览器永不接收 `newapiUserId`、`newapiKeyId`、access token、admin token 或内部域名。
- 用户可见文案不出现 "New API" 或任何后台痕迹（守护测试：`tests/public-content/locale-copy.test.ts`）。

## 2. 环境变量

| 变量                               | 说明                                                                                                                                                                                                                          |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NEWAPI_INTEGRATION_ENABLED`       | 桥接总开关，非 `false` 即启用                                                                                                                                                                                                 |
| `NEWAPI_BASE_URL`                  | New API 内部服务地址（如 `http://newapi-internal:3000`），不暴露给浏览器                                                                                                                                                      |
| `NEWAPI_ADMIN_TOKEN`               | 管理员系统访问令牌（server-only）                                                                                                                                                                                             |
| `NEWAPI_ADMIN_USER_ID`             | 管理员在 New API 中的用户 ID（`New-Api-User` header 需要）                                                                                                                                                                    |
| `NEWAPI_QUOTA_PER_UNIT`            | quota 整数与 1 美元的换算系数，默认 `500000` ✅实测：`GET /api/status` 返回 `quota_per_unit: 500000`                                                                                                                          |
| `NEXT_PUBLIC_APIPOOL_API_BASE_URL` | 排空期客户 API endpoint，`https://api2.apipool.dev`；协议路径（如 OpenAI-compatible `/v1/chat/completions`）由调用方按具体 provider 协议附加。cutover 后 `https://api.apipool.dev` 回收为正牌 endpoint，`api2` 永久保留为别名 |

## 3. 认证模型

New API 的 API 访问使用**双 header**：

```http
Authorization: Bearer <访问令牌>
New-Api-User: <该令牌所属用户的 ID>
```

✅实测：本版本**所有** `/api/*` 调用都要求 `New-Api-User` header，包括 session cookie 会话——缺失时返回 `Unauthorized, New-Api-User header not provided`。

桥接需要维护两种凭据上下文：

1. **管理员上下文**：`NEWAPI_ADMIN_TOKEN` + `NEWAPI_ADMIN_USER_ID`，用于建用户、查全量日志和维护运行凭证。
2. **用户上下文**：每个门户用户绑定的 New API 用户自己的 access token + 用户 ID，用于供应/维护网关运行时 token（New API 的 token 归属用户，管理员不能直接替用户建 token）和查询上游用量。

### 用户供给链路（✅已实测）

```
1. 管理员 POST /api/user/  body {username, password, display_name}
   → 仅返回 {success:true}，不返回用户 ID
2. 管理员 GET /api/user/search?keyword=<username>
   → 反查取得 newapiUserId（创建接口不返回 ID，必须反查）
3. 如本次运行时凭证供应指定了 `newapiGroup`，管理员 PUT /api/user/ 补齐该用户的 `group`
   → New API 会同时校验 token.group 与 user.group，不一致时 `/v1` 调用会被 403 拒绝
4. POST /api/user/login  body {username, password}（cookie 会话）
5. GET  /api/user/token  + New-Api-User: <id>（cookie 会话）
   → 返回 32 字符 access token（每次调用重新生成，旧 token 失效）
6. 门户加密保存 access token + newapiUserId 至 newApiUserBinding
```

注意：步骤 5 的 token 是"重新生成"语义——门户保存后不得再次调用该接口，否则已存 token 失效。已有绑定用户再次供应运行时凭证时，门户只补齐远端用户 group，不重新生成 access token。

凭据存储规则：access token 与密码使用应用级加密（AES-256-GCM，密钥来自 env）落库，永不明文存储、永不出现在日志与审计明细中。

额度策略：门户用户余额由门户本地钱包管理。New API 用户与运行 Key 使用不依赖其 quota 的运行配置；New API 原生 quota 只属于其自身直连账户，不接受门户充值或 APIPool 调额同步。

## 4. 端点矩阵（门户操作 → 真实 New API 接口）

| 门户操作              | 凭据上下文 | 方法与路径                                 | 实测说明                                                                                                                                                                           |
| --------------------- | ---------- | ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 健康检查              | 无         | `GET /api/status`                          | ✅公开接口，返回 `version`、`quota_per_unit`                                                                                                                                       |
| 创建用户              | 管理员     | `POST /api/user/`                          | ✅body `{username, password, display_name}`；**密码限长 8-20 字符**（超长报 `Password failed on the 'max' tag`）；**不返回 ID**，需 `GET /api/user/search?keyword=` 反查           |
| 更新用户分组          | 管理员     | `PUT /api/user/`                           | 用于让 New API 用户具备对应 token group 权限；需带 `id`、`username`、`display_name`、`group`、`role`、`remark`，只传 `{id, group}` 会触发 New API 校验/唯一约束问题                |
| 读取原生额度          | 用户       | `GET /api/user/self`                       | ✅`data.quota` 为整数；仅用于 New API 原生账户诊断，不作为门户余额                                                                                                                 |
| 创建运行时 token      | 用户       | `POST /api/token/`                         | ✅字段：`name`、`remain_quota`、`unlimited_quota`、`expired_time`(-1 永久)、`model_limits_enabled`+`model_limits`、`allow_ips`、`group`；**响应不含 key**；自带 `key` 字段会被忽略 |
| 读取运行时 token 明文 | 用户       | `POST /api/token/:id/key`                  | ✅返回 48 字符明文（限流保护）；网关调用需加 `sk-` 前缀；列表/单查接口的 key 一律掩码                                                                                              |
| 列出运行时 token      | 用户       | `GET /api/token/?p=1&size=N`               | ✅分页 `{items, total, page}`；key 掩码                                                                                                                                            |
| 禁用/启用运行时 token | 用户       | `PUT /api/token/?status_only=true`         | ✅body `{id, status}`；1=启用 2=禁用                                                                                                                                               |
| 删除运行时 token      | 用户       | `DELETE /api/token/:id`                    |                                                                                                                                                                                    |
| 用量汇总              | 用户       | `GET /api/data/self`                       | ✅参数 `start_timestamp`/`end_timestamp`/`default_time=hour\|day`                                                                                                                  |
| 消费日志              | 用户       | `GET /api/log/self?p=1&page_size=N&type=0` | ✅分页；type=1 为充值记录、type=2 为消费记录                                                                                                                                       |

响应包络统一为 `{ success: boolean, message: string, data: ... }`；`success=false` 一律按错误处理，不看 HTTP 200。

**一次性实例初始化（✅实测，写入 07-runbook.md）**：

1. 全新实例需先 `POST /api/setup`（body 含 root `username/password/confirmPassword`），未初始化前所有登录失败。
2. New API 自身如启用原生支付/兑换码功能，仍需单独完成其合规确认；门户钱包链路不依赖该功能。

## 5. 原生 quota 边界

- New API `quota` 为整数，实例默认换算系数为 `500000/$1`；这个单位只用于上游原生诊断。
- 门户钱包统一使用整数 micro-USD，`1 USD = 1,000,000 micro-USD`。
- 门户充值和人工调额不再换算或写入 New API quota。

## 6. 幂等策略（重要变更）

**New API 不支持 `Idempotency-Key` header**，旧契约的远端幂等机制无效。幂等全部在门户侧实现：

- 门户 Key：只在 `portal_api_key` 本地生成和保存哈希，用户下同名存活 Key 与 key hash 均有唯一约束，不调用 New API token 接口。
- 运行时凭证：`runtime_credential(portal_user_id, newapi_group)` 唯一，同一用户/上游分组复用一份凭证；远端写结果不确定时先查同名 token 再补偿。
- 支付入账：`wallet_ledger.order_no` 唯一约束与订单状态机共同保证本地钱包只入账一次（见 06）。
- 用户绑定：`newApiUserBinding.portalUserId` 唯一索引，重复绑定直接复用。
- 重试策略：GET 可重试；写操作仅在确认远端未生效（明确的 4xx/超时前未发出）时重试，否则先查询远端状态再决定。

## 7. 错误映射与重试（沿用旧契约，微调）

| HTTP/运行时结果           | 桥接错误码           | UI 行为              |
| ------------------------- | -------------------- | -------------------- |
| 桥接未启用/缺配置         | `not_configured`     | 显示服务暂不可用     |
| 401                       | `unauthorized`       | 失败，需运营检查令牌 |
| 403                       | `forbidden`          | 失败，需运营检查权限 |
| 429                       | `rate_limited`       | 可重试失败           |
| 超时（默认 15s）          | `timeout`            | 可重试失败           |
| 非 2xx 或 `success=false` | `remote_error`       | 可重试或失败         |
| JSON 形状不符             | `malformed_response` | 失败，本地状态保守   |

## 8. 本地状态规则

- 门户 Key 在 `portal_api_key` 本地生成，明文只返回一次；禁用和删除只改变本地 Key 状态，网关鉴权立即生效。
- `runtime_credential` 是网关访问上游的内部凭证，不与某一门户 Key 一一绑定；同一用户和 New API 分组共享一份运行时凭证。
- 运行时凭证停用失败进入 `credential_retirement` 待补偿；未核对远端前不得静默标记成功。
- `newapi_key_binding` 及 `remote_created_binding_failed` 等状态仅服务于旧版远端 Key 的只读展示和安全删除，不再用于创建新 Key。
- 门户调额只写本地追加式钱包流水；New API 绑定或运行时凭证状态不影响既有门户钱包余额。

## 9. 审计（沿用旧契约，不变）

门户 Key、钱包与网关管理操作写入 `portal_admin_audit_log`；仍需调用 New API 的用户供应、运行时凭证和旧版 Key 清理写入 `new_api_bridge_audit_log`。两类日志均保留操作者、目标、状态与幂等信息，凭据字段一律脱敏。

## 10. Spike 验证清单（✅2026-06-12 已对 v1.0.0-rc.10 完成；换版本部署时复测）

- [x] `POST /api/user/` 创建用户的必填字段与响应——**不返回 user id**，需 `GET /api/user/search?keyword=` 反查
- [x] 用户 access token 获取方式——`GET /api/user/token` 为**重新生成**语义，旧 token 失效；返回 32 字符
- [x] `POST /api/token/` 创建 token 的字段名与响应——响应不含 key；完整 key 走 `POST /api/token/:id/key`，调用时加 `sk-` 前缀
- [x] token 禁用的精确调用方式——`PUT /api/token/?status_only=true` body `{id, status:2}`
- [x] `GET /api/data/self` 的时间范围参数——`start_timestamp`/`end_timestamp`/`default_time=hour|day`
- [x] 历史验证：`POST /api/redemption/` 可生成兑换码；当前门户钱包链路已不再调用该端点
- [x] `QUOTA_PER_UNIT` 实际值——500000
- [x] `success=false` 的 message——未见敏感信息（如 "Redemption failed, please try again later"），可透传审计
- [x] 额外发现：所有 `/api/*` 调用（含 cookie 会话）都要求 `New-Api-User` header；`/v1/chat/completions` 鉴权链路验证通过（无渠道时报 `model_not_found`，属渠道配置问题而非鉴权问题）
