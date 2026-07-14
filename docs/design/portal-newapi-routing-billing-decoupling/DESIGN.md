# 门户与 New API 路由及计费解耦详细设计（v1 精简版）

> 状态：**设计正确性复审通过（GO，Codex 第七轮 §31，2026-07-14）**，随后据第七轮 GO + 过度设计专项评审（§32）+ 用户裁决做**首版范围精简**，本文件为精简后的 v1 实施 spec。
>
> 上游需求：[../../requirements/portal-newapi-routing-billing-decoupling/requirements.md](../../requirements/portal-newapi-routing-billing-decoupling/requirements.md)（v6 冻结基线）。**本 v1 对需求有 4 处有意调整 + 1 处软延后，逐条见 §16——均经用户裁决。**
>
> 七轮对抗式评审（六轮 NO-GO 逐条闭环 + 第七轮 GO）与过度设计评审的完整往返：[review-log.md](review-log.md)。该往返产出的"正确的目标设计"（全量 v7）在 review-log 中可追溯；本文件是据此收敛的 v1 落地范围。
>
> Feature slug：`portal-newapi-routing-billing-decoupling`。编写：2026-07-13～14。

## 0. 设计结论（TL;DR）

1. **网关宿主**：新建 Next.js Route Handler `src/app/v1/[...path]/route.ts`（Node runtime、`force-dynamic`），与门户同进程；转发核心放 `src/features/gateway/`、不 import `next/*`，保留平移能力。**必须同步改 `src/proxy.ts` matcher 排除 `/v1`**（现 matcher 会把 `/v1/*` 当 locale——代码硬坑）。
2. **切流**：Caddy 状态 `APIPOOL_API_MODE`，`configure-caddy.sh` 用 `read_env_value()` 从 `.env.deploy` 读取（现状只读 shell 环境、`deploy.sh` 不导出 → 只改 env 不生效）；门户运行时开关先入 `docker-compose.prod.yml` allowlist 才注入容器。切流后 **New API `/v1` 只容器内网可达**，且 **`newapi.apipool.dev/v1*` 必须封 404**（否则绕计费后门）。**回滚 = maintenance + fix-forward**，不维持可重新接单的旧计费数据面（§32 减配）。
3. **数据结构**：8 张核心业务表——`portal_api_key`、`model_route`、`model_price_version`、`runtime_credential`（串行创建后大幅简化）、`wallet_account`、`wallet_ledger`、`request_ledger`、`portal_admin_audit_log`；按需 `credential_retirement`（简单待禁用列表）。扩展 `catalog_model.max_output_tokens` + `catalog_model_price` cache 维度基准价列。模板 `apikey` 表不复用。
4. **原子准入**：单语句 `INSERT INTO … SELECT … WHERE (COUNT RISK_HOLDING) < :limit`（SQLite 单语句原子 + 单写者）。`RISK_HOLDING` = `open`/`pending_backfill` 未决行；槽位释放 = 终态条件 UPDATE 本身（`affected=0` 即幂等）。上限默认 10、env 可配 + 按用户覆盖。**（此模型为 v1 已知待观察项，见 §17。）**
5. **结算事务**：`终态条件 UPDATE + wallet_ledger 扣费 INSERT + wallet_account 物化余额 UPDATE + 越阈自动冻结` 单 `db().transaction`；幂等键 `request_ledger.newapi_request_id`（唯一）+ `wallet_ledger.request_ledger_id`（部分唯一）。金额全程 BigInt、全桶合计后一次 ceil 到 1 micro-USD。**结算前置 `newapi_request_id` 已捕获**（CHECK 兜底）。
6. **计费口径 = 用户视角（§16 需求调整④）**：请求对用户**成功**才计费；失败/崩溃/无法归因的请求**一律不扣用户、运营吃、离线对账留可见性 + 量大告警**。据此**删除**崩溃窗口精细机器（dispatch marker、unbilled/failed_unbilled 双态、120min 收敛）与 orphan 自动吸收——统一坍缩为"New API 消费了但门户没能按成功计费 → 记录 + 可见 + 告警"。同一 docker-compose、容器同主机互联，"已消费未送达"窗口极小。
7. **运行 Key = 热路径外串行创建（§16 需求调整①）**：请求发现无 Key → 入持久队列 + 返回 503 retriable → 单个串行 worker 按 scope 唯一创建（查询优先、崩溃后按名收编）→ 下一请求命中。**单写者串行消除并发创建竞态**，故不需要 epoch fencing/prev 名/尝试级命名/janitor 收敛/退休状态机——这些在 review-log 里是为"并发热路径创建"建的，串行后全坍缩。
8. **计费桶归一化**：四端点 usage → 五桶（非缓存输入/缓存读/缓存写 5m/缓存写 1h/输出），逐字段映射见 §5.1；OpenAI 系 cached 子集扣除、Anthropic 系直映、reasoning 归输出桶。
9. **价格版本**：`model_price_version` 存五维显式单价；发布对 input/output 硬方向校验（门户 ≥ New API，参照价来自 pricing 同步），cache 维度由**管理员锁定 + 复核的成本快照**保证（不建价格证据推导系统，§32 减配）。证据不足的模型 v1 不卖。
10. **充值**：订单 PAID 事务内写 `wallet_ledger` 充值流水（`order_no` 幂等）+ 停写充值 credit；`apipool_ledger_entry` + 兑换码链路原样保留为阶段一远端推送凭证。双写受 `WALLET_LEDGER_WRITE_ENABLED` 硬开关（默认 dormant，打开条件=备份恢复演练证据在案）。
11. **后台任务**：`src/instrumentation.ts` 进程内串行循环 + **一把 worker 级 DB 锁**（防 `compose up` 新旧容器并存），**两类 worker**：`usage_worker`（回填 + 超时扫描）、`reconcile_worker`（批量同步 + 对账可见性 + 钱包不变量）。不做每任务 epoch/每行 claim（单写者不需要，§32 减配）。
12. **管理面**：合一到 `/admin/apipool` 工作台（路由发布 / 请求查询 / 钱包流水 / 人工扣费或豁免 / 冻结解冻 / 审计 / 对账差异）。

## 1. 输入与现状校准

### 1.1 需求锚点

行为边界由需求 v6 决定，与实现强相关的锚点：决策 6/7/8/9/13/16（凭证全剥离、门户独立计价、响应旁路解析 + 日志回填、路径二负余额、micro-USD 带符号追加钱包、计费桶 + 合计 ceil）；7.5.1 端点白名单；8.4 请求账本终态；9 逻辑约束；14 验收。**本 v1 对决策 4/15、7.2.7、7.8/14.5/崩溃窗口有调整，见 §16。**

16.2 实测（本地 new-api v1.0.0-rc.20）：`X-Oneapi-Request-Id` 全场景返回（含 500）；`x-api-key` 在 `/v1/messages` 覆盖 `Authorization`；token 同名可重复创建、`POST /api/token/` 不返回 ID、search 接口可用；`/v1/responses` 原生转发 + usage 字段形态；`GET /api/log/self?request_id=` 精确命中；New API 自带渠道健康检测/自动禁用/故障切换（v1 依赖它，不自建逐渠道验证）。

### 1.2 代码现状关键事实（2026-07-13 核对）

- **DB**：SQLite/libSQL 单文件（`file:/data/portal.db`），drizzle；`schema.ts` 只 re-export `schema.sqlite.ts`；迁移 `migrations_sqlite/0000–0011`。新表 sqlite-only、与 catalog 表先例一致；迁移须同步 journal/snapshot（历史踩过漏落坑）+ 生产只读 SQL 验证字段存在。
- **并发原语**：`.for('update')` 在 SQLite 是 no-op（`core/db/index.ts:134`）；既有范式 = 条件 UPDATE 抢占（`recharge.ts:94-118`）、唯一索引冲突读回、部分唯一索引。原子准入用单语句条件 INSERT，结算用 `db().transaction`。
- **`/v1` 数据面**：门户完全不在数据面上——Caddy `api2.apipool.dev /v1*` 直连 New API `127.0.0.1:3001`（`configure-caddy.sh:115-117`）；无任何 SSE/流式先例。网关、流式透传、入站 Bearer 鉴权全新建。
- **`proxy.ts` matcher** `'/((?!api|trpc|_next|_vercel|.*\\..*).*)'` 不排除 `/v1`——落地 `src/app/v1/` 必须同步改。
- **门户 Key**：`newapi_key_binding` 存远端 token 引用、创建时把远端明文返回用户（`portal.ts:1605`）；模板 `apikey` 表明文存 key、未启用。新建 `portal_api_key`（哈希 + 前缀掩码），模板表不复用。
- **运行凭证**：`client.createKey` 已实现"同名查重复用 + `POST /api/token/:id/key` 取明文"；`findTokenByName` 只扫第一页（`client.ts:829`）；远端 token 名上限 30 字符；`POST` 不返回 ID、按名重查。
- **New API client**：15s 硬超时 + JSON.stringify 改写 body + 仅 GET 重试——**数据面转发不走 client.ts**，另建原生 fetch 路径；client.ts 只服务管理面调用。
- **余额**：现为 New API quota 镜像（`getPortalUsage` → `usage_snapshot.balanceUsd`）；模板 credit 已被显式停用。钱包从零建；credit 不迁移。
- **充值**：`handleCheckoutSuccess`：order→PAID + credit 入账同事务；New API 加额在事务外不抛错；`apipool_ledger_entry` 以 `order_no` 唯一幂等 + claim + `remoteAttemptAt` 证据链。钱包充值流水挂进 PAID 事务；远端推送原样复用。
- **定价**：`catalog_model_price`（基准价，无 cache 维度）+ `catalog_group.newapiGroupRatio*`（分组倍率同步）+ `catalog_model_listing`（展示价，hide-until-confirmed）。结算价独立为 `model_price_version`。
- **配置/部署**：`configure-caddy.sh:46` 只从 shell 环境读 `APIPOOL_API_UPSTREAM`、`deploy.sh:48` 不导出；`docker-compose.prod.yml:7-22` environment allowlist 不含任何新变量——切流方案必须改这两处（§13）。
- **后台任务**：全仓无 cron/调度先例；`billing-ledger.test.ts` 已有"真实 libSQL + 全量迁移"测试先例。

### 1.3 部署与切流点

```text
现状：Client ─ api2/v1* ─▶ Caddy ─▶ New API :3001（门户不经手）
目标：Client ─ api2/v1* ─▶ Caddy ─▶ 门户网关 :3000 ─▶ New API（容器内网 http://new-api:3000）
```

切流 = Caddy `APIPOOL_API_MODE` 从 `legacy` 切到 `portal`，且封 `newapi.apipool.dev/v1*`。门户容器访问 New API 用 compose 内网名，不出宿主机回环。

## 2. 总体架构

### 2.1 组件

网关 route handler → Key 鉴权 + 凭证剥离 → 路由/价格版本解析 → 原子准入（request_ledger）→ 运行 Key 查找（无则入队 + 503）→ 剥离注入 + 原生 fetch 流式转发 → usage 旁路提取 → 原子结算（wallet）。后台：instrumentation 串行循环（usage_worker / reconcile_worker / credential_worker）+ 管理面。协议适配、渠道选择、上游重试、**渠道健康检测**仍由 New API 承担；网关对请求/响应体只读不写。

### 2.2 网关宿主选型

**采用 Next.js Route Handler（同进程）**。理由：单 VPS 单容器、独立服务无一期隔离收益；网关与钱包/凭证/账本共享同一 SQLite 文件与 drizzle schema，同进程消除跨容器共享问题；Node runtime 原生支持 `Response(ReadableStream)` 流式下发与 `fetch` 流式上行。工程约束：`src/features/gateway/server/*` 不 import `next/*`、入口签名 `(req: Request) => Promise<Response>`，Route Handler 只是壳。故障隔离靠代码边界 + 发布验收 + 回滚路径。

### 2.3 路由文件与 middleware

- 新增 `src/app/v1/[...path]/route.ts`：导出 GET/POST，全部委托 `gateway/server/handler.ts`，`export const dynamic = 'force-dynamic'`。catch-all 内白名单 switch，非白名单 404（需求 7.5.1，不透传）。
- `src/proxy.ts` matcher 改为 `'/((?!api|v1|trpc|_next|_vercel|.*\\..*).*)'` + 守卫测试断言 `/v1/chat/completions` 不命中。
- 网关路径不经 next-intl、不读 session cookie、不设 CDN 缓存头；响应 `Cache-Control: no-store`。
- **协议前缀边界**：一期白名单五端点全在 `/v1`（Anthropic 原生 `/v1/messages` 亦在 `/v1`）。数据面逻辑边界 = 白名单前缀集合（一期 `{/v1}`）；未来纳入 Gemini（`/v1beta`、`?key=` 查询串凭证、模型在 URL 路径）时按固定清单扩展（新路由壳 + matcher + Caddy 放行 + 凭证剥离扩展 + 端点表新条目），不是配置开关。

### 2.4 请求处理管线

```text
POST /v1/{chat/completions | responses | messages | embeddings}
 1 extractPortalKey        Authorization: Bearer / x-api-key 双载体
 2 authenticate            portal_api_key 哈希点查 → key.active + user 可用
                           + wallet_account.frozen_at IS NULL + 绑定 != disabled
 3 readBody → 提取 model（受限扫描器只取顶层字段，不整体 JSON.parse）
   resolveRoute            model_route(active) + model_price_version(active) + listing 可调用
 4 coarseBalanceGate       wallet_account.balance_micro_usd > 0 且未冻结
 5 ensureRuntimeCredential 查 active → 命中解密返回；未命中 → 入创建队列 + 503 retriable
 6 atomicAdmission         单语句条件 INSERT request_ledger(open)；失败 → 429
 7 buildUpstreamRequest    剥离全部凭证载体 + hop-by-hop + cookie，注入 Authorization: Bearer <运行Key>
 8 forward                 原生 fetch 流式转发
 9 captureRequestId        响应头 X-Oneapi-Request-Id → 条件 UPDATE 回填 open 行
10 passthrough + sideParse 背压 tap 旁路提取 usage，透传优先
11 finalize                对用户成功 + usage 到 + 请求 ID 到 → 结算(§6.2)
                           成功但 usage 未到 → pending_backfill + 入回填队列
                           对用户失败（任何环节）→ failed_unbilled（不计费、释放槽）
```

粗闸门（4）在运行 Key（5）前一次快速拒绝；原子准入（6）严在运行 Key 后、任何远端推理前。

## 3. 数据模型

全部新表定义在 `src/config/db/schema.sqlite.ts`（sqlite-only）；时间戳 `integer(timestamp_ms)`、ID text UUID、金额 integer micro-USD。迁移 `0012_portal_gateway_v1.sql`（含 journal + snapshot，生产只读 SQL 验证）。

### 3.1 `portal_api_key`

| 字段                                                                                             | 说明                                                |
| ------------------------------------------------------------------------------------------------ | --------------------------------------------------- |
| `id` PK                                                                                          | Key ID（对用户可见管理标识）                        |
| `user_id` FK→user cascade / `group_id` FK→catalog_group                                          | 归属用户 + 绑定门户分组（唯一绑定不可改绑）         |
| `key_hash`                                                                                       | `sha256(明文)` hex，**唯一索引**（鉴权点查键）      |
| `key_prefix`                                                                                     | 展示掩码 `sk-ap-…a1b2`                              |
| `status`                                                                                         | `active`/`disabled`/`deleted`（无 provisioning 态） |
| `name` / `last_used_at`（>60s 才回写）/ `disabled_at` / `deleted_at` / `revoked_reason` / 时间戳 |                                                     |

索引：`uniq(key_hash)`；`(user_id,status)`；部分唯一 `(user_id,name) WHERE status!='deleted'`。明文 `sk-ap-` + 43 字符 base64url，仅创建响应返回一次；创建/禁用/删除纯本地不触远端。

### 3.2 `model_route`（路由版本）

`id`、`portal_group_id` FK、`portal_model_id`（= catalog_model.model_id，恒等）、`newapi_group`（发布快照）、`newapi_model_id`（默认同 portal_model_id）、`version`（每二元组递增）、`status`（`active`/`retired`）、审计字段。索引：部分唯一 `(portal_group_id,portal_model_id) WHERE status='active'`（需求 9.2）；唯一 `(portal_group_id,portal_model_id,version)`。历史版本永不删；请求锁定 version 快照记进 `request_ledger`。

### 3.3 `model_price_version`（价格版本）

`id`/`portal_group_id`/`portal_model_id`/`version`/`status`/审计（同 model_route）+ 五维显式单价（micro-USD / 1M tokens）：`input_micro_usd_per_m`、`cached_input_micro_usd_per_m`、`cache_write_5m_micro_usd_per_m`、`cache_write_1h_micro_usd_per_m`、`output_micro_usd_per_m`（reasoning 归输出桶继承此价）+ `newapi_ref_input/output_micro_usd_per_m`（发布方向校验快照）+ `source_note`。同 active 部分唯一 + 版本唯一。五维发布时全部显式落库、结算永不运行时推导。cache 维度参照价由管理员锁定 + 复核（§9.3），不建证据推导系统。

### 3.4 `runtime_credential`（运行 Key 池，串行创建）

**每 `(portal_user_id, newapi_group)` 恒一行**（唯一约束）。串行 worker 创建，无并发创建者。

| 字段                                                                        | 说明                                                                                             |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `id` PK                                                                     | 行 ID（`request_ledger.credential_id` 引用）                                                     |
| `portal_user_id` + `newapi_group`                                           | **唯一约束 `uniq_runtime_credential_scope`**（需求 9.3）                                         |
| `newapi_user_id`                                                            | 冗余快照（审计/归因）                                                                            |
| `remote_name`                                                               | 稳定名 `rk_{sha256(userId:group)[:24]}`（≤30 字符、由二元组可重算——崩溃后按名收编）              |
| `newapi_token_id` / `token_enc`（AES-256-GCM 复用 crypto.ts）/ `key_masked` | 当前 token；用户禁用/失效时清空                                                                  |
| `status`                                                                    | `pending`（入队待创建）/ `active` / `disabled`（用户禁用）/ `invalid`（远端 401/403 失效待重建） |
| `last_used_at` / `last_error` / 时间戳                                      |                                                                                                  |

索引：`uniq_scope`；`(portal_user_id,status)`。无 lease_epoch/prev_remote_name/generation——串行创建不需要。

### 3.5 `wallet_account` + `wallet_ledger`

`wallet_account`：`user_id` PK、`balance_micro_usd`（带符号物化，不变量 `= Σ wallet_ledger.signed_amount`）、`risk_limit_override`（null→全局默认）、`frozen_at` / `freeze_reason`（`overdraft_auto`/`manual`/`refund_in_progress`）/ `frozen_by`、`updated_at`。行创建：注册钩子 + 首次充值/请求 `INSERT OR IGNORE` + 迁移批量补建。

`wallet_ledger`（**append-only**，行永不 UPDATE）：`id`、`user_id`、`entry_type`（**三类**：`recharge`+ / `request_charge`− / `manual_adjustment`±——冲正/退款/拒付 v1 都用带 reason 的 `manual_adjustment` 表达，§16 减配）、`signed_amount_micro_usd`（带符号非零，服务层按类型强校验方向）、`balance_after_micro_usd`（事务内快照）、`request_ledger_id`（扣费关联）、`order_no`（充值关联）、`idempotency_key`、`operator_user_id` / `reason`（manual 必填）、`created_at`。约束：部分唯一 `(request_ledger_id) WHERE entry_type='request_charge'`（同请求最多一条扣费）；部分唯一 `(order_no) WHERE entry_type='recharge'`；`uniq(idempotency_key)`（可空）；`(user_id,created_at)`。余额闭合唯一公式 `期末 = 期初 + Σ signedAmount`。

### 3.6 `request_ledger`（请求账本 + 风险占用事实源）

| 字段组   | 字段                                                                                                                                                                                                                                                                          |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 标识     | `id` PK（`preq_{uuidv7}`，对外错误体透出）；`newapi_request_id`（`X-Oneapi-Request-Id`，**唯一索引**可空——需求 9.6 唯一键；禁写日志接口动态排名 id）                                                                                                                          |
| 归属     | `user_id` notNull；`portal_key_id`/`portal_group_id`/`portal_model_id`；`newapi_group`/`newapi_model_id`/`credential_id`/`route_version`/`price_version_id`（锁定快照，需求 7.2.4/7.8）                                                                                       |
| 请求     | `endpoint`、`is_stream`、`http_status`、`error_code`、`stream_aborted`                                                                                                                                                                                                        |
| 状态     | `status`：`open`/`pending_backfill`/`settled`/`failed_unbilled`；`resolved_at`（卡住/孤儿人工闭环，置位释放占用）                                                                                                                                                             |
| 时间     | `created_at`（准入时刻）、`responded_at`、`finished_at`、`settled_at`、`updated_at`                                                                                                                                                                                           |
| usage 桶 | `uncached_input_tokens`/`cached_read_tokens`/`cache_write_5m_tokens`/`cache_write_1h_tokens`/`output_tokens`/`reasoning_tokens`（信息性）；`usage_source`（`response`/`log_backfill`）                                                                                        |
| 金额     | `charged_micro_usd`（settled 时写）                                                                                                                                                                                                                                           |
| 回填     | `backfill_attempts`、`next_backfill_at`、`last_backfill_error`                                                                                                                                                                                                                |
| 对账     | `newapi_quota`/`newapi_prompt_tokens`/`newapi_completion_tokens`/`newapi_token_name`、`reconcile_status`（`pending`/`matched`/`token_mismatch`/`amount_mismatch`/`explained`/`waived_by_failure`——最后一值=policy B 下失败/孤儿豁免可见性）、`reconciled_at`/`reconcile_note` |

索引：`uniq(newapi_request_id)`；**风险占用部分索引** `idx_request_ledger_risk(user_id) WHERE status IN ('open','pending_backfill')`；`(status,next_backfill_at)`；`(user_id,created_at DESC)`；`(reconcile_status)`。CHECK：`status IN ('settled') → newapi_request_id IS NOT NULL AND charged_micro_usd IS NOT NULL`。

**v1 精简说明**：无 `orphan_remote`/`unbilled` 终态、无 `orphan_candidate_ids`/`orphan_candidate_count`/`absorbed`/`absorbed_by`/`dispatch_started_at`/`waived_micro_usd` 列——policy B（§0#6）把失败/崩溃/孤儿统一为"不计费 + 对账可见性"，不需要这些机制。孤儿=批量同步发现的"New API 有消费但门户无 settled 记录"，记入对账可见性（`reconcile_status='waived_by_failure'` 的独立观测），不建账本终态。

### 3.7 `portal_admin_audit_log`

`id`、`action`（`routing.publish`/`routing.retire`/`price.publish`/`wallet.adjust`/`wallet.freeze`/`wallet.unfreeze`/`credential.rotate`/`user.disable`/`user.restore`/`ledger.waive`…）、`operator_user_id`、`target_type/target_id`、`before_json/after_json`（脱敏）、`reason`、`created_at`。现有 `newapi_bridge_audit_log` 继续专用于远端桥接调用。

### 3.8 `credential_retirement`（按需，简单待禁用列表）

串行创建下不再是状态机队列，退化为简单列表：`id`、`credential_id` FK、`newapi_token_id`、`reason`（`rotate`/`user_disable`/`invalid`）、`disabled_at`（空=待处理）、`last_error`、`created_at`。`credential_worker` 扫 `disabled_at IS NULL` → 远端 `PUT status_only` 禁用（幂等）→ 置 `disabled_at`；失败重试 + 告警。单写者，无 claim_epoch/状态机。

### 3.9 现有表处置

`newapi_key_binding` 冻结（切流后停创建、观察期后作废、表保留）；`usage_log_snapshot` 停写废弃；`usage_snapshot` 保留供阶段一对账镜像；`credit` 不动（充值停写 credit）；`apipool_ledger_entry` 保留为远端推送幂等凭证；`apikey`（模板）不复用不删；`catalog_model_price` 扩展 4 个可空 cache 基准价列 + `cache_price_note`；`catalog_model` 加 `max_output_tokens`（可空，展示用）；`catalog_group.newapiGroup` 降级为提示字段（路由事实源是 model_route）。

## 4. 网关数据面

### 4.1 模块

```text
src/features/gateway/
├── lib/         endpoints.ts（白名单端点表）/ billing.ts（桶归一化+BigInt）/
│                credentials-strip.ts / errors.ts（双协议错误体）/ sse-parser.ts（受限扫描）
└── server/      handler.ts / auth.ts / routing.ts / admission.ts / credentials.ts /
                 forward.ts / settlement.ts / backfill.ts / jobs.ts / models-endpoint.ts
src/features/wallet/server/    ledger.ts（符号校验+冲正+充值+调整）/ freeze.ts
src/features/routing-admin/server/  route-service.ts（发布管线）/ worst-case.ts（发布时算最坏成本展示，不建表）
```

### 4.2 鉴权与凭证剥离

**入站鉴权**：按 `Authorization: Bearer sk-ap-…` → `x-api-key: sk-ap-…`（Anthropic 习惯）提取；`sha256(token)` 点查 `portal_api_key.key_hash`。校验链（任一失败即拒、不触远端）：key `active` → 否则 401；绑定 `!=disabled`（需求 7.1.6）→ 403；`frozen_at IS NULL` → 403；粗闸门 `balance>0` → 否则 429。1–3 在管线步骤 2、4 在步骤 4（复用步骤 2 读出的 wallet 行）。

**出站剥离注入**（需求决策 6 / 实测 `x-api-key` 覆盖 `Authorization`）：固定剥离 `authorization`/`x-api-key`/`x-goog-api-key`/`api-key`/`cookie`/`x-apipool-*`（含大小写变体）；hop-by-hop 剥 `connection`/`keep-alive`/`transfer-encoding`/`te`/`upgrade`/`trailer`/`proxy-*`/`host`/`content-length`；注入 `Authorization: Bearer <运行 Key>`（不注 x-api-key、不注 New-Api-User）；白名单透传其余 SDK 头；下发响应头剥 `X-Oneapi-Request-Id`/`server` + 加 `X-Apipool-Request-Id`。守卫测试断言到达 mock 上游零凭证残留（需求 14.6）。

### 4.3 转发（`forward.ts`）

不走 client.ts。原生 `fetch(NEWAPI_BASE_URL + path, { method, headers, body: rawBody, signal })`。请求体：入口一次读取（上限 `GATEWAY_MAX_BODY_BYTES` 默认 25MB、超限 413），**受限扫描器只取 model 字段**（不整体 JSON.parse、不形成完整 UTF-16 字符串、不构建对象树）；转发用原始 Buffer 字节。**内存保护（§32 简化）**：请求体硬上限 + 一个进程级并发信号量（`GATEWAY_MAX_INFLIGHT`）；不做精细双预算/放大系数，等真实压测证明越界再上。超时（env 可配）：首包 120s / 非流式整体 300s / 流式空闲 180s、总时长兜底 3600s。abort：客户端断开 → abort 上游 → finalize。

**失败分类（policy B，§0#6）——对用户不成功一律不计费**：

- 连接未建立（DNS/connect 拒绝或超时）→ `failed_unbilled`、释放槽、502；
- 已发出但未收到响应头（reset/首包超时）→ **对用户失败 → `failed_unbilled`、释放槽、不计费、502**；此类若 New API 实际已消费，由离线对账记入 `waived_by_failure` 可见性、运营吃（同主机窗口极小）；
- 收到响应头后异常/流中断 → 已拿到 request ID，按已得 usage 处理：拿到完整 usage 且视为对用户成功（响应已开始下发）→ 结算；否则 → 视失败 `failed_unbilled`；
- 全部路径**绝不重发**（需求 10）。

### 4.4 usage 旁路提取（`sse-parser.ts`）

- 压缩：上游注 `Accept-Encoding: identity`（同机内网压缩无收益）+ 下发头无条件剥 `content-encoding`/`content-length`/`transfer-encoding`（undici 自动解压保留旧头的实测坑）。
- 流式：`upstream.body.tee()`，`toClient` 直接下发（透传优先），`toParser` 由**受限扫描器只抓 `usage` 子树**（不整体 parse）；有界扫描窗口 `GATEWAY_PARSE_BUFFER_MAX` 默认 32MB，超窗放弃提取转日志回填。各端点 usage 位置（16.2）：Chat 末尾 chunk / Responses `response.completed` / Messages `message_start`+`message_delta` 合并。
- 非流式：同样受限扫描抓 usage 子树、原字节下发。
- 终态钩子：`toClient` close/error + 扫描完成共同触发 finalize（保证流结束/中断/超时后必进终态）。

### 4.5 错误契约

网关自产错误双协议体（OpenAI `{"error":{...}}` / Anthropic `{"type":"error",...}`）+ 均含门户请求 ID：401 invalid_api_key / 403 account_disabled·account_frozen / 429 insufficient_quota·concurrency_limit_exceeded(Retry-After:5) / 404 model_not_found·unknown_endpoint / 413 request_too_large / 502 upstream_unavailable·upstream_error / 500 internal_error。上游 4xx/5xx 原样透传 body + 状态码（只读约束；品牌残留见 §17）。

### 4.6 `/v1/models`

鉴权同 §4.2。返回该 Key 分组下**可调用** = 有 active model_route ∧ active model_price_version ∧ catalog listing `isCallable`。OpenAI 兼容 `{object:list,data:[{id,object:model,...}]}`，`id`=门户模型 ID。同一 `getCallableModelIds(groupId)` 供公开 `/models` 页过滤（需求决策 14）。**无渠道验证判定**（§16 调整②：交 New API 健康检测）。

## 5. 计费引擎

### 5.1 计费桶归一化（需求决策 16）

五桶互不重叠：`uncached_input`/`cached_read`/`cache_write_5m`/`cache_write_1h`/`output`（reasoning 记录不独立计价、成本含在 output）。

- **Chat**：`cached_read=prompt_tokens_details.cached_tokens`；`uncached_input=max(0,prompt_tokens−cached_read)`（**prompt_tokens 含 cached 子集须扣**）；`cache_write_5m=prompt_tokens_details.cache_creation_tokens ?? cache_creation_input_tokens`；`cache_write_1h=0`；`output=completion_tokens`。
- **Responses**（16.2 实测字段）：`cached_read=input_tokens_details.cached_tokens`；`uncached_input=max(0,input_tokens−cached_read)`；`cache_write_5m=input_tokens_details.cache_write_tokens`；`output=output_tokens`。
- **Messages**（Anthropic 互斥直映）：`uncached_input=input_tokens`（**不扣**）；`cached_read=cache_read_input_tokens`；`cache_write_5m=cache_creation.ephemeral_5m_input_tokens ?? cache_creation_input_tokens`；`cache_write_1h=cache_creation.ephemeral_1h_input_tokens`；`output=output_tokens`。流式 `message_start`+`message_delta` 以最后出现值覆盖合并。
- **Embeddings**：`uncached_input=prompt_tokens`，其余 0。
- **日志回填口径**：New API 日志的 cache 明细（现 `usage_log_snapshot` 解析逻辑复用）能解析则归一，否则 `uncached_input=prompt_tokens,output=completion_tokens`（cache 桶 0），`usage_source='log_backfill'` 标记降级、对账单列。
- 未映射非零字段 → 告警 + 不入账（宁少勿错，靠对账发现新维度再走白名单扩展）。

### 5.2 金额（唯一舍入点）

```ts
// lib/billing.ts —— BigInt 全程、无中间舍入
chargedMicroUsd = ceilDiv(
    BigInt(uncachedInput)*BigInt(price.inputMicroUsdPerM)
  + BigInt(cachedRead)  *BigInt(price.cachedInputMicroUsdPerM)
  + BigInt(cacheWrite5m)*BigInt(price.cacheWrite5mMicroUsdPerM)
  + BigInt(cacheWrite1h)*BigInt(price.cacheWrite1hMicroUsdPerM)
  + BigInt(output)      *BigInt(price.outputMicroUsdPerM),
  1_000_000n)
if (全桶为 0 且请求成功有 usage) chargedMicroUsd = max(chargedMicroUsd, 1n)  // 隐含最小扣费
```

BigInt 必要（`tokens(≤10^7)×price(≤10^9)` 可达 10^16 超 Number 安全整数）。不足 1 计 1、不跨请求携余数。`request_ledger` 持全桶 + `price_version_id`，`重算===charged` 是对账内部一致性断言（0 容差）。

### 5.3 价格发布与方向校验

发布表单（`/admin/apipool` 内嵌）：五维单价默认 = `catalog_model_price` 基准价（含 cache 列）× 分组折扣、运营可改、空值不许发布。方向校验（需求 7.6.3，发布硬门禁、逐维整数精确比较、参照价向成本侧取整、不借对账容差）：

- input/output：`门户单价 ≥ ceil(base × groupRatioBps/10000)`（参照价来自 pricing 同步，要求目标分组 `pricingSyncStatus='synced'`、模型基准价 `synced/manual(已review)`）；
- cache 三维：参照价 = **管理员锁定 + 复核的成本快照**（§32 减配：不建证据推导系统/TTL/受控方程）——只卖能拿全 usage 维度、或管理员复核过成本快照的模型；证据不足的模型 v1 标"暂不支持"、不发布。

发布事务：retire 旧 active + insert 新版（部分唯一兜底并发）+ 审计。发布即时生效、旧版失败继续生效、回滚=重发历史版本内容为新版本。请求锁定：准入前一次读 active route+price 记版本号快照，全程用快照。

### 5.4 与现有定价的关系

`model_price_version` 是结算唯一事实源；发布时同步写 listing 展示缓存（公开页展示与结算一致）。`resolveEffectiveCatalogPrice` 的"group_ratio 为事实源"废止（需求 13.2.4）；group_ratio 同步降级为方向校验参照数据源。

## 6. 钱包账本与结算

### 6.1 流水类型（需求决策 13，v1 三类）

`recharge`(+，`order_no` 幂等，PAID 事务内)、`request_charge`(−，`request_ledger_id`，结算事务)、`manual_adjustment`(±，`idempotency_key`+reason，管理员冲正/退款/拒付/核销统一走此)。服务层强校验符号、写流水事务内同步更新 `wallet_account.balance += signedAmount` + 回填 `balance_after`。**冲正**：管理端选中扣费流水 → 写 `manual_adjustment(+C, reason='reverse:<原流水id>', idempotency_key=…)` + 审计（界面不提供金额输入框、金额取原流水绝对值）。

### 6.2 请求结算事务（原子核心）

```sql
-- db().transaction；任一步失败整体回滚
UPDATE request_ledger SET status='settled', 桶字段…, charged_micro_usd=?, usage_source=?,
       settled_at=?, updated_at=? WHERE id=:ledgerId AND status IN ('open','pending_backfill');
-- affected=0 → 已被并发/重复处理，整体回滚（幂等）
INSERT INTO wallet_ledger (id, user_id, entry_type='request_charge',
       signed_amount_micro_usd=-:charged, balance_after_micro_usd=:newBal, request_ledger_id=:ledgerId, created_at=?);
UPDATE wallet_account SET balance_micro_usd = balance_micro_usd - :charged, updated_at=? WHERE user_id=:userId;
UPDATE wallet_account SET frozen_at=?, freeze_reason='overdraft_auto', frozen_by='system'
 WHERE user_id=:userId AND frozen_at IS NULL AND balance_micro_usd < -:freezeThreshold;  -- 默认 $10=10_000_000
```

**前置**：`newapi_request_id` 已捕获（§3.6 CHECK 兜底）——无 request ID 不形成终局扣款。入口幂等：响应路径按 ledgerId、回填路径按 newapi_request_id 唯一索引定位。结算不做余额校验（无条件入账、允许负——需求决策 9 路径二）；冻结按扣费后余额。SQLite 单写者无死锁；busy 由调用方重试（①守卫保证不重复入账）。

### 6.3 充值链路（阶段一）

```text
webhook/回调 → handleCheckoutSuccess
  if WALLET_LEDGER_WRITE_ENABLED != true:  完整走现状（order→PAID + credit 入账），不写 wallet
  else updateOrderInTransaction：order→PAID + INSERT wallet_ledger(recharge,+C,order_no) + 停写充值 credit
  事务提交后 applyApipoolRecharge(order)（原样保留：apipool_ledger_entry claim → 兑换码 → topup）
```

`order_no` 部分唯一使 webhook 重放/双入口天然幂等（现有乐观锁 `CREATED/PENDING→PAID` 只一个赢家）。远端等额推送仍事务外不抛错靠 ledger 状态收敛。**阶段二脱钩 v1 不预留开关**（§16 软延后 7.7.4——阶段二自成 feature 时再加）。存量测试账户余额用 `manual_adjustment` 设期初值，不伪造 recharge。

### 6.4 粗闸门与冻结

粗闸门读 `wallet_account` 单行点查（不缓存——结算后立即可见比省点查更重要，需求 15.6）；物化行与流水一致性由同事务保证 + `reconcile_worker` 每小时 `balance == Σ signedAmount` 自检（不一致告警不自动修，需求 7.9.4）。自动冻结阈值 `GATEWAY_OVERDRAFT_FREEZE_MICRO_USD` 默认 $10；解冻仅管理端人工（`freeze.ts::unfreeze`，权限 + reason + 审计——fail-closed 守卫配解封出口）。

## 7. 风险占用与原子准入（需求决策 15）

### 7.1 占用谓词

**无独立计数器、无内存状态**，由 `request_ledger` 行状态派生：

```sql
RISK_HOLDING ≔ status IN ('open','pending_backfill')
```

事实源即持久化账本（重启/多进程天然一致）；部分索引 `idx_request_ledger_risk` 使 COUNT = O(未决数)。**v1 说明**：policy B 下失败即释放、孤儿不建账本终态，故谓词只剩 open/pending_backfill（比 review-log 的 v7 简单——无 orphan/unbilled 分支）。`pending_backfill` 占槽防"串行制造未回填消费"（成功但用量未定、钱未扣期间不放行新的）。

### 7.2 原子准入（单语句）

```sql
INSERT INTO request_ledger (id, user_id, portal_key_id, portal_group_id, portal_model_id,
   newapi_group, newapi_model_id, credential_id, route_version, price_version_id,
   endpoint, is_stream, status, created_at, updated_at)
SELECT :id, :userId, :keyId, :groupId, :modelId, :newapiGroup, :newapiModelId, :credId,
   :routeVer, :priceVerId, :endpoint, :isStream, 'open', :now, :now
 WHERE (SELECT COUNT(*) FROM request_ledger
         WHERE user_id=:userId AND status IN ('open','pending_backfill')) < :riskLimit;
-- rowsAffected=1 → 准入成功；0 → 429，且此后不发任何远端请求
```

原子性（需求 P0-D）：SQLite 单条语句原子 + 单写者（WAL 写锁），COUNT 子查询与 INSERT 同语句内、无其他写入窗口，"先查后插"TOCTOU 消除。`:riskLimit = COALESCE(risk_limit_override, 全局默认)` 准入前点查。准入成功即先写 open 记录（含全部快照）→ 崩溃可恢复归属。释放 = 终态迁移本身（条件 UPDATE，`affected=0` 幂等拒绝重复释放）。

### 7.3 边界（诚实声明）

不变量保证边界 = 共享同一 SQLite 文件的进程组（当前单容器 + 同卷多进程均满足）。跨机扩容超出当前部署，先迁 Postgres（准入语句在 PG 下同样单语句原子，迁移不改设计只改方言）。libsql busy 由 busy_timeout 排队，极端超时 503（未插入行=未占槽未转发，可安全重试）。

## 8. 运行 Key 池（热路径外串行创建，§16 需求调整①）

### 8.1 命名

`remoteName = 'rk_' + sha256(`${portalUserId}:${newapiGroup}`).hex.slice(0,24)`（≤27 字符 < 远端 30 上限，由二元组随时重算——崩溃后按名收编）。不含用户可读信息；与旧门户 Key 的 `pk_` 前缀隔离。串行创建无并发，故无需 gen/epoch 代次化。

### 8.2 请求路径（只查、不创建）

```text
ensureRuntimeCredential(userId, newapiGroup):
 1 点查 scope 行 status='active' → 命中解密返回（热路径，一次点查，解密结果 LRU 缓存 10min）
 2 无行 → INSERT (status='pending')；有 pending → 皆返回 503 retriable + 客户端重试
   （创建交串行 credential_worker；首请求几百 ms 后重试命中）
 3 status='disabled' 且绑定仍 disabled → 403；绑定已恢复 → worker 会重建（见 §8.4）
 4 status='invalid' → worker 重建（换新 token）
```

### 8.3 串行创建（`credential_worker`）

单 worker 顺序处理 `status IN ('pending','invalid')` 且需重建的行、或恢复用户的 disabled 行：

```text
a ensurePortalUserBinding()  // 只保证 New API 用户存在/启用/凭据可用；不改用户主分组（决策 P1-1）
b client.createKey({ name: remoteName, group: newapiGroup, unlimited_quota: true })
   // 内置：先按名 findTokensByNameExact → 命中收编（校验后取明文）→ 未命中才 POST 创建
   //   （单写者串行 → 无并发创建者 → 无双 POST 竞态；崩溃后本行仍 pending，下轮按名收编）
   // model_limits 默认不启用（门户是唯一入口 + 路由层已白名单）
c 加密明文 → UPDATE 行 → active（写 token_id/enc/masked）；失败 → last_error + 保持 pending 重试
```

收编校验：`token.group==newapiGroup`、归属当前用户（搜索走用户凭据）、启用、取明文成功；不符 → 标异常（审计 token id）+ 告警人工（不删远端、不盲目重建）。首请求百毫秒级延迟（需求 7.4.6 接受）；后续走 §8.2 步骤 1 热路径。

### 8.4 生命周期

- **用户禁用**（管理员）：绑定 `disabled`（网关即时拒绝）+ 对该用户全部 runtime 行 `UPDATE SET status='disabled', 清空 token 字段` + 持有 token 的入 `credential_retirement(user_disable)`；`credential_worker` 远端禁用。
- **用户恢复**（`restoreNewapiUserBindingForAdmin` 恢复绑定，§16 处置的 R7-P1-1）：绑定恢复后，该用户下一请求命中 disabled 行 + 绑定已恢复 → `credential_worker` 换新 token 重建（§8.2#3）。
- **轮换**（管理端，泄漏应急）：旧 token 入 `credential_retirement(rotate, disabled_at=null)` + 行 status→pending 重建；worker 建新 token、旧的宽限后远端禁用。
- **运行期失效**：转发收 New API 401/403 → 该请求按失败终态、credential 标 `invalid` + 告警；下一请求触发 worker 重建。防抖 5min。
- 运行 Key 永不出现在响应/日志/审计明文（`sanitizeAuditBody` 复用）。

## 9. 路由与价格发布

### 9.1 发布校验（需求 7.2.7 减配为 §16 调整②）

按序校验、任一失败拒绝并结构化返回：① 目标分组存在、倍率有效（pricing 同步）；② 目标分组 ⊆ `UserUsableGroups`（`getPricingSnapshot().usableGroups`——否则运行 Key 能建但推理 403，16.2）；③ 模型调用形态 ∩ 白名单端点 ≠ ∅（`sourceSupportedEndpointTypes`）；④ 价格版本存在 + 方向校验通过（§5.3）。**无逐渠道验证**（交 New API 健康检测 + 人工运营，§16）。发布即时生效、失败旧版继续、回滚=重发历史内容。

### 9.2 最坏成本（需求决策 15 减配为 §16 调整③）

发布时计算 `worst = ceilDiv(contextWindow × max(四输入侧单价) + maxOutputTokens × output, 1e6)` 并展示给运营（"槽上限 × worst = 理论敞口"心算），**不建 `model_worst_case_cost` 表、不做失效 job、不做硬门禁**。实际透支保护 = 风险槽 + $10 冻结（§6.4/§7）。发布要求目标模型 `context_window` 与 `max_output_tokens` 非空。

## 10. 回填、对账与孤儿可见性

### 10.1 后台任务宿主（§32 简化为 2 worker + 1 锁）

`src/instrumentation.ts` 的 `register()`（`NEXT_RUNTIME==='nodejs' && GATEWAY_JOBS_ENABLED!=='false'`）启动串行循环。**一把 worker 级 DB 锁**（`gateway_job_lock`，条件 UPDATE 抢，防 `compose up` 新旧容器并存）——单容器现状退化为无竞争。两类 worker + 一个凭证 worker：

| worker              | 周期                        | 职责                                                                      |
| ------------------- | --------------------------- | ------------------------------------------------------------------------- |
| `usage_worker`      | 5s                          | 定点回填 `pending_backfill`（`?request_id=` 用户上下文）+ `open` 超时扫描 |
| `reconcile_worker`  | 5min（同步）/ 60min（自检） | 批量日志同步 + 孤儿可见性 + 用量层/金额层对账 + 钱包不变量                |
| `credential_worker` | 5s                          | 串行创建/收编运行 Key（§8.3）+ 处理 `credential_retirement` 远端禁用      |

不做每任务 epoch/每行 claim token——单写者不需要；业务写入唯一索引（newapi_request_id/order_no）本就幂等。

### 10.2 定点回填 + 孤儿可见性

**定点回填**（成功但 usage 未到）：`pending_backfill`、`next_backfill_at=now+5s`；调 `GET /api/log/self?request_id=`（新增 client 方法，用户上下文）→ 命中解析 usage + quota 落对账字段 → 结算（§6.2）；日志显式失败 quota=0 → `failed_unbilled`。退避 5s→15s→60s→5min→15min→30min（6 次）；穷尽仍无 → 进人工"卡住请求"队列（`resolved_at` 人工闭环，罕见）。

**孤儿可见性（policy B）**：`reconcile_worker` 批量拉 New API 日志（管理员全量 `GET /api/log/` 或逐绑定用户 `/api/log/self` 兜底，形态实现期 fixture 实测），扫描窗口 `[watermark−10min, now]`：

- 命中已 settled → 补对账字段；命中 pending_backfill/open → 走结算；
- **未命中（孤儿）→ 不建账本终态、不向用户扣费**（policy B）：记入对账可见性（`reconcile_status='waived_by_failure'` 的观测行，含 user/分组/运行 Key/模型/usage/quota），运营吃 + 量大告警。孤儿域限 `rk_` 命名空间；旧 `pk_`/人工 token 日志单列"域外消费"。管理员如查明确为应收，可手工 `manual_adjustment` 扣，但默认不扣。

**sweeper（usage_worker 内）**：`open` 行 `created_at < now − (流式总超时+10min)` 且无 request ID → 视对用户失败 → `failed_unbilled`（policy B：结局未知不向用户扣，运营吃）。

### 10.3 Dashboard 切换

`/dashboard/usage` 明细与 `/dashboard/billing` 改读 `request_ledger`：settled 显金额、open/pending_backfill 显"计费中"、failed_unbilled 显失败不计费。余额改读 `wallet_account`。`usage_log_snapshot` 停写；`usage_snapshot` 余额镜像保留供对账。

### 10.4 对账（§32 简化）

- **用量层（硬核对 0 容差）**：`newapi_prompt_tokens == Σ 输入侧桶` ∧ `newapi_completion_tokens == output`（口径以 fixture 定），不一致 → `token_mismatch` 最高告警。
- **金额层**：内部一致性 `charged == 重算(桶,price_version)`（0 容差）；外部 `|newapi_quota × 2 − Σ(桶×newapiRef)/1e6| ≤ max(10 micro-USD, 1%)` 超差 → `amount_mismatch`，运营复核置 `explained`。
- **失败豁免可见性**：`waived_by_failure` 单列（policy B 下运营吃的量），量大告警——这是"迫使排查真问题"的入口。
- **钱包不变量**：`balance == Σ signedAmount` 每小时自检、不一致告警不自动修。
- 差异处置遵循需求 7.9：留证、根因优先、人工补偿走 §6.1 manual_adjustment（带审计）、永不自动覆盖。

## 11. 管理面与可观测

### 11.1 权限（`core/rbac/permission.ts` + `init-rbac.ts`）

`admin.apipool.routing.read/write`、`admin.apipool.wallet.read/adjust/freeze`、`admin.apipool.reconciliation.read/resolve`。人工资金操作必填 reason + 前端二次确认 + 审计；一期单管理员不建双人审批。

### 11.2 管理工作台（§32 合一）

`/admin/apipool` 单工作台，标签页：**路由**（分组×模型矩阵、当前版本、可调用性、发布向导逐条展示校验结果、版本历史）；**请求**（按门户/真实请求 ID 双向检索 request_ledger 全字段）；**钱包**（用户余额/流水、冻结解冻、人工扣费/冲正/豁免、退款向导）；**对账**（用量层/金额层差异分列、失败豁免可见性、卡住请求/孤儿人工队列、钱包不变量）；**指标**（下表）；**审计**。低频诊断先用脚本/SQL。

### 11.3 指标（SQL 聚合 + 结构化告警日志，不引入 Prometheus）

网关成功率/延迟、路由解析失败、运行 Key 创建次数/耗时/失败、usage 响应内命中率、待回填积压、关联成功率、负余额用户数/透支敞口、429/占用水位/冻结、失败豁免量、对账差异、发布失败。告警最小集：`overdraft_freeze`、`token_mismatch`、`wallet_invariant_broken`、`backfill_backlog_high`、`waived_by_failure_high`、`credential_create_failed`。

## 12. 安全

1. 门户 Key 仅哈希；运行 Key AES-256-GCM（`APIPOOL_CREDENTIALS_SECRET`）仅转发瞬间内存解密；均不出现在响应/日志/审计明文。
2. 数据面收口（需求 11.4）：切流后 New API `/v1` 仅容器内网可达——Caddy `api2`→门户、`newapi.apipool.dev/v1*`→404（部署验收断言）。
3. 传输：门户→New API 走 compose 内网 http；对外 Caddy TLS。
4. 审计全覆盖（需求 11.6）：发布/调额/退款/凭证轮换/用户禁用/冻结解冻全落 `portal_admin_audit_log`。
5. 防绕过自检：部署验收三探测——`newapi.apipool.dev/v1/models`=404、`api2/api/status`=404、`api2/v1/models` 无 Key=401。

## 13. 兼容与迁移

### 13.1 分期

| 期                 | 内容                                                                                                          | 上线影响                                           |
| ------------------ | ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| ① 数据结构与管理面 | 迁移建表；路由/价格发布；门户 Key 管理页；钱包 dormant（`WALLET_LEDGER_WRITE_ENABLED=false`，充值走原事实链） | 不动 `/v1`、不产生真实钱包流水（需求 13.1）        |
| ①.5 钱包激活       | 备份演练门禁通过后，静默窗内打开钱包双写开关 + 展示切 wallet                                                  | 首笔真实钱包流水在此、前置=备份演练证据在案        |
| ② 网关切流         | `/v1` handler + proxy matcher；Caddy `APIPOOL_API_MODE`→portal + newapi 封；Dashboard 切 request_ledger       | 与 ①/①.5 同一门禁；R-P1-7 切流 + 旧 Key 作废后关闭 |
| ③ 对账与纠偏       | 差异报表、人工纠偏/退款 runbook、告警接线                                                                     | ② 后第一对账周期就位                               |

**外部前置门禁（需求非目标第 9 条）**：备份恢复 feature 须在阶段 ① 开工前完成边界定义（含 `APIPOOL_CREDENTIALS_SECRET` 托管边界），在**首笔真实钱包写入（①.5）之前**完成实现 + 真实恢复演练（数据可读、密文可解、`balance==Σledger` 守恒、幂等约束成立），证据入发布验收。

### 13.2 切流步骤（§32：maintenance/fix-forward，无回滚数据面）

Caddy 状态 `APIPOOL_API_MODE ∈ {legacy, maintenance, portal}`，`configure-caddy.sh` 用 `read_env_value()` 读 `.env.deploy`；`docker-compose.prod.yml` allowlist 先加全部新变量。序列（`deploy/cutover.sh` 逐态推进 + deploy lock）：

0. 前置门禁：备份演练证据在案；
1. 预检：代码上线、内网直打 `127.0.0.1:3000/v1/*` live 冒烟、路由/价格已发布；
2. **maintenance 态**：`.env.deploy` 设 `APIPOOL_API_MODE=maintenance` + `APIPOOL_CHECKOUT_ENABLED=false` → 重建容器 + 生成 Caddy（api2 `/v1*`=503、**newapi `/v1*`=404 自此保持**）；探测 `api2/v1/models`=503 ∧ `newapi/v1/models`=404 双通过；
3. 在途排空（活跃连接计数为 0，非日志静默）+ 记录水位（各用户 quota 快照）；
4. ①.5 钱包激活：核验演练证据 → 开 `WALLET_LEDGER_WRITE_ENABLED`+`WALLET_DISPLAY_ENABLED`（重建注入）→ 受控内部路径 smoke 首笔充值双写；充值仍冻结；
5. **portal 态**：`APIPOOL_API_MODE=portal` → 生成 Caddy（api2→3000、newapi 404 保持）→ validate+reload；探测 portal 态 api2=3000 ∧ newapi=404；
6. 验收（三探测 + 真实 SDK + Dashboard + 钱包扣费）通过后才 `APIPOOL_CHECKOUT_ENABLED=true` + 开放外部流量；窗口核验（水位内消费仅 smoke）；
7. 观察期 72h；收尾作废旧 `newapi_key_binding` 远端 token。

**故障处理 = fix-forward**（§32：不维持可重新接单的旧计费数据面）：网关有问题 → 保持/收敛到 maintenance（api2 503、newapi 404），修好前滚；不回 legacy（会重开 newapi 后门）、不把旧 pk\_ 数据面重新接单。镜像/配置可回滚（回上一 `IMAGE_TAG`），但 API 在 maintenance 期间对外 503——无真实用户时可接受。

## 14. 模块/文件改动清单

| 文件/模块                                                              | 类型      | 内容                                                                                                                           |
| ---------------------------------------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `schema.sqlite.ts` + `migrations_sqlite/0012_*`                        | 新增      | §3 八表 + 扩展列 + 索引（journal/snapshot 同步 + 生产只读 SQL 验证）                                                           |
| `src/proxy.ts`                                                         | 修改      | matcher 排除 v1 + 守卫测试                                                                                                     |
| `src/app/v1/[...path]/route.ts`                                        | 新增      | 网关入口壳                                                                                                                     |
| `src/features/gateway/**`                                              | 新增      | §4.1 结构                                                                                                                      |
| `src/features/wallet/**`                                               | 新增      | 流水/物化余额/冻结解冻                                                                                                         |
| `src/features/routing-admin/**`                                        | 新增      | 发布管线 + 最坏成本展示                                                                                                        |
| `src/instrumentation.ts`                                               | 新增      | 串行循环（usage/reconcile/credential worker）+ worker 锁                                                                       |
| `newapi-bridge/server/client.ts`                                       | 扩展      | `getUsageLogByRequestId`、`listAllUsageLogs`、`findTokensByNameExact`（完整分页）；既有不动                                    |
| `newapi-bridge/server/portal.ts`                                       | 修改      | `createPortalApiKey` 重写为本地 Key；用户禁用/恢复挂 runtime 状态迁移；`getPortalUsage` 拆日志明细同步                         |
| `shared/services/payment.ts` + `models/order.ts`                       | 修改      | PAID 事务内写 wallet 充值流水（`WALLET_LEDGER_WRITE_ENABLED` 分支）、停写充值 credit                                           |
| `docker-compose.prod.yml` + 本地 `docker-compose.yml`                  | 修改      | environment allowlist 增全部 `GATEWAY_*`/`WALLET_*`/`APIPOOL_CHECKOUT_ENABLED`/`APIPOOL_API_MODE`；`compose config` 入发布门禁 |
| `deploy/configure-caddy.sh` + `deploy/cutover.sh`（新增）+ `deploy.sh` | 修改/新增 | API_MODE 三态读 `.env.deploy` + `--print-config` fixture；cutover 逐态原子推进                                                 |
| `app/api/apipool/keys/**`、`usage/route.ts`、`billing/route.ts`        | 修改      | Key CRUD 走本地；数据源切 request_ledger/wallet_account                                                                        |
| `app/api/apipool/admin/**` + `app/[locale]/(admin)/admin/apipool/**`   | 新增      | §11.2 工作台 + API                                                                                                             |
| `api-catalog/server/queries.ts`                                        | 修改      | 公开目录叠 `getCallableModelIds`                                                                                               |
| `core/rbac/permission.ts` + `init-rbac.ts`                             | 修改      | §11.1 权限                                                                                                                     |
| `deploy/live-smoke.sh` + `docs/deployment.md`/`07-runbook.md`          | 扩展/修改 | 网关全端点冒烟 + 账本断言；切流 runbook                                                                                        |
| `.env.example` + `deploy/env.production.example`                       | 修改      | 新增 env                                                                                                                       |

新增 env：`GATEWAY_RISK_SLOT_LIMIT=10`、`GATEWAY_OVERDRAFT_FREEZE_MICRO_USD=10000000`、`GATEWAY_MAX_BODY_BYTES`、`GATEWAY_MAX_INFLIGHT`、`GATEWAY_PARSE_BUFFER_MAX`、`GATEWAY_*_TIMEOUT_MS`、`GATEWAY_JOBS_ENABLED`、`WALLET_LEDGER_WRITE_ENABLED=false`、`WALLET_DISPLAY_ENABLED=false`、`APIPOOL_CHECKOUT_ENABLED`、`APIPOOL_API_MODE=legacy`。

## 15. 测试与验证（映射需求第 14 节）

node:test + tsx；DB 测试用"真实 libSQL + 全量迁移"先例（`billing-ledger.test.ts::setupDb`）；网关集成用本地 `http.createServer` 充当 mock New API（可编程 SSE/错误/慢响应/usage 屏蔽）。

**单元**：billing（桶归一化全端点 fixture、cached 子集扣除、BigInt ceil、单 token→1、连续小额逐笔和；未映射告警）；sse-parser（三协议 usage 提取、受限扫描不整体 parse、畸形流不抛）；credentials-strip（全载体零残留、注入唯一 Authorization、响应头剥内部痕迹）；wallet-ledger（三类符号校验、冲正=manual_adjustment 幂等、余额闭合）；errors（双协议 + 请求 ID）。

**集成**：模型级路由（两模型不同分组、重映射后新版/在途旧版）；Key 复用隔离（共享运行 Key、禁用隔离、用户禁用全拒 + 运行 Key 远端禁用）；运行 Key 串行创建（首请求 503→worker 建→命中；并发首请求只产生一次远端创建；崩溃后按名收编不二次创建；用户禁用→恢复→重建；invalid→重建）；原子准入（占用 9/上限 10 并发 2 → 一 open 一 429；两独立进程同文件 DB 一致；准入后 kill 重启槽位仍占、结算单次释放）；负余额（余额 1 大请求放行→转负→后续 429）；串行待回填（usage 屏蔽全占满→429，任一结算释放恢复）；透支冻结（越阈冻结 + 解冻）；回填（usage 屏蔽→定点回填秒级 settled、重复回填幂等）；**policy B 失败不计费**（连接未建/发出无响应头/流中断 → failed_unbilled 不扣、对账 waived_by_failure 可见；孤儿→不扣用户、记可见性）；发布门禁（UserUsableGroups 外拒、无端点拒、价格方向违反拒）；结算幂等（同 request ID 双路径只入账一次）。

**Live 冒烟**（切流前后各跑）：本地建 Key（断言无远端调用）；OpenAI SDK Bearer + Anthropic SDK x-api-key 全端点非流/流式；断言真实请求 ID 捕获、settled、钱包扣费=桶×价格重算、到达 New API 无门户 Key 载体（抓包/访问日志）、禁用 Key 401、清零钱包 429。

**守卫**：proxy matcher 不吞 v1；公开响应/错误不含 newapiGroup/内部 ID/New API 痕迹；schema 单源纳新表；wallet_ledger 无 UPDATE（append-only grep 守卫）；`configure-caddy.sh --print-config` 三态 fixture（portal 断言 api2=3000∧newapi=404）；`compose config` 断言新变量注入。

## 16. 对需求冻结基线的调整记录（均经用户裁决 2026-07-14）

| #      | 需求原文                                         | v1 调整                                                                                                       | 理由                                                                                                                                                |
| ------ | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| ①      | 决策 4：运行 Key 请求路径内按需创建              | 首次按需触发、**热路径外单串行 worker 创建**（请求入队 + 503 重试）                                           | 并发热路径创建是七轮里 5 轮 P0 的根源；串行消除并发竞态、坍缩 epoch/命名/janitor 全套。仍非批量预建，用户原顾虑（定时任务/活跃长尾）不受影响        |
| ②      | 7.2.7：逐渠道可归因验证 + 变更立即失效           | **作废**——不建 `route_channel_validation`/指纹/guard，路由可用性交 New API 自带健康检测 + 故障切换 + 人工运营 | New API 已有渠道健康检测，门户再建=重复造轮子；残留风险仅"越权直接改 New API 渠道→静默 404"（可用性、可恢复、无资金面），运营纪律可避               |
| ③      | 决策 15：逐模型最坏成本记录=路由发布硬前置       | 降为**发布时计算展示**、不建表/不做失效 job/不做硬门禁                                                        | 实际透支保护是风险槽 + $10 冻结，与该表无关；表只是把理论敞口算出来存着，低量 v1 用不上生命周期。残留：理论敞口估算可能过期，但实际透支仍被冻结兜住 |
| ④      | 7.8/14.5/7.5.2 崩溃窗口：孤儿→精确归用户**扣费** | **计费口径改用户视角**：请求对用户不成功（失败/崩溃/无法归因）→ 不扣用户、运营吃、离线对账留可见性 + 量大告警 | 用户视角口径可解释、争议少；运营吃偏差反逼排查真问题；同 docker-compose 容器同主机、"已消费未送达"窗口极小。消费金额不丢失（仍记录），变的是谁买单  |
| 软延后 | 7.7.4：阶段二脱钩必须预留切换开关                | v1 不建 `WALLET_STAGE` 开关，只写阶段一                                                                       | 阶段二细节未定，现在建开关是投机、大概率返工；充值就一个函数、返工小。阶段二自成 feature 时再加                                                     |

**v1 已知待观察项**（不阻塞，遇真实问题再调）：风险槽模型对"并发规模"的近似仍有粗糙处（正常路径≈并发，pending_backfill 期间略宽）；默认上限 10 需按目标用户群（Claude Code/Codex 类高并发）调，否则正常并发撞 429。

## 17. 已知局限与 spike

**Spike（实现期第一周，均有回退）**：S1 New API 全量日志接口 `GET /api/log/` 字段形态（不成立回退逐绑定用户 `/api/log/self`）；S2 `getPricingSnapshot` cache 计价字段是否可解析（决定 cache 参照价能否自动带、否则纯管理员锁定复核）；S3（非一期）New API 渠道"模型重定向"能力。

**已知局限（接受）**：① 上游错误 body 品牌残留（只读约束，New API 侧文案治理 + 运营巡检）；② SQLite 单文件边界（原子准入保证=同文件进程组，跨机先迁 PG）；③ policy B 下"已消费未送达"运营吃（同主机窗口极小、对账可见、量大告警）；④ 对抗性掐流白嫖从实时拦变离线查 + 人工封（低量 v1 可接受）；⑤ 网关与门户同进程（门户 bug 可波及数据面，代码层可平移结构 + 回滚兜底）。

---

> **评审历史**：本设计历经七轮 Codex 对抗式评审（六轮 NO-GO 逐条闭环 + 第七轮 GO）+ 一轮过度设计专项评审，完整往返（含"正确的目标设计"全量 v7 及每轮 P0/P1 处置）见 [review-log.md](review-log.md)。本文件是据第七轮 GO + 过度设计评审 + 用户裁决收敛的 **v1 落地范围**——正确性承重墙全保留、自动化/自愈/多实例/自动裁决能力按 §16/§32 延后至真实运营信号出现后再作独立 feature。
