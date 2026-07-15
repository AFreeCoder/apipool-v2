# 门户与 New API 路由计费解耦 实现计划（总览）

> 任务正文分三个文件（本文件只是总览与全局契约）：
> - [tasks-01-foundation.md](tasks-01-foundation.md) — Task 1–11（schema/纯函数库/钱包/准入/结算/充值）
> - [tasks-02-gateway.md](tasks-02-gateway.md) — Task 12–21（client 扩展/Key/路由/转发/handler/集成/后台任务）
> - [tasks-03-admin-cutover.md](tasks-03-admin-cutover.md) — Task 22–28（发布管线/管理面/dashboard/部署切流/文档）

**Goal:** 按 [设计 v1](../../design/portal-newapi-routing-billing-decoupling/DESIGN.md) 落地门户自有 `/v1` 网关数据面 + 独立钱包计费，切流后 New API 退化为纯上游。

**Architecture:** Next.js Route Handler（`src/app/v1/[...path]/route.ts` 壳）+ 框架无关转发核心（`src/features/gateway/`），SQLite 单文件事实源（原子准入=单语句条件 INSERT、结算=单事务四语句、钱包 append-only 流水+物化余额），进程内串行后台 worker（instrumentation + DB 锁），Caddy 三态切流。

**Tech Stack:** Next.js 16 / drizzle-orm 0.45 (libSQL sqlite) / node:test + tsx / Caddy(宿主 systemd) / docker compose。

**上游文档:** 需求 v6 冻结基线 `docs/requirements/portal-newapi-routing-billing-decoupling/requirements.md`；设计 v1 `docs/design/portal-newapi-routing-billing-decoupling/DESIGN.md`（本计划行为以设计 §号为准，**下方设计勘误表所列条目除外**）；设计评审往返 `../../design/portal-newapi-routing-billing-decoupling/review-log.md`。

**计划评审状态:** **十八轮 Codex 对抗评审收口 GO（2026-07-15，approve/零实质 findings）**。findings 轨迹 10→5→7→5→7→5→6→2→2→1→1→1→1→2→1→1→3→GO，全部逐条闭环或按用户裁决口径处置（含项目阶段校准防过度评审、多处减配裁决拒绝、第十七轮一次过度设计回退），完整处置见 [review-log.md](review-log.md)。可进入实施；Task 11/21/27 回归测试作为合并与发布门禁。

## 设计勘误表（Errata）

设计文档已冻结（过程文档规范，不回填正文）；下列条目经两轮对抗评审 + 用户裁决后**以本计划为准、覆盖设计原文**。执行者遇任务指令与设计原文冲突时，一律以任务指令 + 本表为准（评审 R2-F1：不声明优先级会让执行者按设计原文回退，重新引入已修复缺陷）。

| # | 设计原文 | 勘误（以计划为准） | 源 |
| --- | --- | --- | --- |
| E1 | §8.3 "b `client.createKey({...})`（内置：先按名 findTokensByNameExact → 命中收编）" | 设计假设 createKey 内置完整分页查名；代码现实（`client.ts:829,1245`）是 `findTokenByName` 只扫第一页且**不过滤 token 状态**，会把刚退休的 disabled 同名 token 重新收编。worker **禁用 `client.createKey`**，改用状态感知创建流程（`createTokenRaw` + 全量查名过滤启用 + 黑名单排除）→ Task 14 | 评审 F5 + R2-F1 |
| E2 | §4.4 "流式：`upstream.body.tee()`" | tee 的慢分支内部队列无界（WHATWG 行为），慢客户端可绕过 maxInflight 耗尽内存。改**单管道 `TransformStream`**（天然背压，同样满足"透传优先 + 旁路提取"意图）→ Task 17；gateway 目录 `\.tee\(` 零命中守卫 | 评审 F7 + R2-F1 |
| E3 | §4.5 "上游 4xx/5xx 原样透传 body + 状态码" | 上游 **401/403**（运行 Key 层故障）不透传、改 502 `upstream_error`——透传会把凭证层错误体误导给持有效门户 Key 的用户；其余 4xx/5xx 仍原样透传 → Task 17 | 第一轮处置 |
| E4 | §3.9 "catalog_model_price 扩展 **4 个**可空 cache 基准价列" | 五维价格闭合只需 **3 个** cache 列（cached_read / cache_write_5m / cache_write_1h），按 3 落地；Spike S2 发现第 4 维再补 → Task 1 | 第一轮处置 |
| E5 | §3.2 `newapi_model_id`"默认同 portal_model_id" | v1 发布**强制恒等**（网关请求体只读不写 §2.1、模型重定向属 §17 S3 非一期；不强制会产生"账本记 B、上游收 A"的归因谎言）；字段与表结构保留给未来 → Task 22 | 评审 F4 |
| E6 | §10.2 孤儿"记入对账可见性（`reconcile_status='waived_by_failure'` 的观测行）" | 观测行落**独立表 `reconcile_orphan_observation`**——`request_ledger` 的非空快照约束（portal_key_id/route_version/price_version_id 等）在孤儿场景原理上不可恢复，不可落主账本；独立表字段集 = 设计原文列举的可恢复集合 → Task 1/21 | 评审 R2-F4 |
| E7 | §3.3 参照快照仅 `newapi_ref_input/output` 两维，而 §10.4 金额层公式按**五桶 × newapiRef** 重算 | 设计自身不自洽：`model_price_version` 的 New API 成本参照补齐**五维**（+cached_input / cache_write_5m / cache_write_1h 三个可空 ref 列，发布事务从 catalog base × ratio 锁定）；金额层对账只读版本快照、永不读活的 catalog 表，ref 缺维且对应桶非零时跳过外部核对（不产生假 mismatch）→ Task 1/21/22 | 评审 R3-F7 |
| E8 | §5.3 方向校验"参照价 = base × **目标分组**倍率"，但倍率数据挂在门户分组行（`catalog_group.newapiGroupRatioBps`），而 `model_route.newapiGroup` 可指向**另一个** New API 分组 | 数据流闭环：价格发布按 **active route 目标分组**（无 active route 则 catalog_group 默认）从 `getPricingSnapshot().groupRatios[目标分组]` 取倍率，`model_price_version` 新增 `ref_newapi_group` 列记录参照分组；路由发布目标分组变化时按新分组倍率**重算 active price 方向校验**，不过则拒绝发布（提示先重发价格版本）——方向门禁与对账参照始终跟随实际路由目标 → Task 1/22 | 评审 R4-F2 |
| E9 | §12/§13 newapi vhost 的 `/v1* → 404` 封锁假设按文本顺序生效 | Caddy 按**固定指令顺序**执行（`basic_auth` 先于 `handle`，与文本位置无关）——Basic Auth 部署下 `/v1* → 404` 会被 401 抢先，切流状态机的 404 门禁确定性卡死。newapi vhost 必须用**两个互斥 `handle`**：`handle /v1*` 固定返回 404（块内无 auth 指令）、无 matcher fallback `handle` 内放 basic_auth/IP guard + 反代——`handle` 组互斥，`/v1*` 命中 404 块后不进 auth；Caddyfile 测试用真实 `caddy adapt` 验证路由顺序 → Task 26 | 评审 R11-F1 |

---

## Global Constraints（每个任务隐含遵守）

1. **金额**：全程 micro-USD `integer` 落库；计算用 `BigInt`、无中间舍入；全桶合计后**一次** ceil 到 1 micro-USD；"全桶为 0 且请求成功有 usage"时最小扣费 1（设计 §5.2）。
2. **wallet_ledger append-only**：行永不 UPDATE/DELETE；余额闭合唯一公式 `期末 = 期初 + Σ signed_amount_micro_usd`（设计 §3.5）。
3. **policy B**：请求对用户不成功（失败/崩溃/无法归因）一律不扣用户；`failed_unbilled` 终态 + 对账可见性，绝不自动向用户补扣（设计 §0#6、§4.3）。
4. **结算前置**：`newapi_request_id` 已捕获才允许 settled（表 CHECK 兜底）；全部路径**绝不重发**上游请求（需求 10）。
5. **网关代码边界**：`src/features/gateway/server/*` 与 `lib/*` 不得 `import 'next/*'`；入口签名 `(req: Request) => Promise<Response>`；数据面转发不走 `client.ts`（另建原生 fetch）。
6. **凭证安全**：门户 Key 仅存 `sha256` 哈希；运行 Key `AES-256-GCM`（复用 `encryptCredential/decryptCredential`）；两者永不出现在响应/日志/审计明文（`sanitizeAuditBody` 键名规则已覆盖 key/token/secret/credential）。
7. **SQLite 并发纪律**：`.for('update')` 是 no-op（`src/core/db/index.ts:134`）；并发控制只允许三种既有范式——单语句原子（INSERT…SELECT）、条件 UPDATE + `.returning()` 判空、唯一索引冲突读回。
8. **schema/迁移**：新表只写 `src/config/db/schema.sqlite.ts`（sqlite-only，与 catalog 先例一致）；`id` = text UUID（`getUuid()`）、时间戳 `integer(..., { mode: 'timestamp_ms' })`、迁移必须同步 journal + snapshot（用 `pnpm db:generate --name …`，禁止只写 .sql）。
9. **env 纪律**：每个新 env 变量三处同步——`.env.example`、`deploy/env.production.example`、`docker-compose.prod.yml` + `docker-compose.yml` 两份 environment allowlist（漏 allowlist = 容器拿不到）；代码读取统一经 `src/features/gateway/lib/config.ts` 直读 `process.env`（沿用 `crypto.ts:20-26` 先例，不进 envConfigs、避免双源漂移）。
10. **测试**：node:test + tsx；DB 测试复制 `tests/newapi-bridge/billing-ledger.test.ts:9-36` 的 setupDb 范式（真实 libSQL + 顺序执行全量迁移 + 设 env 后动态 import）；单文件跑法 `NODE_OPTIONS='--conditions react-server' tsx --test tests/<dir>/<file>.test.ts`。
11. **对外泄漏**：网关响应/错误体不得含 `newapiGroup`、内部表 ID、New API 品牌头（`X-Oneapi-Request-Id`/`server` 下发前剥除）。
12. **提交**：每任务至少一次 commit，格式 `feat(gateway): 中文描述` / `test(...)` / `chore(deploy)`，风格与仓库近期提交一致。

## 新增 env 变量总表（Task 3 一次接线，后续任务只引用）

| 变量 | 默认 | 用途 |
| --- | --- | --- |
| `GATEWAY_RISK_SLOT_LIMIT` | `10` | 每用户风险占用槽上限（设计 §7） |
| `GATEWAY_OVERDRAFT_FREEZE_MICRO_USD` | `10000000` | 透支自动冻结阈值（$10） |
| `GATEWAY_MAX_BODY_BYTES` | `26214400` | 请求体上限 25MB，超限 413 |
| `GATEWAY_MAX_INFLIGHT` | `16` | 进程级并发信号量（评审 R13-F1：**入站内存上限 = MAX_INFLIGHT × MAX_BODY_BYTES**，16×25MB≈400MB 稳态；按 VPS 可用内存调，勿盲目调高） |
| `GATEWAY_PARSE_BUFFER_MAX` | `33554432` | usage 旁路扫描窗口 32MB |
| `GATEWAY_FIRST_BYTE_TIMEOUT_MS` | `120000` | 首包超时 |
| `GATEWAY_NONSTREAM_TOTAL_TIMEOUT_MS` | `300000` | 非流式整体超时 |
| `GATEWAY_STREAM_IDLE_TIMEOUT_MS` | `180000` | 流式空闲超时 |
| `GATEWAY_HARD_TIMEOUT_MS` | `3600000` | 总时长兜底 |
| `GATEWAY_JOBS_ENABLED` | `true`（缺省即启） | `false` 关闭后台 worker |
| `WALLET_LEDGER_WRITE_ENABLED` | `false` | 充值双写硬开关（dormant） |
| `WALLET_DISPLAY_ENABLED` | `false` | dashboard 余额/账单切 wallet 展示 |
| `APIPOOL_CHECKOUT_ENABLED` | `true`（**fail-closed：仅精确 `true` 开放收款**，缺失/空/非法→关，评审 R16-F1；env 模板 + compose allowlist 必须显式给 `true`） | 冻结充值入口（切流窗口 / 发布 recharge smoke 失败时） |
| `APIPOOL_API_MODE` | `legacy` | Caddy 三态：legacy/maintenance/portal（`.env.deploy` 读取；也注入容器） |

## 跨任务共享接口契约（Interfaces 单一事实源）

执行者只看到自己的任务；相邻任务的名字与类型以本节为准，任务内 Interfaces 与本节不一致时**以本节为准并回报**。

```ts
// ---- schema 常量名（Task 1 产出，src/config/db/schema.sqlite.ts）----
portalApiKey, modelRoute, modelPriceVersion, runtimeCredential,
walletAccount, walletLedger, requestLedger, portalAdminAuditLog,
credentialRetirement, gatewayJobLock, reconcileOrphanObservation

// ---- src/features/gateway/lib/config.ts（Task 3）----
export function gatewayConfig(): {
  riskSlotLimit: number; overdraftFreezeMicroUsd: number;
  maxBodyBytes: number; maxInflight: number; parseBufferMax: number;
  firstByteTimeoutMs: number; nonstreamTotalTimeoutMs: number;
  streamIdleTimeoutMs: number; hardTimeoutMs: number;
  newapiBaseUrl: string; jobsEnabled: boolean;
}
export function walletLedgerWriteEnabled(): boolean
export function walletDisplayEnabled(): boolean
export function checkoutEnabled(): boolean

// ---- src/features/gateway/lib/endpoints.ts（Task 4）----
export type GatewayEndpointKey = 'chat_completions' | 'responses' | 'messages' | 'embeddings' | 'models'
export type GatewayProtocol = 'openai' | 'anthropic'
export interface GatewayEndpoint { key: GatewayEndpointKey; method: 'GET' | 'POST'; upstreamPath: string; protocol: GatewayProtocol; billable: boolean }
export function resolveEndpoint(method: string, pathSegments: string[]): GatewayEndpoint | null

// ---- src/features/gateway/lib/errors.ts（Task 4）----
export type GatewayErrorCode = 'invalid_api_key' | 'account_disabled' | 'account_frozen'
  | 'insufficient_quota' | 'concurrency_limit_exceeded' | 'model_not_found' | 'unknown_endpoint'
  | 'request_too_large' | 'request_timeout' | 'invalid_request' | 'upstream_unavailable' | 'upstream_error' | 'internal_error'
  // request_timeout(408)：读体 idle/总时长超时（评审 R3-F3）；invalid_request(400)：model 键重复/转义歧义（评审 R6-F1）
export function gatewayErrorResponse(protocol: GatewayProtocol, code: GatewayErrorCode,
  opts: { status: number; portalRequestId: string; message?: string; retryAfterSeconds?: number }): Response

// ---- src/features/gateway/lib/billing.ts（Task 5）----
export interface UsageBuckets { uncachedInput: number; cachedRead: number; cacheWrite5m: number; cacheWrite1h: number; output: number; reasoning: number }
export interface PriceVector { inputMicroUsdPerM: number; cachedInputMicroUsdPerM: number; cacheWrite5mMicroUsdPerM: number; cacheWrite1hMicroUsdPerM: number; outputMicroUsdPerM: number }
export function ceilDiv(a: bigint, b: bigint): bigint
export function normalizeUsage(endpoint: GatewayEndpointKey, usage: Record<string, unknown>):
  { buckets: UsageBuckets; unmappedNonZero: string[] }
export function normalizeBackfillUsage(log: { inputTokens: number; outputTokens: number;
  cacheTokens?: number; cacheCreationTokens?: number; cacheCreationTokens5m?: number; cacheCreationTokens1h?: number }): UsageBuckets
export function computeChargeMicroUsd(buckets: UsageBuckets, price: PriceVector): bigint

// ---- src/features/gateway/lib/credentials-strip.ts（Task 6）----
export function buildUpstreamHeaders(incoming: Headers, runtimeKey: string): Headers
export function sanitizeDownstreamHeaders(upstream: Headers, portalRequestId: string): Headers

// ---- src/features/gateway/lib/sse-parser.ts（Task 7）----
export type ModelExtraction = { ok: true; model: string } | { ok: false; reason: 'missing' | 'ambiguous' | 'malformed' }
export function extractTopLevelModel(body: Uint8Array): ModelExtraction
  // 字节级 UTF-8 状态扫描（评审 R7-F5：不物化完整字符串——全量 TextDecoder 在 64×25MB 下峰值上 GiB）；
  // 全量 + 转义字节层解码 + 顶层 model 恰好一个（评审 R6-F1：重复键/转义变体 = 计费与上游执行分叉，Go 后值覆盖）；
  // ambiguous/malformed → 400 invalid_request
export interface ExtractedUsage { usage: Record<string, unknown> | null; complete: boolean }
  // complete = 协议级完整标志（评审 R5-F3：Messages 的 message_start 含占位 usage，部分 usage 结算=截断响应被扣费）：
  // chat/embeddings=含 usage 的末尾 chunk 已现；responses=response.completed；messages=见过 message_delta.usage；非流式=子树提取成功
export interface UsageExtractor { push(chunk: Uint8Array): void; finish(): ExtractedUsage; overflowed: boolean }
export function createUsageExtractor(endpoint: GatewayEndpointKey, isStream: boolean, maxBufferBytes: number): UsageExtractor
  // 非流式提取只认协议【根级】usage 路径（评审 R7-F2：任意深度首个 usage 可被 Messages 用户可控
  // tool_use.input 内伪造的低值 usage 命中先于真实值）——非根级命中/结构异常 → complete=false 转 pending_backfill

// ---- src/features/wallet/server/ledger.ts（Task 8）----
export type WalletEntryType = 'recharge' | 'request_charge' | 'manual_adjustment'
export async function ensureWalletAccount(userId: string, tx?: any): Promise<void>
export async function getWalletAccount(userId: string): Promise<any | null>   // walletAccount 行
export async function appendLedgerEntryInTx(tx: any, entry: {
  userId: string; entryType: WalletEntryType; signedAmountMicroUsd: number;
  requestLedgerId?: string; orderNo?: string; idempotencyKey?: string;
  operatorUserId?: string; reason?: string;
}): Promise<{ ledgerId: string; balanceAfterMicroUsd: number }>   // 符号校验+物化余额 UPDATE+INSERT 流水
export async function applyManualAdjustment(input: { userId: string; signedAmountMicroUsd: number;
  reason: string; operatorUserId: string; idempotencyKey: string;   // 幂等键由调用方提供且跨重试稳定（评审 F1）
  audit?: { action: string; targetType: string; targetId?: string; beforeJson?: unknown; afterJson?: unknown };
}): Promise<{ ledgerId: string; balanceAfterMicroUsd: number; alreadyApplied: boolean }>
  // audit 提供时在同一事务内写 portal_admin_audit_log（资金变更与审计原子，评审 F1）
  // 幂等重放必须载荷一致（评审 R5-F6）：readBack 命中后比对 userId/金额/reason/operator，
  // 不一致抛 IdempotencyConflictError（API 层转 409）——同键不同载荷绝不谎报 alreadyApplied
export async function reverseRequestCharge(input: { walletLedgerId: string; operatorUserId: string }):
  Promise<{ ledgerId: string; alreadyApplied: boolean }>          // 冲正=manual_adjustment(+|原扣费|)，幂等键=reverse:<原流水id>

// ---- src/features/wallet/server/freeze.ts（Task 8）----
export async function freezeWallet(input: { userId: string; reason: 'overdraft_auto' | 'manual' | 'refund_in_progress'; frozenBy: string }): Promise<boolean>
export async function unfreezeWallet(input: { userId: string; operatorUserId: string; reason: string }): Promise<boolean>

// ---- src/shared/models/portal-admin-audit.ts（Task 8）----
export async function recordPortalAdminAudit(input: { action: string; operatorUserId: string;
  targetType: string; targetId?: string; beforeJson?: unknown; afterJson?: unknown; reason?: string }, writer?: any): Promise<void>

// ---- src/features/gateway/server/admission.ts（Task 9）----
export interface AdmissionInput { id: string; userId: string; portalKeyId: string; portalGroupId: string;
  portalModelId: string; newapiGroup: string; newapiModelId: string; credentialId: string;
  routeVersion: number; priceVersionId: string; endpoint: GatewayEndpointKey; isStream: boolean }
export async function admitRequest(input: AdmissionInput, riskLimit: number): Promise<boolean>
export async function resolveRiskLimit(userId: string): Promise<number>   // COALESCE(override, env 默认)
export async function captureRequestId(ledgerId: string, newapiRequestId: string): Promise<boolean>
  // 唯一冲突 → false（不可重试）；其余 DB 异常【上抛】由调用方 persistTerminal 退避重试（评审 R5-F2：不吞错）
export async function markFailedUnbilled(ledgerId: string, patch: { httpStatus?: number; errorCode?: string; streamAborted?: boolean }): Promise<boolean>
export async function markPendingBackfill(ledgerId: string, patch: { httpStatus?: number }): Promise<boolean>

// ---- src/features/gateway/server/settlement.ts（Task 10）----
export interface SettlementUsage { buckets: UsageBuckets; usageSource: 'response' | 'log_backfill' }
export type SettleResult = 'settled' | 'already_finalized' | 'not_found'
export async function settleByLedgerId(ledgerId: string, usage: SettlementUsage): Promise<SettleResult>
export async function settleByNewapiRequestId(newapiRequestId: string, usage: SettlementUsage): Promise<SettleResult>

// ---- newapi-bridge client 扩展（Task 12，client.ts 返回对象新增方法）----
findTokensByNameExact(user: NewApiUserCredentials, name: string): Promise<RemoteTokenItem[]>  // 完整分页
getTokenKey(user: NewApiUserCredentials, tokenId: string): Promise<string>                    // 导出取明文（收编用）
createTokenRaw(user: NewApiUserCredentials, input: { name: string; group: string; unlimitedQuota: boolean }): Promise<void>
  // 纯 POST 创建、不做同名预检/复用（评审 F5：worker 状态感知创建原语的底座）
getUsageLogByRequestId(user: NewApiUserCredentials, requestId: string): Promise<RemoteUsageLog | null>
listAdminUsageLogsPage(params: { page: number; startTimestamp: number; endTimestamp: number }): Promise<{ logs: RemoteAdminUsageLog[]; full: boolean }>
  // 管理员日志**单页**（full = 满页、可能还有下一页）；分页循环由 reconcile 时间片驱动、页间 keepAlive（评审 F10 + R2-F3）；spike S1
listUserUsageLogsPage(user: NewApiUserCredentials, params: { page: number; startTimestamp: number; endTimestamp: number }): Promise<{ logs: RemoteUsageLog[]; full: boolean }>
  // 逐用户日志单页（fallback 路径）：显式 page + Unix 秒区间——既有公开 listUsageLogs 不透传 range，
  // 传第三参会被静默忽略造成漏账（评审 R3-F1，已实读 client.ts:1404-1409 验证）

// ---- src/features/gateway/server/auth.ts（Task 13）----
export function generatePortalKey(): { plain: string; hash: string; prefix: string }  // sk-ap- + 43 base64url
export function hashPortalKey(plain: string): string
export function extractPortalKey(headers: Headers): string | null   // Bearer 优先，x-api-key 兜底
export type GatewayAuthResult =
  | { ok: true; key: any; wallet: any }        // portalApiKey 行 + walletAccount 行
  | { ok: false; response: Response }
export async function authenticateGatewayRequest(headers: Headers, protocol: GatewayProtocol, portalRequestId: string): Promise<GatewayAuthResult>

// ---- src/features/gateway/server/credentials.ts（Task 14）----
export function buildRuntimeCredentialName(portalUserId: string, newapiGroup: string): string  // rk_+sha256[:24]
export type EnsureCredentialResult =
  | { status: 'ok'; credentialId: string; runtimeKey: string }
  | { status: 'pending' } | { status: 'disabled' }
export async function ensureRuntimeCredential(userId: string, newapiGroup: string): Promise<EnsureCredentialResult>
export async function runCredentialWorkerOnce(deps?: { client?: any; ensureBinding?: any; keepAlive?: () => Promise<boolean> }): Promise<{ processed: number; failed: number }>
  // keepAlive：jobs 注入的锁续租回调（评审 F8）；每处理一条调用，返回 false 立即中止本轮
export async function disableRuntimeCredentialsForUser(userId: string, reason: 'user_disable'): Promise<void>
export async function markCredentialInvalid(credentialId: string, error: string): Promise<void>
export async function rotateRuntimeCredential(credentialId: string, operatorUserId: string): Promise<void>

// ---- src/features/gateway/server/routing.ts（Task 15）----
export interface ResolvedRoute { routeId: string; routeVersion: number; newapiGroup: string;
  newapiModelId: string; priceVersionId: string; price: PriceVector; portalGroupId: string; portalModelId: string }
export async function resolveActiveRoute(portalGroupId: string, portalModelId: string): Promise<ResolvedRoute | null>
export async function getCallableModelIds(portalGroupId: string): Promise<string[]>

// ---- src/features/gateway/server/forward.ts（Task 16）----
export type ForwardOutcome =
  | { kind: 'no_response'; stage: 'connect' | 'sent'; error: unknown }
  | { kind: 'responded'; upstream: Response; newapiRequestId: string | null }
export async function forwardToUpstream(input: { endpoint: GatewayEndpoint; rawBody: Uint8Array | null;
  headers: Headers; isStream: boolean; clientSignal: AbortSignal }): Promise<ForwardOutcome>

// ---- src/features/gateway/server/handler.ts（Task 17）----
export async function handleGatewayRequest(req: Request, pathSegments: string[]): Promise<Response>

// ---- src/features/gateway/server/jobs.ts（Task 19）----
export function startGatewayJobs(): void
export async function acquireJobLock(holderId: string, staleMs?: number): Promise<boolean>
export async function heartbeatJobLock(holderId: string): Promise<boolean>

// ---- src/features/gateway/server/backfill.ts（Task 20）----
export async function runUsageWorkerOnce(deps?: { client?: any; keepAlive?: () => Promise<boolean> }): Promise<{ backfilled: number; swept: number; exhausted: number }>

// ---- src/features/gateway/server/reconcile.ts（Task 21）----
export async function runReconcileSyncOnce(deps?: { client?: any; keepAlive?: () => Promise<boolean> }): Promise<{ scanned: number; settledByLog: number; orphans: number; truncated: boolean }>
export async function runWalletInvariantCheckOnce(): Promise<{ broken: string[] }>

// ---- src/features/routing-admin/server/route-service.ts（Task 22）----
export interface PublishRouteInput { portalGroupId: string; portalModelId: string; newapiGroup: string;
  newapiModelId?: string; operatorUserId: string;
  remapPrice?: PriceVector & { sourceNote?: string } }
  // remapPrice：目标分组 ≠ active price 的 refNewapiGroup 时【必填】——重映射原子双发
  //（同一事务 retire/insert 价格+路由，评审 R5-F1：分开发布存在鸡生蛋死锁与 ref 错绑窗口）
export interface PublishPriceInput { portalGroupId: string; portalModelId: string; price: PriceVector;
  sourceNote?: string; operatorUserId: string }
export type PublishResult = { ok: true; version: number } | { ok: false; failures: { check: string; message: string }[] }
export async function publishModelRoute(input: PublishRouteInput): Promise<PublishResult>
export async function publishPriceVersion(input: PublishPriceInput): Promise<PublishResult>
export async function retireModelRoute(input: { portalGroupId: string; portalModelId: string; operatorUserId: string; reason: string }): Promise<boolean>

// ---- src/features/routing-admin/server/worst-case.ts（Task 22）----
export function computeWorstCaseMicroUsd(input: { contextWindow: number; maxOutputTokens: number; price: PriceVector }): bigint
```

## 任务索引与依赖

| # | 任务 | 文件 | 依赖 |
| --- | --- | --- | --- |
| 1 | 迁移 0012：十一张新表 + 扩展列 + CHECK + 补建 + schema 守卫 | tasks-01 | — |
| 2 | proxy.ts matcher 排除 /v1 + 守卫测试 | tasks-01 | — |
| 3 | env 接线（envConfigs + example ×2 + gateway lib/config.ts） | tasks-01 | — |
| 4 | endpoints.ts + errors.ts | tasks-01 | 3 |
| 5 | billing.ts 桶归一化 + BigInt 金额 | tasks-01 | 4 |
| 6 | credentials-strip.ts | tasks-01 | — |
| 7 | sse-parser.ts 受限扫描 | tasks-01 | 4 |
| 8 | wallet：ledger.ts + freeze.ts + portal-admin-audit | tasks-01 | 1 |
| 9 | admission.ts 原子准入/终态迁移 | tasks-01 | 1,3 |
| 10 | settlement.ts 结算事务 | tasks-01 | 5,8,9 |
| 11 | 充值链路双写 + 注册钩子 + checkout 开关 | tasks-01 | 8 |
| 12 | client.ts 三个新方法 | tasks-02 | — |
| 13 | portal_api_key：auth.ts + Key CRUD API + api-keys 页 | tasks-02 | 1,4,8 |
| 14 | runtime_credential：ensure + 串行 worker + 生命周期 | tasks-02 | 1,12 |
| 15 | routing.ts + models-endpoint.ts | tasks-02 | 1,5 |
| 16 | forward.ts 流式转发 | tasks-02 | 4,6,7 |
| 17 | handler.ts 管线 + route.ts 壳 | tasks-02 | 9,10,13,14,15,16 |
| 18 | 网关端到端集成测试矩阵 | tasks-02 | 17 |
| 19 | jobs.ts + instrumentation.ts + DB 锁 | tasks-02 | 1 |
| 20 | backfill.ts（usage_worker） | tasks-02 | 10,12,19 |
| 21 | reconcile.ts（reconcile_worker） | tasks-02 | 10,12,19 |
| 22 | 发布管线 route-service.ts + worst-case + 方向校验 | tasks-03 | 1,8 |
| 23 | RBAC 权限 + admin API 全套 | tasks-03 | 8,22 |
| 24 | /admin/apipool 工作台 UI + sidebar + i18n | tasks-03 | 23 |
| 25 | dashboard 数据源切换 + 公开目录 callable 过滤 | tasks-03 | 8,15 |
| 26 | compose allowlist + Caddy 三态 + fixture 测试 | tasks-03 | 3 |
| 27 | deploy/cutover.sh + live smoke 扩展 | tasks-03 | 26 |
| 28 | 文档：runbook/deployment 切流章节 + env 模板终检 | tasks-03 | 26,27 |

分期对应（设计 §13.1）：Task 1–25 全部属于阶段①代码（钱包 dormant、`/v1` 不接流量）；Task 26–28 是阶段①.5/②/③ 的部署与切流工装。**外部前置门禁**：备份恢复演练（独立 feature）必须在打开 `WALLET_LEDGER_WRITE_ENABLED` 前完成——本计划不含它，cutover.sh 会做证据检查。

## 通用工序（所有任务复用，任务内不再重复解释）

- **跑单测**：`NODE_OPTIONS='--conditions react-server' tsx --test tests/<路径>.test.ts`；全量 `pnpm test`。
- **DB 测试模板**：复制 `tests/newapi-bridge/billing-ledger.test.ts:9-36`——`.tmp/<name>.db` + `rm -f` + 设 `DATABASE_PROVIDER/DATABASE_URL/DB_SINGLETON_ENABLED=false/APIPOOL_CREDENTIALS_SECRET` + `createClient().executeMultiple` 按序执行 `src/config/db/migrations_sqlite/*.sql` + **之后**动态 `await import('@/…')`。
- **生成迁移**：改 `schema.sqlite.ts` 后 `pnpm db:generate --name <slug>`（会自动更新 `meta/_journal.json` + 生成 snapshot；meta 缺 0006/0007 snapshot 是历史手写造成，generate 只依赖最新 0011 snapshot，不受影响）；生成后**人工核对** SQL 与设计字段一一对应，手工数据迁移语句用 `--> statement-breakpoint` 追加（0005/0011 先例）。
- **新权限**：同时改 `src/core/rbac/permission.ts` 常量 + `scripts/init-rbac.ts` 种子数组（admin/operator 角色已有 `admin.apipool.*` 通配，无需改角色映射）。
- **admin API 模式**：`export const dynamic = 'force-dynamic'` + `getUserInfo()` + `hasPermission(id, PERMISSIONS.X)` + `respData/respErr` + `withNoStore`（参照 `src/app/api/apipool/admin/adjust-quota/route.ts:16-29`；无 zod，手写清洗）。
- **新 admin 页面**：Server Component + `requirePermission` + `Table`/`TableCard`/`FormCard`（参照 `src/app/[locale]/(admin)/admin/catalog/vendors/page.tsx`）；文案建 `src/config/locale/messages/{en,zh}/admin/<name>.json` 并注册进 `src/config/locale/index.ts` 的 `localeMessagesPaths`；导航改 `messages/{en,zh}/admin/sidebar.json`。
- **主键**：`getUuid()`（`@/shared/lib/hash`）；`request_ledger.id` 用 `preq_` 前缀 + uuidv7（Task 9 在 hash.ts 加 `getUuidV7()`，`import { v7 } from 'uuid'`，uuid@13 已含）。

## 验收对照（设计 §15 → 任务）

- 单元：billing→T5、sse-parser→T7、credentials-strip→T6、wallet-ledger→T8、errors→T4。
- 集成：路由/Key 隔离/串行创建/原子准入/负余额/串行待回填/透支冻结/回填/policy B/发布门禁/结算幂等 → T18（矩阵表内逐条映射）。
- 守卫：proxy matcher→T2、公开响应无内部痕迹→T18、schema 单源→T1、wallet_ledger append-only grep→T8、Caddy 三态 fixture→T26、compose config→T26。
- Live 冒烟 → T27。

## Spike（实现期第一周，见设计 §17）

- **S1**（Task 21 前）：`GET /api/log/`（管理员全量日志）字段形态实测；不成立回退逐绑定用户 `/api/log/self`（Task 12 的 `listAdminUsageLogsPage` 保留、Task 21 时间片驱动器换 fallback 数据源）。
- **S2**（Task 22 前）：`getPricingSnapshot` 是否带 cache 计价字段；决定 cache 参照价能否自动预填（否则纯管理员锁定复核）。
