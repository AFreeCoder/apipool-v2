# 批次二：网关数据面与后台任务（Task 12–21）

> 隶属 [PLAN.md](PLAN.md)。全局约束、共享接口契约、通用工序见 PLAN.md。

---

### Task 12: `client.ts` 扩展三个只读方法 + 导出取明文

**Files:**
- Modify: `src/features/newapi-bridge/server/client.ts`（工厂返回对象加方法；既有方法**不动**——含 `findTokenByName` 只扫第一页的旧行为，旧链路继续用）
- Test: `tests/newapi-bridge/client-gateway-extensions.test.ts`

**Interfaces:**
- Consumes: 既有内部件——`request/requestEnvelope`（`client.ts:758-797`）、`unwrapListItems`、`userAuth/adminAuth`（`client.ts:619-626`）、`toRemoteUsageLog`（`client.ts:931-953`）、`fetchFullKey`（`client.ts:836-849`）、`LIST_PAGE_SIZE=100`、`USAGE_LOG_TYPE_CONSUME=2`。
- Produces（挂到 `createNewApiClient` 返回对象）:

```ts
findTokensByNameExact(user: NewApiUserCredentials, name: string): Promise<any[]>   // 完整分页，返回全部精确同名 token 原始 item
getTokenKey(user: NewApiUserCredentials, tokenId: string): Promise<string>          // 导出 fetchFullKey（收编取明文用；设计清单外最小补充）
createTokenRaw(user: NewApiUserCredentials, input: { name: string; group: string; unlimitedQuota: boolean }): Promise<void>
                                                                                     // 纯 POST /api/token/，不做同名预检/复用（评审 F5）
getUsageLogByRequestId(user: NewApiUserCredentials, requestId: string): Promise<RemoteUsageLog | null>
listAdminUsageLogsPage(params: { page: number; startTimestamp: number; endTimestamp: number }): Promise<{ logs: RemoteAdminUsageLog[]; full: boolean }>
                                                                                     // 管理员日志单页；full=满页（可能还有下一页）。
                                                                                     // 分页循环由 reconcile 时间片驱动、页间 keepAlive（评审 F10 + R2-F3：
                                                                                     // client 内一次拉 200 页既无 keepAlive 又不可续跑，积压时永久失活）
listUserUsageLogsPage(user: NewApiUserCredentials, params: { page: number; startTimestamp: number; endTimestamp: number }): Promise<{ logs: RemoteUsageLog[]; full: boolean }>
                                                                                     // 逐用户日志单页（reconcile fallback 专用；评审 R3-F1：既有公开
                                                                                     // listUsageLogs(user, limit) 不透传 range，传第三参被静默忽略 → 漏账）
```

- `RemoteAdminUsageLog = RemoteUsageLog & { username?: string; requestId?: string }`；`toRemoteUsageLog` 增补 `requestId`（从 `item.other` 的 `request_id` 或顶层字段取——**Spike S1 定字段名**，实现时以 fixture 实测为准，两处候选都读）。
- `listAdminUsageLogsPage` 走管理员 `GET /api/log/?p=N&page_size=100&type=2&start_timestamp=&end_timestamp=`（`adminAuth()`），**只取一页**：`full = items.length === LIST_PAGE_SIZE`。翻页循环、keepAlive、水位推进全部由 Task 21 的时间片驱动器负责——client 保持纯 HTTP 封装、单调用有界。**Spike S1 若不成立**，Task 21 回退逐绑定用户 `/api/log/self`（本方法保留、调用方兜底）。
- `createTokenRaw`：只发 `POST /api/token/`（body 同 `createKey` 内部 POST：`{ name, expired_time: -1, unlimited_quota, group }`），不查名、不取明文——串行 worker 的状态感知创建流程（Task 14）自己负责创建后的按名定位与收编校验，**不复用 `client.createKey`**（其内部 `findTokenByName` 只扫第一页且不过滤状态，会收编刚退休的 disabled token，评审 F5）。

- [ ] **Step 1: 写失败测试**（`options.fetcher` 注入可编程 mock，参照 `client.ts:617`）

```ts
// tests/newapi-bridge/client-gateway-extensions.test.ts —— 关键用例（完整写全）：
test('findTokensByNameExact 翻页到底：第 2 页的同名 token 也能命中', async () => {
  // mock：/api/token/?p=1 返回 100 条无关 token；p=2 返回含两条 name='rk_abc'（一启用一禁用）；p=3 空
  // 断言返回 2 条、fetcher 被调 3 次
});
test('findTokensByNameExact 单页不足 size 即停（不多打一页）', ...);
test('getUsageLogByRequestId：/api/log/self?...&request_id= 精确命中映射 RemoteUsageLog；未命中返回 null', ...);
test('listAdminUsageLogsPage：单页取数、full 标志正确（满页 true / 尾页 false）、映射含 requestId/username（评审 R2-F3）', ...);
test('listAdminUsageLogsPage：每次调用恰发一次 HTTP（分页控制权在调用方）', ...);
test('listUserUsageLogsPage：URL 含显式 start/end_timestamp 与 page、用户上下文（评审 R3-F1）', ...);
test('createTokenRaw：只发一次 POST、不发任何 GET 查名（评审 F5）', ...);
test('getTokenKey：POST /api/token/:id/key 取明文、自动补 sk- 前缀', ...);
```

- [ ] **Step 2: 跑测试确认失败**。
- [ ] **Step 3: 实现**（`createNewApiClient` 内部追加，返回对象挂出）

```ts
  // 完整分页版按名精确查找（旧 findTokenByName 只扫第一页是已知缺陷，串行 worker 收编必须全量）
  async function findTokensByNameExact(user: NewApiUserCredentials, name: string) {
    const matches: any[] = [];
    for (let page = 1; page <= 50; page++) { // 5000 条硬上限防死循环
      const data = await request<any>(`/api/token/?p=${page}&size=${LIST_PAGE_SIZE}`, { auth: userAuth(user) });
      const items = unwrapListItems(data);
      matches.push(...items.filter((item: any) => item?.name === name));
      if (items.length < LIST_PAGE_SIZE) break;
    }
    return matches;
  }

  async function getUsageLogByRequestId(user: NewApiUserCredentials, requestId: string) {
    const data = await request<any>(
      `/api/log/self?p=1&page_size=10&type=${USAGE_LOG_TYPE_CONSUME}&request_id=${encodeURIComponent(requestId)}`,
      { auth: userAuth(user) }
    );
    const items = unwrapListItems(data);
    return items.length > 0 ? toRemoteUsageLog(items[0]) : null;
  }

  // 管理员日志单页（评审 R2-F3）：client 单调用有界；翻页循环/keepAlive/水位推进由 reconcile 时间片驱动
  async function listAdminUsageLogsPage(params: { page: number; startTimestamp: number; endTimestamp: number }) {
    const data = await request<any>(
      `/api/log/?p=${params.page}&page_size=${LIST_PAGE_SIZE}&type=${USAGE_LOG_TYPE_CONSUME}` +
        `&start_timestamp=${params.startTimestamp}&end_timestamp=${params.endTimestamp}`,
      { auth: adminAuth() }
    );
    const items = unwrapListItems(data);
    return {
      logs: items.map((item: any) => ({
        ...toRemoteUsageLog(item),
        username: typeof item.username === 'string' ? item.username : undefined,
      })),
      full: items.length === LIST_PAGE_SIZE,
    };
  }

  // 逐用户日志单页（评审 R3-F1）：fallback 专用——既有 listUsageLogs 不透传 range，禁止在对账路径使用
  async function listUserUsageLogsPage(
    user: NewApiUserCredentials,
    params: { page: number; startTimestamp: number; endTimestamp: number }
  ) {
    const data = await request<any>(
      `/api/log/self?p=${params.page}&page_size=${LIST_PAGE_SIZE}&type=${USAGE_LOG_TYPE_CONSUME}` +
        `&start_timestamp=${params.startTimestamp}&end_timestamp=${params.endTimestamp}`,
      { auth: userAuth(user) }
    );
    const items = unwrapListItems(data);
    return { logs: items.map(toRemoteUsageLog), full: items.length === LIST_PAGE_SIZE };
  }

  // 纯 POST 创建（评审 F5）：不查名、不复用；定位与收编由 worker 的状态感知流程负责
  async function createTokenRaw(user: NewApiUserCredentials, input: { name: string; group: string; unlimitedQuota: boolean }) {
    await request('/api/token/', {
      method: 'POST',
      auth: userAuth(user),
      body: { name: input.name, expired_time: -1, unlimited_quota: input.unlimitedQuota, group: input.group },
    });
  }
```

`toRemoteUsageLog` 返回对象追加 `requestId`（`item.request_id ?? other.request_id`，经与 cache 元数据同款的 `other` JSON 解析；Spike S1 实测后固定取法并留 fixture）。返回对象挂出五个方法 + `getTokenKey: (user, tokenId) => fetchFullKey(user, tokenId)`。

- [ ] **Step 4: 跑测试确认通过**；`tests/newapi-bridge/` 全量不回归。
- [ ] **Step 5: Commit** `feat(newapi-bridge): client 增加网关回填与收编所需只读方法`

---

### Task 13: 门户 Key 本地化 —— `auth.ts` + Key CRUD + api-keys 页

**Files:**
- Create: `src/features/gateway/server/auth.ts`
- Modify: `src/features/newapi-bridge/server/portal.ts`（`createPortalApiKey:1444-1638` 重写为纯本地；`listPortalApiKeys:1693-1733`、`disablePortalApiKey:1763-1855`、`deletePortalApiKey:1857+` 改读写 `portal_api_key`）、`src/app/api/apipool/keys/route.ts` 及 `keys/[id]/*`（薄壳基本不动，随 portal.ts 签名微调）、`src/features/api-console/components/api-key-manager.tsx`（字段适配 keyPrefix + "切流后生效"提示）
- Test: `tests/gateway/auth.test.ts`

**Interfaces:**
- Consumes: Task 1 schema（`portalApiKey`、`newApiUserBinding`、`walletAccount`）、Task 4 `gatewayErrorResponse`、Task 8 `ensureWalletAccount`。
- Produces: PLAN.md 契约 `generatePortalKey/hashPortalKey/extractPortalKey/authenticateGatewayRequest/GatewayAuthResult`；portal.ts 的 `createPortalApiKey` 返回形状**保持** `{ binding: PublicApiKey; plainKey: string }`（前端零改动的兼容层，`keyMasked` 字段填 `keyPrefix` 值）。
- 明文格式（设计 §3.1）：`sk-ap-` + 43 字符 base64url（`randomBytes(32).toString('base64url')`）；掩码 `sk-ap-…{末4位}`；创建/禁用/删除**纯本地不触远端**。
- 鉴权链顺序（设计 §4.2，任一失败即拒、不触远端）：哈希点查不存在或非 active → 401 `invalid_api_key`；`newapi_user_binding.status === 'disabled'` → 403 `account_disabled`（binding 缺行=未禁用，放行）；`wallet.frozen_at` 非空 → 403 `account_frozen`；`wallet.balance_micro_usd <= 0` → 429 `insufficient_quota`（粗闸门，复用同一次读出的 wallet 行）。
- `last_used_at` 距上次 >60s 才回写（防写放大），fire-and-forget。
- 旧 `newapi_key_binding` 冻结：列表接口继续返回旧行并标 `legacy: true`（只读）；创建入口只走新表。

- [ ] **Step 1: 写失败测试**（setupDb；播种 user/binding/wallet）

```ts
// tests/gateway/auth.test.ts —— 关键用例（完整写全）：
test('generatePortalKey：sk-ap- 前缀 + 43 字符 base64url、hash 可复算、两次不同', ...);
test('extractPortalKey：Authorization Bearer 优先；x-api-key 兜底（Anthropic 习惯）；都无 → null', ...);
test('鉴权链 401：不存在的 key / disabled 的 key', ...);
test('鉴权链 403 account_disabled：binding.status=disabled', ...);
test('鉴权链 403 account_frozen：frozen_at 非空', ...);
test('鉴权链 429 insufficient_quota：balance=0', ...);
test('鉴权通过：返回 key 行 + wallet 行；last_used_at 60s 内不回写、超 60s 回写', ...);
test('createPortalApiKey 纯本地：插入哈希行、明文只返回一次、同名未删除重复 → 拒绝', ...);
test('disable/delete：条件 UPDATE 幂等；deleted 后同名可重建（部分唯一 WHERE status!=deleted）', ...);
```

- [ ] **Step 2: 跑测试确认失败**。
- [ ] **Step 3: 实现 `src/features/gateway/server/auth.ts`**

```ts
import 'server-only';
import { createHash, randomBytes } from 'node:crypto';
import { and, eq, lt, or, isNull } from 'drizzle-orm';
import { db } from '@/core/db';
import { newApiUserBinding, portalApiKey, walletAccount } from '@/config/db/schema';
import { gatewayErrorResponse } from '@/features/gateway/lib/errors';
import type { GatewayProtocol } from '@/features/gateway/lib/endpoints';
import { ensureWalletAccount } from '@/features/wallet/server/ledger';

const KEY_PREFIX = 'sk-ap-';
const LAST_USED_WRITE_INTERVAL_MS = 60_000;

export function generatePortalKey() {
  const plain = `${KEY_PREFIX}${randomBytes(32).toString('base64url')}`; // 43 字符随机段
  return { plain, hash: hashPortalKey(plain), prefix: `${KEY_PREFIX}…${plain.slice(-4)}` };
}

export function hashPortalKey(plain: string): string {
  return createHash('sha256').update(plain).digest('hex');
}

export function extractPortalKey(headers: Headers): string | null {
  const bearer = headers.get('authorization');
  if (bearer?.toLowerCase().startsWith('bearer ')) {
    const token = bearer.slice(7).trim();
    if (token) return token;
  }
  const xApiKey = headers.get('x-api-key')?.trim();
  return xApiKey || null;
}

export type GatewayAuthResult =
  | { ok: true; key: any; wallet: any }
  | { ok: false; response: Response };

export async function authenticateGatewayRequest(
  headers: Headers, protocol: GatewayProtocol, portalRequestId: string
): Promise<GatewayAuthResult> {
  const deny = (code: Parameters<typeof gatewayErrorResponse>[1], status: number) =>
    ({ ok: false as const, response: gatewayErrorResponse(protocol, code, { status, portalRequestId }) });

  const plain = extractPortalKey(headers);
  if (!plain) return deny('invalid_api_key', 401);
  const [key] = await db().select().from(portalApiKey)
    .where(eq(portalApiKey.keyHash, hashPortalKey(plain))).limit(1);
  if (!key || key.status !== 'active') return deny('invalid_api_key', 401);

  const [binding] = await db().select({ status: newApiUserBinding.status }).from(newApiUserBinding)
    .where(eq(newApiUserBinding.portalUserId, key.userId)).limit(1);
  if (binding?.status === 'disabled') return deny('account_disabled', 403); // 需求 7.1.6；缺行=未禁用

  await ensureWalletAccount(key.userId);
  const [wallet] = await db().select().from(walletAccount)
    .where(eq(walletAccount.userId, key.userId)).limit(1);
  if (wallet.frozenAt) return deny('account_frozen', 403);
  if (wallet.balanceMicroUsd <= 0) return deny('insufficient_quota', 429); // 粗闸门（设计 §6.4 不缓存）

  // last_used_at 节流回写（fire-and-forget，不阻塞热路径）
  const cutoff = new Date(Date.now() - LAST_USED_WRITE_INTERVAL_MS);
  void db().update(portalApiKey).set({ lastUsedAt: new Date() })
    .where(and(eq(portalApiKey.id, key.id),
      or(isNull(portalApiKey.lastUsedAt), lt(portalApiKey.lastUsedAt, cutoff))))
    .catch(() => {});
  return { ok: true, key, wallet };
}
```

`portal.ts` 重写要点（保持导出名与返回形状）：
- `createPortalApiKey`：group 校验沿用（1449-1456）；同名去重改查 `portalApiKey`（`status != 'deleted'`）；`generatePortalKey()` → `insert(portalApiKey)`（唯一冲突读回报同名错误）；**删除** `ensurePortalUserBinding`/`client.createKey`/`creating_remote` 占位整段远端逻辑；`recordAudit` 保留（action 改 `portal.key.create_local`，requestBody 经 `sanitizeAuditBody` 天然脱敏 key）；返回 `{ binding: toPublicApiKeyFromLocal(row), plainKey: plain }`。
- `listPortalApiKeys`：查 `portalApiKey`（非 deleted）+ 旧 `newApiKeyBinding`（非 deleted，标 `legacy: true`）合并返回；**删除** `syncPortalApiKeyStatuses` 远端同步调用。
- `disablePortalApiKey`/`deletePortalApiKey`：改为对 `portalApiKey` 的条件 UPDATE（`status='disabled', disabledAt=now` / `status='deleted', deletedAt=now`）；legacy 行仍走旧远端路径（冻结期只读，直接拒绝修改并提示）。
- `api-key-manager.tsx`：掩码字段展示 `keyPrefix`；创建成功文案追加"网关切流前新 Key 暂不可调用"（i18n key `dashboard/apiKeys` 补 en/zh）。

- [ ] **Step 4: 跑测试确认通过**；`tests/newapi-bridge/portal.test.ts` 若断言旧远端行为需同步改（改动点在测试内 mock client 的 createKey 断言——改为断言零远端调用）。
- [ ] **Step 5: Commit** `feat(gateway): 门户 Key 本地化（哈希鉴权+纯本地 CRUD）`

---

### Task 14: 运行 Key 池 —— `credentials.ts`（热路径 + 串行 worker + 生命周期）

**Files:**
- Create: `src/features/gateway/server/credentials.ts`
- Modify: `src/features/newapi-bridge/server/portal.ts`（导出 `bindingToUserCredentials:574-588`；`disableNewapiUserBindingForAdmin:1262-1292` 尾部挂 `disableRuntimeCredentialsForUser`）
- Test: `tests/gateway/credentials.test.ts`

**Interfaces:**
- Consumes: Task 1 schema（`runtimeCredential/credentialRetirement`）、Task 12 client 新方法、`encryptCredential/decryptCredential`（`crypto.ts`）、`ensurePortalUserBinding`（`portal.ts:590`）。
- Produces: PLAN.md 契约 `buildRuntimeCredentialName/ensureRuntimeCredential/runCredentialWorkerOnce/disableRuntimeCredentialsForUser/markCredentialInvalid/rotateRuntimeCredential`。
- worker 依赖注入：`runCredentialWorkerOnce(deps?: { client?: NewApiClient; ensureBinding?: typeof ensurePortalUserBinding; keepAlive?: () => Promise<boolean> })`——测试注入 mock；`keepAlive` 由 jobs 注入（评审 F8），缺省为恒 true。

**行为规格（设计 §8）：**
1. 命名：`'rk_' + sha256(\`${portalUserId}:${newapiGroup}\`).hex.slice(0, 24)`（27 字符 < 远端 30 上限，可重算收编）。
2. 热路径 `ensureRuntimeCredential`：点查 scope 行——`active` 且有 `tokenEnc` → 解密返回（**LRU 缓存 10min、上限 1000 条**）；无行 → `INSERT (status='pending') ON CONFLICT DO NOTHING` → 返回 `pending`；`pending`/`invalid` → 返回 `pending`（调用方 503）；`disabled` → 查 binding：仍 disabled → 返回 `disabled`（403）；已恢复 → 条件 UPDATE `disabled→pending` → 返回 `pending`（worker 重建）。
3. 串行 worker 单轮（每处理一条先 `await keepAlive()`，false → 中止本轮，评审 F8）：
   a. 处理 `credential_retirement`（`disabled_at IS NULL`）：`client.disableKey`（幂等 PUT status_only）→ 置 `disabledAt`；失败落 `lastError` 留待下轮 + console 告警。
   b. 扫 `runtime_credential` `status IN ('pending','invalid')` 逐行**串行**，用**状态感知创建流程**（评审 F5：**禁止调 `client.createKey`**——其内部 `findTokenByName` 只扫第一页且不过滤状态，轮换/恢复场景会把刚退休的 disabled 同名 token 重新收编）：
      - `invalid` 行先把旧 `newapiTokenId`（若有）入 retirement（reason `invalid`）并清 token 字段、行转 `pending` 语义继续；
      - `ensureBinding(user)` 保证 New API 用户可用（**不改用户主分组**，决策 P1-1——调用时不传 `requiredNewapiGroup`）；
      - **步骤一（查名收编）**：`findTokensByNameExact(creds, remoteName)` → 过滤**启用** ∧ **排除黑名单 token id**（黑名单 = 本行历史 `newapiTokenId` ∪ `credential_retirement` 中该 credential 的全部 `newapi_token_id`）→ 恰一条：收编校验（`group === newapiGroup`、归属当前用户凭据可见、`getTokenKey` 取明文成功）；多条启用同名或校验不符 → 行置 `lastError='adoption_mismatch:<tokenIds>'` + console 告警人工（**不删远端、不盲目重建**），跳过本行；
      - **步骤二（零命中才创建）**：`createTokenRaw(creds, { name: remoteName, group: newapiGroup, unlimitedQuota: true })` → 重跑步骤一的查名+过滤+校验定位新 token（POST 不返回 ID，16.2；同名新旧并存时"启用 ∧ 非黑名单"唯一锁定新建的那个）；
      - 成功：`encryptCredential(明文)` → 条件 UPDATE 行 `status='active'`、写 `newapiTokenId/tokenEnc/keyMasked/newapiUserId`、清 `lastError`；失败：`lastError` + 保持 `pending` 下轮重试（POST 已发但定位失败 → 下轮步骤一按名收编，不会重复创建）。
4. `markCredentialInvalid`：条件 UPDATE `active→invalid` + `lastError`（5min 防抖：`updatedAt` 距今 <5min 且已 invalid 则跳过）+ 清 LRU。
5. `disableRuntimeCredentialsForUser`：该用户全部行 `UPDATE SET status='disabled'`、持有 token 的先入 retirement（reason `user_disable`）再清 token 字段 + 清 LRU。
6. `rotateRuntimeCredential`（管理端泄漏应急）：旧 token 入 retirement（reason `rotate`）→ 行置 `pending` 清 token 字段 + 清 LRU + `recordPortalAdminAudit(action:'credential.rotate')`。

- [ ] **Step 1: 写失败测试**（setupDb + mock client 注入）

```ts
// tests/gateway/credentials.test.ts —— 关键用例（完整写全）：
test('remoteName 确定性：同 scope 恒等、≤27 字符、rk_ 前缀', ...);
test('热路径：无行 → pending 且行已插；并发两次 ensure 只产生一行（ON CONFLICT）', ...);
test('worker 串行创建：两个 pending 行 → mock createTokenRaw 恰被调 2 次（每 scope 一次）→ 行 active、token 加密可解回', ...);
test('崩溃后收编：行 pending + mock 远端已有同名启用 token → 零 POST、getTokenKey 取明文收编', ...);
test('收编校验失败（group 不符）→ 行留 pending + lastError=adoption_mismatch、不删远端', ...);
test('禁用同名不收编（评审 F5）：远端同名 token 为 disabled（分别放第 1 页与第 2 页两种布局）→ 不收编、走 createTokenRaw 新建、新旧并存时锁定启用且非黑名单的新 token', ...);
test('用户禁用：runtime 行全 disabled、token 字段清空、retirement 入队 → worker 一轮调 disableKey 置 disabledAt', ...);
test('禁用后恢复（评审 F5 场景）：binding 恢复 + ensure 命中 disabled 行 → 行转 pending → worker 新建（旧 disabled token 在黑名单，不被收编，token id 必然更新）', ...);
test('invalid → worker 重建：旧 token 入 retirement 黑名单、新 token active、旧 token id ≠ 新 token id', ...);
test('轮换（评审 F5 场景）：rotate 后旧 token 远端尚未禁用（retirement 未处理）→ worker 仍不收编旧 token（黑名单排除）', ...);
test('keepAlive 中止（评审 F8）：第二条处理前 keepAlive 返回 false → 本轮只处理一条即返回', ...);
test('LRU：active 命中不触 DB 第二次（mock db 计数或改行后 10min 内仍读旧值→失效函数清除后读新值）', ...);
```

- [ ] **Step 2: 跑测试确认失败**。
- [ ] **Step 3: 实现**（核心骨架；完整实现按行为规格写全）

```ts
// src/features/gateway/server/credentials.ts
import 'server-only';
import { createHash } from 'node:crypto';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { db } from '@/core/db';
import { credentialRetirement, newApiUserBinding, runtimeCredential, user as userTable } from '@/config/db/schema';
import { decryptCredential, encryptCredential } from '@/features/newapi-bridge/server/crypto';
import { getUuid } from '@/shared/lib/hash';

export function buildRuntimeCredentialName(portalUserId: string, newapiGroup: string): string {
  return `rk_${createHash('sha256').update(`${portalUserId}:${newapiGroup}`).digest('hex').slice(0, 24)}`;
}

const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX = 1000;
const cache = new Map<string, { credentialId: string; runtimeKey: string; expiresAt: number }>();

export function invalidateCredentialCache(portalUserId: string, newapiGroup?: string) {
  if (newapiGroup) cache.delete(`${portalUserId}:${newapiGroup}`);
  else for (const k of cache.keys()) if (k.startsWith(`${portalUserId}:`)) cache.delete(k);
}
// ensureRuntimeCredential / runCredentialWorkerOnce / disableRuntimeCredentialsForUser /
// markCredentialInvalid / rotateRuntimeCredential 按上方行为规格 1-6 实现
```

`portal.ts` 挂钩（`disableNewapiUserBindingForAdmin` 的 `recordAudit` 之后）：

```ts
  const { disableRuntimeCredentialsForUser } = await import('@/features/gateway/server/credentials');
  await disableRuntimeCredentialsForUser(input.portalUserId, 'user_disable');
```

- [ ] **Step 4: 跑测试确认通过**。
- [ ] **Step 5: Commit** `feat(gateway): 运行 Key 池（热路径外串行创建+按名收编+生命周期）`

---

### Task 15: `routing.ts` 路由解析 + `models-endpoint.ts`

**Files:**
- Create: `src/features/gateway/server/routing.ts`、`src/features/gateway/server/models-endpoint.ts`
- Test: `tests/gateway/routing.test.ts`

**Interfaces:**
- Consumes: Task 1 schema（`modelRoute/modelPriceVersion` + catalog 各表）。
- Produces: PLAN.md 契约 `ResolvedRoute/resolveActiveRoute/getCallableModelIds` + `buildModelsResponse(keyRow, portalRequestId): Promise<Response>`；**并在 `src/features/api-catalog/server/queries.ts` 新增导出共享谓词** `isListingCallable(portalGroupId: string, portalModelId: string): Promise<boolean>`。
- 可调用定义（设计 §4.6 + 评审 R5-F7）：有 active `model_route` ∧ active `model_price_version` ∧ **完整 callable 链**——必须与 `queryListingRows`（`queries.ts:108-202`）语义**同一实现**：`catalogStatus.isCallable` ∧ vendor/group/category/status 全部 `active` ∧ 模型存在 active capability。**禁止在 gateway 重写不完整版本**（漏任一维 = 运营紧急下线该维后模型仍可调仍计费）。落地方式：从 `queryListingRows` 抽出 callable 条件为共享谓词 `isListingCallable`（单模型点查版，完整 join），gateway `resolveActiveRoute`、`getCallableModelIds`、Task 25 的公开目录叠加三处全部调用它。
- **route-price 一致性断言（评审 R5-F1，fail-closed）**：`resolveActiveRoute` 必须校验 `route.newapiGroup === price.refNewapiGroup`——不一致（重映射原子双发的异常残留/并发窗口）→ 返回 null（对外 404 `model_not_found`）+ console.error 告警 `route_price_group_mismatch`，绝不放行错绑快照的请求。

- [ ] **Step 1: 写失败测试**（setupDb；播种 group/model/status(isCallable)/listing/route/price 全链）

```ts
// tests/gateway/routing.test.ts —— 关键用例：
test('resolveActiveRoute：全链就绪 → 返回 route 版本快照 + PriceVector', ...);
test('缺 active price → null；route retired → null；listing 不可调用 → null', ...);
test('紧急下线五维全拒（评审 R5-F7）：分别置 vendor / group / category / status 非 active、删 active capability → resolve=null 且 /v1/models 不含该模型', ...);
test('route-price 分组错绑 fail-closed（评审 R5-F1）：price.refNewapiGroup ≠ route.newapiGroup → null + 告警日志', ...);
test('版本锁定语义：发布 v2（v1 retire + v2 active）后 resolve 返回 v2', ...);
test('getCallableModelIds：只含全链就绪的模型 id', ...);
test('buildModelsResponse：OpenAI list 形态、id=门户模型 ID、无内部字段泄漏', ...);
```

- [ ] **Step 2: 跑测试确认失败**。
- [ ] **Step 3: 实现**

```ts
// src/features/gateway/server/routing.ts
import 'server-only';
import { and, eq } from 'drizzle-orm';
import { db } from '@/core/db';
import { catalogModel, catalogModelListing, catalogStatus, modelPriceVersion, modelRoute } from '@/config/db/schema';
import type { PriceVector } from '@/features/gateway/lib/billing';

export interface ResolvedRoute {
  routeId: string; routeVersion: number; newapiGroup: string; newapiModelId: string;
  priceVersionId: string; price: PriceVector; portalGroupId: string; portalModelId: string;
}

export async function resolveActiveRoute(portalGroupId: string, portalModelId: string): Promise<ResolvedRoute | null> {
  const [route] = await db().select().from(modelRoute)
    .where(and(eq(modelRoute.portalGroupId, portalGroupId), eq(modelRoute.portalModelId, portalModelId), eq(modelRoute.status, 'active')))
    .limit(1);
  if (!route) return null;
  const [price] = await db().select().from(modelPriceVersion)
    .where(and(eq(modelPriceVersion.portalGroupId, portalGroupId), eq(modelPriceVersion.portalModelId, portalModelId), eq(modelPriceVersion.status, 'active')))
    .limit(1);
  if (!price) return null;
  // route-price 分组一致性（评审 R5-F1，fail-closed）：错绑快照绝不放行
  if (price.refNewapiGroup !== route.newapiGroup) {
    console.error('[gateway] route_price_group_mismatch', {
      portalGroupId, portalModelId, routeGroup: route.newapiGroup, priceRefGroup: price.refNewapiGroup,
    });
    return null;
  }
  // 完整 callable 链（评审 R5-F7）：与公开目录同一实现——vendor/group/category/status 全 active
  // + status.isCallable + active capability。禁止本地重写不完整 join。
  const { isListingCallable } = await import('@/features/api-catalog/server/queries');
  if (!(await isListingCallable(portalGroupId, portalModelId))) return null;
  return {
    routeId: route.id, routeVersion: route.version, newapiGroup: route.newapiGroup,
    newapiModelId: route.newapiModelId, priceVersionId: price.id,
    price: {
      inputMicroUsdPerM: price.inputMicroUsdPerM, cachedInputMicroUsdPerM: price.cachedInputMicroUsdPerM,
      cacheWrite5mMicroUsdPerM: price.cacheWrite5mMicroUsdPerM, cacheWrite1hMicroUsdPerM: price.cacheWrite1hMicroUsdPerM,
      outputMicroUsdPerM: price.outputMicroUsdPerM,
    },
    portalGroupId, portalModelId,
  };
}

export async function getCallableModelIds(portalGroupId: string): Promise<string[]> {
  const routes = await db().select({ portalModelId: modelRoute.portalModelId }).from(modelRoute)
    .where(and(eq(modelRoute.portalGroupId, portalGroupId), eq(modelRoute.status, 'active')));
  const out: string[] = [];
  for (const r of routes) {
    if (await resolveActiveRoute(portalGroupId, r.portalModelId)) out.push(r.portalModelId);
  }
  return out.sort();
}
```

```ts
// src/features/gateway/server/models-endpoint.ts
import 'server-only';
import { getCallableModelIds } from './routing';

export async function buildModelsResponse(keyRow: { groupId: string }, portalRequestId: string): Promise<Response> {
  const ids = await getCallableModelIds(keyRow.groupId);
  const body = {
    object: 'list',
    data: ids.map((id) => ({ id, object: 'model', created: 0, owned_by: 'apipool' })),
  };
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-apipool-request-id': portalRequestId },
  });
}
```

- [ ] **Step 4: 跑测试确认通过**。
- [ ] **Step 5: Commit** `feat(gateway): 模型路由解析与 /v1/models`

---

### Task 16: `forward.ts` 原生 fetch 流式转发

**Files:**
- Create: `src/features/gateway/server/forward.ts`
- Test: `tests/gateway/forward.test.ts`

**Interfaces:**
- Consumes: Task 3 `gatewayConfig()`（超时矩阵 + `newapiBaseUrl`）、Task 6 头已由调用方构建。
- Produces: PLAN.md 契约 `ForwardOutcome/forwardToUpstream`。
- 硬约束：**不走 client.ts**；不重试（需求 10）；`X-Oneapi-Request-Id` 从响应头取出。

**超时/中断语义（设计 §4.3 + 评审 F6）：**
- 首包（`fetch` resolve 前）：`firstByteTimeoutMs`，**必须用可清除的 `setTimeout` 驱动独立 `AbortController`，`fetch` resolve 后立即 `clearTimeout`**——禁止 `AbortSignal.timeout()`（不可取消，会在响应头到达后继续掐断超过 120s 的正常长流，评审 F6）；
- 非流式整体 / 流式空闲 / 硬兜底由**调用方（handler）在消费 body 时**控制——forward 只负责到响应头；body 阶段的 abort 只经 `clientSignal`（handler 的组合 controller）传导；
- `clientSignal` abort → abort 上游（`AbortSignal.any` 组合）；
- 失败分类：fetch reject 且 `error.cause.code ∈ {ECONNREFUSED, ENOTFOUND, EAI_AGAIN, UND_ERR_CONNECT_TIMEOUT}` → `stage:'connect'`；其余（含首包超时、reset）→ `stage:'sent'`。两者调用方都按 `failed_unbilled + 502` 处理，stage 仅入 `error_code`。

- [ ] **Step 1: 写失败测试**（`node:http` mock 上游）

```ts
// tests/gateway/forward.test.ts —— 关键用例：
test('正常转发：method/path/body 原样、响应头拿到 X-Oneapi-Request-Id', async () => {
  // mock server 回显收到的 body 长度 + 设 X-Oneapi-Request-Id: rid-1
});
test('连接拒绝（未监听端口）→ no_response stage=connect', ...);
test('首包超时（server 延迟 300ms、env 设 GATEWAY_FIRST_BYTE_TIMEOUT_MS=100）→ no_response stage=sent', ...);
test('响应头及时、body 超过首包阈值仍完整（评审 F6）：env FIRST_BYTE=200ms，server 立即回头、body 分段拖 500ms → 全量收到不被截断', ...);
test('clientSignal abort → 上游请求被 abort（mock server 观察到 req aborted）', ...);
test('SSE 流式响应 body 可读、逐 chunk 到达', ...);
```

- [ ] **Step 2: 跑测试确认失败**。
- [ ] **Step 3: 实现**

```ts
// src/features/gateway/server/forward.ts —— 数据面原生 fetch（不走 client.ts，设计 §4.3）
import 'server-only';
import { gatewayConfig } from '@/features/gateway/lib/config';
import type { GatewayEndpoint } from '@/features/gateway/lib/endpoints';

export type ForwardOutcome =
  | { kind: 'no_response'; stage: 'connect' | 'sent'; error: unknown }
  | { kind: 'responded'; upstream: Response; newapiRequestId: string | null };

const CONNECT_ERROR_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_CONNECT']);

export async function forwardToUpstream(input: {
  endpoint: GatewayEndpoint; rawBody: Uint8Array | null; headers: Headers;
  isStream: boolean; clientSignal: AbortSignal;
}): Promise<ForwardOutcome> {
  const cfg = gatewayConfig();
  // 评审 F6：首包超时必须可清除。AbortSignal.timeout() 不可取消，会在响应头到达后
  // 继续存活并掐断超过阈值的正常长 body —— 这里用 setTimeout + 独立 controller，
  // fetch 一 resolve 就 clearTimeout，body 阶段只受 clientSignal 控制。
  const firstByteController = new AbortController();
  const firstByteTimer = setTimeout(
    () => firstByteController.abort(new Error('first_byte_timeout')),
    cfg.firstByteTimeoutMs
  );
  const signal = AbortSignal.any([input.clientSignal, firstByteController.signal]);
  try {
    const upstream = await fetch(`${cfg.newapiBaseUrl}${input.endpoint.upstreamPath}`, {
      method: input.endpoint.method,
      headers: input.headers,
      body: input.rawBody ?? undefined,
      signal,
      redirect: 'manual',
    });
    return { kind: 'responded', upstream, newapiRequestId: upstream.headers.get('x-oneapi-request-id') };
  } catch (error: any) {
    const code = error?.cause?.code ?? error?.code;
    const stage = CONNECT_ERROR_CODES.has(String(code)) ? 'connect' : 'sent';
    return { kind: 'no_response', stage, error };
  } finally {
    clearTimeout(firstByteTimer); // 响应头已到或已失败，首包计时器使命结束
  }
}
```

注意：首包计时器只覆盖到响应头（finally 清除）；响应头之后的 body 消费超时（流式空闲/整体/硬兜底）由 Task 17 的透传流用计时器实现，abort 用 handler 持有的独立 `AbortController`（传入 `clientSignal` 的来源），forward 不再管。为此把签名的 `clientSignal` 定为 handler 组合后的 controller.signal。

- [ ] **Step 4: 跑测试确认通过**。
- [ ] **Step 5: Commit** `feat(gateway): 原生 fetch 上游转发与失败分类`

---

### Task 17: `handler.ts` 管线组装 + `route.ts` 壳

**Files:**
- Create: `src/features/gateway/server/handler.ts`、`src/app/v1/[...path]/route.ts`
- Test: `tests/gateway/handler.test.ts`（无上游路径；全链路场景在 Task 18）

**Interfaces:**
- Consumes: Task 4/5/6/7 lib 全部、Task 9 `admitRequest/resolveRiskLimit/captureRequestId/markFailedUnbilled/markPendingBackfill`、Task 10 `settleByLedgerId`、Task 13 `authenticateGatewayRequest`、Task 14 `ensureRuntimeCredential/markCredentialInvalid`、Task 15 `resolveActiveRoute/buildModelsResponse`、Task 16 `forwardToUpstream`、`getUuidV7`。
- Produces: `handleGatewayRequest(req, pathSegments): Promise<Response>`。

**管线（设计 §2.4 步骤 1–11 逐条落地）：**

```text
handleGatewayRequest(req, path):
  portalRequestId = `preq_${getUuidV7()}`
  endpoint = resolveEndpoint(req.method, path)
    → null: 404 unknown_endpoint（openai 体）
  protocol = endpoint.protocol
  if endpoint.key === 'models':
    auth → 失败返回其 response；成功 buildModelsResponse(key)
  // —— 计费端点 ——
  inflight 信号量 acquire 失败（计数 >= maxInflight）:
    429 concurrency_limit_exceeded Retry-After:5（设计未细分进程信号量错误码，复用之）
  // 评审 R3-F3：取得信号量后【立即】建立请求级 deadline——hard timer 覆盖含读体在内的全生命周期，
  // 否则 64 个涓流 chunked body 可在无任何计时器的读体阶段永久占满信号量
  upstreamController = new AbortController()
  req.signal.addEventListener('abort', () => upstreamController.abort())        // 客户端断开→全链中止
  hardTimer = setTimeout(() => upstreamController.abort(), hardTimeoutMs)
  try:
    auth = authenticateGatewayRequest(req.headers, protocol, portalRequestId)   // 步骤 2+4
      → !ok: return auth.response（return 前 cleanup()）
    rawBody = readBodyBounded(req, cfg.maxBodyBytes, {                           // 评审 R2-F5 + R3-F3
      idleMs: cfg.streamIdleTimeoutMs,        // chunk 间隔超时（复用现有 env，不新增变量）
      totalMs: cfg.nonstreamTotalTimeoutMs,   // 读体总时长上限
      signal: upstreamController.signal,      // hard deadline / 客户端断开 传导
    })
      → over_limit: 413 request_too_large
      → timeout:    408 request_timeout（reader 已 cancel）
    extraction = extractTopLevelModel(rawBody)                                   // 全量扫描（评审 R6-F1）
      → reason 'missing':               404 model_not_found
      → reason 'ambiguous'/'malformed': 400 invalid_request（重复/转义歧义 model 键 =
                                        计费与上游执行分叉向量，转发前拒绝）
    route = resolveActiveRoute(auth.key.groupId, extraction.model)               // 步骤 3
      → null: 404 model_not_found
    cred = ensureRuntimeCredential(auth.key.userId, route.newapiGroup)           // 步骤 5
      → pending: 503 upstream_unavailable + Retry-After:1（客户端重试，几百 ms 后 worker 已建）
      → disabled: 403 account_disabled
    riskLimit = resolveRiskLimit(userId)
    ledgerId = `preq_…`（= portalRequestId）
    admitted = admitRequest({...全快照}, riskLimit)                              // 步骤 6
      → false: 429 concurrency_limit_exceeded Retry-After:5
    upstreamHeaders = buildUpstreamHeaders(req.headers, cred.runtimeKey)         // 步骤 7
    outcome = forwardToUpstream({ endpoint, rawBody, headers, isStream, clientSignal: upstreamController.signal })  // 步骤 8
    outcome.no_response:
      persistTerminal(() => markFailedUnbilled(ledgerId, { errorCode: `upstream_${stage}` }))
      return 502 upstream_unavailable
    upstream = outcome.upstream
    captured = outcome.newapiRequestId                                            // 步骤 9（评审 R5-F2）
      ? await persistTerminal(() => captureRequestId(ledgerId, outcome.newapiRequestId))
      : false
    // captured 是【DB 持久化结果】而非响应头——capture 失败/冲突的请求不得进入结算或回填，
    // 一律按 failed_unbilled 收束（否则 pending_backfill 行无 newapi_request_id、回填无从定位）
    if upstream 401/403（运行 Key 失效）:
      markCredentialInvalid(cred.credentialId, `upstream_${status}`)（防抖 5min）
      persistTerminal(() => markFailedUnbilled(...))
      void upstream.body?.cancel()      // 评审 R6-F3：被网关错误体替换的上游 body 必须显式取消
      → 502 upstream_error（不透传鉴权错误体防泄漏运行 Key 语境）
    elif !upstream.ok（其余 4xx/5xx）:
      persistTerminal(() => markFailedUnbilled(ledgerId, { httpStatus, errorCode:'upstream_error' }))
      → 原样透传 body+status，但【走与 2xx 同一受控管道】（评审 R6-F3：直接 return upstream.body
        会在 cleanup 已跑后失去全部计时器与并发槽——500 头后停顿的 body 可重复触发耗尽连接；
        非 2xx 的 finalize 退化为纯 cleanup 回调——账本终态已在此处写好，管道只管资源生命周期）
    else（2xx）→ 步骤 10/11 透传+旁路+finalize（下方，finalize 使用 captured）

    【统一规则】所有带 body 的上游响应（2xx 与非 2xx 透传）一律经受控 TransformStream 下发：
    body 计时器 pipeTo 前启动、cleanup 延迟到 body close/error/cancel——
    "提前 return + cleanup"仅适用于【无上游 body】的网关自产错误响应。

  外层异常兜底（评审 R7-F6）：信号量取得后的整段逻辑（鉴权/读体/路由/凭证/准入/转发）包一层
  try/catch + `bodyOwnershipTransferred` 标志（受控管道接管上游 body 时置 true）：
  ── 任一段抛错且【管道尚未接管】→ catch 内幂等 cleanup()（释放信号量+清 hardTimer）；
     若已准入（ledgerId 已写 open）→ persistTerminal(markFailedUnbilled)（收束账本、释放风险槽）；
     返回 500 internal_error。
  ── 管道已接管后的异常由 finalize 负责，catch 不重复释放（bodyOwnershipTransferred 门控）。
  没有这层兜底：module-level 信号量在异常路径永久泄漏（Next 错误边界回收不了进程内计数），
  重复瞬时故障最终让正常请求持续 429 直到重启；准入后异常还留 open 账本。

  终态写入纪律（评审 R5-F2：三次退避只包 2xx finalize 是半修——上游 500 已捕获 id 时，
  单次 markFailedUnbilled 遇 busy 即留 open，sweeper 会转 pending_backfill 让回填按日志错扣）：
  ── persistTerminal(fn) = 全部准入后终态/关联写（capture / markFailedUnbilled / markPendingBackfill /
     settle）共用的有界退避原语——3 次退避（100ms/500ms/2s）、绝不向上抛（穷尽后告警 + sweeper 收敛）、
     返回 fn 最后一次结果（穷尽返回 false/'already_finalized' 语义安全值）。

  资源释放纪律（评审 F7）：信号量 release 与 hardTimer 清理封装为幂等 cleanup()，
  ── 所有"提前 return"路径（错误响应 / no_response / 非流式读完）在 return 前显式调用；
  ── 流式路径 return Response 时**不释放**——cleanup 挂在 finalize 内，流真正 close/error/cancel 才执行。
  禁止 try/finally 包裹 return Response（return 即触发 finally，此刻 body 尚未消费，
  maxInflight 与 hard timeout 会双双失效）。
```

2xx 透传+finalize（流式，评审 F7：**单一背压透传流，禁用 `tee()`**——tee 的慢分支内部队列无界，慢客户端可绕过 maxInflight 耗尽内存）：

```ts
const isStream = (upstream.headers.get('content-type') ?? '').includes('text/event-stream');
const extractor = createUsageExtractor(endpoint.key, isStream, cfg.parseBufferMax);
// 评审 R3-F5 + R4-F1 + R5-F2：全部准入后终态/关联写共用的有界退避原语——
// 绝不向上抛（unhandled rejection 会杀进程）；穷尽后告警、返回安全值，最终收敛靠 sweeper
//（Task 20 既有机制，不另建恢复队列、不做持久化意图 marker——设计 §0#6 明文删除 dispatch marker；
// 残余窗口=三连失败，已记 issues.md 已知局限）。
const TERMINAL_RETRY_DELAYS_MS = [100, 500, 2000];
async function persistTerminal<T>(fn: () => Promise<T>, fallback: T, ctx: string): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();                                 // DB 条件 UPDATE/事务均幂等，重放安全
    } catch (error) {
      if (attempt >= TERMINAL_RETRY_DELAYS_MS.length) {
        console.error(`[gateway] terminal write failed after retries (${ctx}); sweeper will converge`, { error: String(error) });
        return fallback;
      }
      console.error(`[gateway] terminal write failed, retrying (${ctx})`, { attempt, error: String(error) });
      await new Promise((r) => setTimeout(r, TERMINAL_RETRY_DELAYS_MS[attempt]));
    }
  }
}

let finalized = false;
const cleanup = () => { release(); clearTimeout(hardTimer); };                   // 幂等（finalized 门内调用）
const finalize = async (clientCompleted: boolean, aborted: boolean) => {
  if (finalized) return; finalized = true;
  cleanup();                                                                      // 评审 F7：流真正终止才释放信号量/hardTimer
  await finalizeLedger(clientCompleted, aborted);        // 内部全部经 persistTerminal，永不 reject
};
const finalizeLedger = async (clientCompleted: boolean, aborted: boolean) => {
  const { usage, complete } = extractor.finish();
  // 评审 R5-F3：只有【协议级完整】的 usage 才可结算——Messages 的 message_start 含占位 usage，
  // delta 前中断按部分桶扣费 = 截断响应被收费，违反 policy B（设计 §4.3 原文"拿到完整 usage"）。
  // 评审 R5-F2：captured 是 capture 的 DB 持久化结果（管线传入），不是响应头判断。
  if (usage && complete && captured) {
    const { buckets, unmappedNonZero } = normalizeUsage(endpoint.key, usage);
    // 评审 R6-F5（降级裁决）：unmapped 非零维度【仍结算已知桶】——failed_unbilled=协议演进期全免单、
    // pending_backfill 回填同样不识新维度，两条替代路径损失都更大；差额经对账 amount_mismatch 浮现
    //（设计 §5.1 "宁少勿错、靠对账发现"原意），历史差额 manual_adjustment 可补。
    // 告警关键字 unmapped_usage_dimension 进告警最小集（T28 runbook）。
    if (unmappedNonZero.length) console.error('[gateway] unmapped_usage_dimension', { portalRequestId, unmappedNonZero });
    await persistTerminal(() => settleByLedgerId(ledgerId, { buckets, usageSource: 'response' }), 'already_finalized', 'settle');
  } else if (!aborted && clientCompleted && captured) {
    await persistTerminal(() => markPendingBackfill(ledgerId, { httpStatus: upstream.status }), false, 'pending');   // 成功但 usage 未到/不完整 → 回填裁决
  } else if (!captured) {
    console.error('[gateway] request id not persisted', { portalRequestId });
    await persistTerminal(() => markFailedUnbilled(ledgerId, { httpStatus: upstream.status, errorCode: 'missing_request_id', streamAborted: aborted }), false, 'failed');
  } else {
    // 中断且 usage 不完整（含仅 message_start 的部分 usage）→ 不计费
    await persistTerminal(() => markFailedUnbilled(ledgerId, { httpStatus: upstream.status, errorCode: 'stream_interrupted', streamAborted: true }), false, 'failed');
  }
};
// 单管道：upstream.body → TransformStream（enqueue 前旁路喂 extractor + 重置 idle 计时器）→ Response body。
// 背压天然成立：客户端消费速度经 readable 反压 transform，再经 pipeTo 反压 upstream/TCP —— 无任何无界队列。
// 评审 R5-F4：body 计时器必须在【进入 pipeTo 前】启动——首包计时器已随响应头清除，
// 若等首个 chunk 才 reset，零 chunk 的响应将无任何活动计时器、占满并发直到 1h hard。
// 流式：startIdleTimer()（idleMs=streamIdleTimeoutMs，超时 → upstreamController.abort()），transform 内 resetIdleTimer()；
// 非流式：startBodyTotalTimer()（nonstreamTotalTimeoutMs 固定 deadline，不随 chunk 重置）；
// 两者均纳入 cleanup() 统一清除。
startBodyTimers(isStream);
const passthrough = new TransformStream<Uint8Array, Uint8Array>({
  transform(chunk, controller) {
    extractor.push(chunk);          // 旁路提取（parseBufferMax 有界，超窗自动停止累积）
    if (isStream) resetIdleTimer(); // 只有 idle 随 chunk 重置；非流式 total 是固定 deadline
    controller.enqueue(chunk);      // 透传优先：原字节直达客户端
  },
});
// 评审 R3-F5：finalize 已内部吞错（永不 reject），链尾仍挂 .catch 防御未知路径
upstream.body!.pipeTo(passthrough.writable, { signal: upstreamController.signal })
  .then(
    () => finalize(true, false),    // 上游读尽 + 全部送达 → 正常终态
    () => { upstreamController.abort(); return finalize(false, true); }  // 客户端 cancel / 上游中断 / 计时器 abort
  )
  .catch((error) => console.error('[gateway] finalize pipeline error', { portalRequestId, error: String(error) }));
return new Response(passthrough.readable, { status: upstream.status, headers: sanitizeDownstreamHeaders(upstream.headers, portalRequestId) });
```

（客户端断开 → Response body（readable）cancel → pipeTo 以 destination 错误 reject 并 cancel 源，catch 里再显式 `upstreamController.abort()` 兜底；finalize 幂等由 `finalized` 标志与 DB 条件 UPDATE 双保险。**非流式 2xx 同样走上述 passthrough 管道**（评审 R3-F4：`arrayBuffer()` 无上限全量物化，64 并发可 OOM 同进程门户）——两条路径统一，内存有界于 extractor 窗口（`parseBufferMax`，超窗 `overflowed` → finalize 自然走 pending_backfill 回填，透传不受影响）；响应头已剥 content-length（Task 6），chunked 下发。）

信号量实现（module-level）：

```ts
let inflight = 0;
function tryAcquire(max: number): boolean { if (inflight >= max) return false; inflight++; return true; }
function release() { inflight = Math.max(0, inflight - 1); }
```

有界读体（评审 R2-F5：`await req.arrayBuffer()` 会先全量缓冲再检查，chunked/伪造 Content-Length 可绕过 25MB 硬上限 × 64 inflight 打爆同进程门户——设计 §4.3"硬上限"的本意就是有界读取）：

```ts
// 评审 R2-F5 + R3-F3 + R4-F3 + R13-F1 + R14-F1：有界（大小）+ 有时限（idle/total/signal）+ 单块写入。
// 内存纪律：进程入站内存上限 = GATEWAY_MAX_INFLIGHT × maxBytes（默认 16×25MB≈400MB）。
// 【R14-F1 两 bug 修正】① CL 检测必须先判 null——`Number(null)===0` 会把缺头误当声明 0、误拒所有无 CL 请求；
// ② 无 CL 路径【不能】走 chunks+concat（双份瞬时 800MB），与有 CL 路径【统一为单块缓冲】：
//   有 CL → 精确按声明分配（小请求小缓冲）；无 CL → 分配 maxBytes（25MB 保守，chunked 罕见），
//   填充后 subarray 截实收——两路径内存上限均为 maxBytes，聚合恒 = inflight×maxBytes。
type BoundedBody =
  | { ok: true; body: Uint8Array }
  | { ok: false; reason: 'over_limit' | 'timeout' };

async function readBodyBounded(
  req: Request,
  maxBytes: number,
  opts: { idleMs: number; totalMs: number; signal: AbortSignal }
): Promise<BoundedBody> {
  const rawCL = req.headers.get('content-length');
  const declared = rawCL === null ? null : Number(rawCL);          // R14-F1：先判 null，不落 Number(null)===0 陷阱
  const hasValidCL = declared !== null && Number.isFinite(declared) && declared >= 0;
  if (hasValidCL && declared! > maxBytes) return { ok: false, reason: 'over_limit' }; // 快速预检
  if (!req.body) return { ok: true, body: new Uint8Array(0) };

  const reader = req.body.getReader();
  const deadline = Date.now() + opts.totalMs;
  const abortPromise = new Promise<'timeout'>((resolve) => {
    if (opts.signal.aborted) resolve('timeout');
    else opts.signal.addEventListener('abort', () => resolve('timeout'), { once: true });
  });

  // 统一单块缓冲（R14-F1）：有 CL 用声明尺寸、无 CL 用 maxBytes——都只一份、无 chunks+concat 双拷贝。
  const capacity = hasValidCL ? declared! : maxBytes;
  const buf = new Uint8Array(capacity);
  let total = 0;

  try {
    while (true) {
      let idleTimer: ReturnType<typeof setTimeout> | undefined;
      const idlePromise = new Promise<'timeout'>((resolve) => {
        const remaining = Math.min(opts.idleMs, deadline - Date.now());
        idleTimer = setTimeout(() => resolve('timeout'), Math.max(0, remaining));
      });
      const raced = await Promise.race([reader.read(), idlePromise, abortPromise]);
      clearTimeout(idleTimer);
      if (raced === 'timeout') { await reader.cancel().catch(() => {}); return { ok: false, reason: 'timeout' }; }
      const { done, value } = raced as ReadableStreamReadResult<Uint8Array>;
      if (done) break;
      // 超 maxBytes（无 CL 场景）或超声明（有 CL 客户端多发）→ 立即停拉；内存恒有界于 capacity ≤ maxBytes
      if (total + value.byteLength > maxBytes || total + value.byteLength > capacity) {
        await reader.cancel().catch(() => {});
        return { ok: false, reason: 'over_limit' };
      }
      buf.set(value, total);
      total += value.byteLength;
    }
  } catch {
    await reader.cancel().catch(() => {});
    return { ok: false, reason: 'timeout' };            // reader 异常（客户端断连等）按超时类中止
  }
  // 满容量直接返回原缓冲；不足（无 CL 常态 / 有 CL 客户端少发）取实收前缀，避免尾部零字节混入转发
  return { ok: true, body: total === capacity ? buf : buf.subarray(0, total) };
}
```

`src/app/v1/[...path]/route.ts` 壳（Next 16：params 为 Promise）：

```ts
import { handleGatewayRequest } from '@/features/gateway/server/handler';

export const dynamic = 'force-dynamic';

export async function GET(req: Request, ctx: { params: Promise<{ path: string[] }> }) {
  const { path } = await ctx.params;
  return handleGatewayRequest(req, path ?? []);
}

export async function POST(req: Request, ctx: { params: Promise<{ path: string[] }> }) {
  const { path } = await ctx.params;
  return handleGatewayRequest(req, path ?? []);
}
```

- [ ] **Step 1: 写失败测试**（setupDb；不依赖上游的路径）

```ts
// tests/gateway/handler.test.ts —— 关键用例：
test('非白名单端点 404 unknown_endpoint（POST /v1/audio/speech、GET /v1/chat/completions）', ...);
test('无 Key 401；body 超限 413（env 覆盖 GATEWAY_MAX_BODY_BYTES=64）', ...);
test('有界读体（评审 R2-F5）：无 Content-Length 的流式 body 超限 → 413 且 reader 在超限点被 cancel（用可观测 pull 计数的 ReadableStream 构造 Request，断言超限后不再拉取）', ...);
test('有界读体：Content-Length 伪造小值、实际 body 超限 → 仍 413（预检不可信、累计计数兜底）', ...);
test('无 model 字段 / 无路由 → 404 model_not_found', ...);
test('重复/转义歧义 model 键 → 400 invalid_request、零转发（评审 R6-F1：mock 上游零请求）', ...);
test('无运行 Key → 503 + Retry-After，且 runtime_credential 已插 pending 行', ...);
test('信号量占满 → 429 concurrency_limit_exceeded（env GATEWAY_MAX_INFLIGHT=1 + 并发两请求，其一 429）', ...);
test('流式持有信号量（评审 F7）：MAX_INFLIGHT=1，首请求响应头已返回但流未结束 → 第二请求仍 429；流结束后第二请求放行', ...);
test('禁用 tee 守卫（评审 F7）：grep src/features/gateway/ 中 `.tee(` 零命中', ...);
test('异常不泄漏信号量（评审 R7-F6）：MAX_INFLIGHT=1，注入 resolveActiveRoute/ensureRuntimeCredential 抛错 → 500、信号量释放、第二请求放行；准入后注入抛错 → 账本收束 failed_unbilled、槽释放', ...);
test('慢请求体超时（评审 R3-F3）：env STREAM_IDLE=100ms，chunked body 发一段后停 → 408 request_timeout、信号量释放、后续请求可放行', ...);
test('读体总时长超时（评审 R3-F3）：env NONSTREAM_TOTAL=200ms，body 持续涓流不停 → 408、reader 已 cancel', ...);
test('finalize 故障注入（评审 R3-F5/R4-F1）：注入 settle 首次抛 SQLITE_BUSY → 重试后 settled；连抛 4 次 → 不崩进程（无 unhandled rejection）、行留 open、告警日志存在', ...);
test('中断零扣费（评审 R4-F1）：流中断 + markFailedUnbilled 前两次注入 busy + 远端日志含 usage → 第三次重试写入 failed_unbilled、wallet_ledger 零扣费、后续 runUsageWorkerOnce 不改判', ...);
test('非 2xx 终态同享退避（评审 R5-F2）：上游 500 + 已捕获 id + markFailedUnbilled 首次 busy → 重试后 failed_unbilled、sweeper 零改判、零扣费', ...);
test('capture busy 后成功响应（评审 R5-F2）：captureRequestId 首次注入非 UNIQUE 异常 → persistTerminal 重试成功 → 正常结算关联不丢', ...);
test('capture 穷尽失败 → 请求按 failed_unbilled 收束（不进入 pending_backfill——无 DB 关联无从回填）', ...);
test('部分 usage 不结算（评审 R5-F3）：Messages 流在 message_start 后被掐断 → failed_unbilled、零扣费；message_delta 后掐断 → settled（完整 usage）', ...);
test('响应头后零 chunk（评审 R5-F4）：上游回头后不发 body，env STREAM_IDLE=100ms → 请求被终止、failed_unbilled、信号量释放', ...);
test('handler 及 gateway lib/server 不 import next/*（读文件断言 import 语句）', ...);
```

- [ ] **Step 2: 跑测试确认失败**。
- [ ] **Step 3: 按上述管线实现 handler.ts + route.ts**。
- [ ] **Step 4: 跑测试确认通过**。
- [ ] **Step 5: Commit** `feat(gateway): /v1 数据面管线（鉴权→路由→准入→转发→旁路→终态）`

---

### Task 18: 端到端集成测试矩阵

**Files:**
- Create: `tests/gateway/integration.test.ts`、`tests/gateway/helpers/mock-newapi.ts`

**Interfaces:**
- Consumes: Task 17 `handleGatewayRequest` + 全部下层。
- mock New API：`node:http` server，可编程行为按请求头 `x-test-scenario` 或路径切换：正常 SSE（含 usage 末 chunk）/ usage 屏蔽 / 慢首包 / 半途 destroy / 500 / 401；记录每次请求的完整 headers 与 body 供断言；所有响应设 `X-Oneapi-Request-Id`。
- 播种 helper：user + wallet(balance) + portal key + binding(active) + catalog 全链(group/model/status/listing) + model_route + model_price_version + runtime_credential(active, tokenEnc=encryptCredential('sk-upstream-test'))。

**场景矩阵（设计 §15 集成逐条映射，每场景一个 `test()`，完整写全）：**

| # | 场景 | 关键断言 |
| --- | --- | --- |
| 1 | 非流式 chat 成功结算 | 200、body 原样、`request_ledger.settled`、`charged = 桶×价 重算`、`wallet_ledger` 一条、余额闭合 |
| 2 | 流式 messages 成功（message_start+delta 合并） | SSE 透传逐 chunk、settled、桶按 Anthropic 直映 |
| 3 | 模型级路由：两模型→不同 newapiGroup | 上游收到的 Bearer 分别 = 两个 runtime key |
| 4 | 重映射：发布 v2 后新请求锁 v2 快照 | `route_version=2`、在途 v1 行结算仍按 v1 price |
| 5 | Key 复用隔离 | 同用户两 Key 共享 credential；禁 Key A → A 401、B 正常 |
| 6 | 用户禁用全拒 + credential 退休 | binding disabled → 403；runtime 行 disabled；retirement 有行 |
| 7 | 运行 Key 串行创建闭环 | 首请求 503 → `runCredentialWorkerOnce`（mock client 一次创建）→ 重试 200 |
| 8 | 原子准入端到端 | 占 9 + 并发 2 → 一 200 一 429（`Retry-After: 5`） |
| 9 | 负余额路径二 | 余额 1 micro 放行 → settle 转负 → 下一请求 429 insufficient_quota |
| 10 | 串行待回填占满 | usage 屏蔽 ×limit → pending_backfill 占满 → 429；settle 一个 → 恢复 |
| 11 | 透支冻结 + 解冻出口 | 越阈 settle → frozen → 403 account_frozen → `unfreezeWallet` → 放行 |
| 12 | policy B：连接未建 | 上游关停 → 502、`failed_unbilled`、零 wallet 流水 |
| 13 | policy B：流中断 usage 未到 | 半途 destroy → `failed_unbilled`、`stream_aborted=true`、不扣费 |
| 14 | 流中断的完整性分界（评审 R5-F3 改写） | Messages：`message_delta.usage` 后 destroy → settled（完整）；`message_start` 后 destroy → `failed_unbilled` 零扣费（占位 usage 不结算） |
| 15 | 上游 500 透传 | **500 原样透传** body+status（只读约束）、`failed_unbilled` 不扣费 |
| 16 | 上游 401 → credential invalid | 502 upstream_error（不透传）、credential `invalid`、下一请求 503 → worker 重建 |
| 17 | 结算幂等双路径 | 响应结算后再 `settleByNewapiRequestId` → `already_finalized`、流水一条 |
| 18 | 凭证零残留（需求 14.6） | mock 收到的 headers：无 `sk-ap-`、无 cookie/x-api-key、`authorization=Bearer sk-upstream-test`、`accept-encoding=identity` |
| 19 | 响应无内部痕迹 | 响应头无 `x-oneapi-request-id`/`server`、有 `x-apipool-request-id`；错误体不含 `newapiGroup` 值与 `newapi` 字样 |
| 20 | /v1/models 过滤 | 只返回全链就绪模型；无 Key → 401 |
| 21 | 长流不被首包超时截断（评审 F6） | env FIRST_BYTE=200ms，SSE 响应头即回、chunk 拖 600ms 发完 → 客户端全量收到、settled |
| 22 | 流式 hard timeout 生效（评审 F7） | env HARD=300ms，上游无限流 → 客户端流被终止、`failed_unbilled`（usage 未到）或 settled（usage 已到），信号量归零 |
| 23 | 慢请求体占满并发后自愈（评审 R3-F3） | MAX_INFLIGHT=1 + STREAM_IDLE=100ms，涓流 body 停发占住槽 → 超时 408、槽释放、第二请求放行 |
| 24 | 非流式大响应流式透传（评审 R3-F4） | 上游回 > parseBufferMax 的 JSON → 客户端完整收到（不 OOM）、extractor overflowed → `pending_backfill` |
| 25 | finalize DB busy 不杀进程（评审 R3-F5/R4-F1） | 注入结算首次 busy → 重试 settled；四连失败 → 进程存活、sweeper（缩短超时 env）最终收敛该行；流中断 + 双 busy → 三次内 failed_unbilled、零扣费 |
| 26 | 重复 model 键端到端拒绝（评审 R6-F1） | `{"model":"cheap",...,"model":"expensive"}` 与 `model` 变体 → 400、零转发、零账本行 |
| 27 | 非 2xx 慢 body 不泄漏资源（评审 R6-F3） | 上游 500 头后零 chunk/涓流 body，MAX_INFLIGHT=1 + idle 短超时 → body 被终止、槽最终释放、第二请求放行、账本 failed_unbilled |
| 28 | 备用凭证覆盖被剥离（评审 R7-F1） | 请求带 `Sec-WebSocket-Protocol: openai-insecure-api-key.<leaked>` → mock 上游收到的仅 `Bearer <运行Key>`、无 ws 头、无 leaked token |
| 29 | 准入后异常收束（评审 R7-F6） | 准入后注入 forward 抛非预期错 → 500、`failed_unbilled`、风险槽释放、信号量归零 |
| 30 | 巨串 body 准入前不 OOM（评审 R8-F1/R9-F1） | `--max-old-space-size=256` 下并发 N 个请求，两类载荷各测：(a) 单个 25MB `input` 串、(b) 25MB 塞满重复 `"model":"x"` → model 提取零分配/遇第二 model 即短路、进程存活、无 OOM |
| 31 | 聚合入站内存有界（评审 R13-F1 + R14-F1） | 三组固定压测，各带**同步屏障**（全部请求同时驻留读体阶段）+ 明确数值阈值：(a) 16×25MB **带 CL** → rss/heapUsed/external 基线增量 < 明确上限（如 external Δ < 600MB）；(b) 16×25MB **无 CL/chunked** → 同款阈值（验证单块统一路径不双份）；(c) 无 CL 正常小请求 → 成功、subarray 截断正确；(d) 无 CL 超 maxBytes → over_limit 且 reader 已 cancel |

- [ ] **Step 1: 写 mock-newapi.ts + 播种 helper**（先写基建）
- [ ] **Step 2: 按矩阵逐场景写 test（每写 3–5 个跑一次，红→绿迭代；发现实现缺陷回改对应任务的实现文件）**
- [ ] **Step 3: 全量 `pnpm test` 绿**
- [ ] **Step 4: Commit** `test(gateway): 网关端到端集成矩阵（31 场景）`

---

### Task 19: `jobs.ts` 串行循环宿主 + `instrumentation.ts` + DB 锁

**Files:**
- Create: `src/features/gateway/server/jobs.ts`、`src/instrumentation.ts`
- Test: `tests/gateway/jobs.test.ts`

**Interfaces:**
- Consumes: Task 1 `gatewayJobLock`（迁移已播种 singleton 行）、Task 3 `gatewayConfig().jobsEnabled`。
- Produces: PLAN.md 契约 `startGatewayJobs/acquireJobLock/heartbeatJobLock` + 注入给各 worker 的 `keepAlive` 回调。worker 主体（Task 14/20/21 的 `run*Once`）经动态 import 调用，任一异常捕获打日志、不中断循环。
- 参数：tick 5s；reconcile 同步 5min；钱包不变量 60min；**锁 stale 5min**（评审 F8：30s 会在单轮远端调用期间被误判过期）。Next 16 instrumentation 已 GA（无需改 next.config.mjs，全新文件即可生效）。
- 心跳纪律（评审 F8）：每个 worker 启动前心跳一次；`keepAlive` 回调注入给 worker，worker 每处理一条调用（回调内部 10s 节流真心跳）；任何心跳返回 false = 丢锁 → worker 立即中止本轮、jobs 置 `hasLock=false`。**不做 fencing token / 逐项 claim**——设计 §10.1/§32 减配裁决：锁目标是尽力单活，残余竞态窗口由业务唯一索引幂等兜底（`newapi_request_id`/`order_no`/`uniq_runtime_credential_scope`）。

- [ ] **Step 1: 写失败测试**

```ts
// tests/gateway/jobs.test.ts —— 关键用例：
test('抢锁：两 holder 竞争恰一个成功；同 holder 重入成功', ...);
test('stale 夺锁：holder A 心跳过期（heartbeat_at 手动改老）→ B 抢到', ...);
test('heartbeatJobLock：holder 不符返回 false（丢锁信号）', ...);
test('执行期续租（评审 F8）：模拟 worker 处理 N 条、每条经 keepAlive → heartbeat_at 持续推进、另一 holder 在此期间抢不到锁', ...);
test('keepAlive 节流：10s 内多次调用只发一次真心跳（mock 时钟或计数 DB 写）', ...);
test('丢锁中止（评审 F8）：keepAlive 底层 heartbeat 返回 false → 回调返回 false、jobs 置 hasLock=false', ...);
```

- [ ] **Step 2: 跑测试确认失败**。
- [ ] **Step 3: 实现**

```ts
// src/features/gateway/server/jobs.ts
import 'server-only';
import { hostname } from 'node:os';
import { and, eq, isNull, lt, or, sql } from 'drizzle-orm';
import { db } from '@/core/db';
import { gatewayJobLock } from '@/config/db/schema';

const LOCK_ID = 'singleton';
// stale 5min（评审 F8）：单轮含远端调用（15s 超时 × 批量条目）可远超 30s，
// 过短的 stale 会让第二容器在第一容器执行远端副作用时夺锁。执行期由 keepAlive 持续续租。
const DEFAULT_STALE_MS = 5 * 60_000;
const KEEPALIVE_THROTTLE_MS = 10_000;
const TICK_MS = 5_000;
const RECONCILE_EVERY_MS = 5 * 60_000;
const INVARIANT_EVERY_MS = 60 * 60_000;

export async function acquireJobLock(holderId: string, staleMs = DEFAULT_STALE_MS): Promise<boolean> {
  const now = Date.now();
  const [row] = await db().update(gatewayJobLock)
    .set({ holderId, heartbeatAt: new Date(now), acquiredAt: new Date(now) })
    .where(and(eq(gatewayJobLock.id, LOCK_ID),
      or(isNull(gatewayJobLock.holderId), eq(gatewayJobLock.holderId, holderId),
        lt(gatewayJobLock.heartbeatAt, new Date(now - staleMs)))))
    .returning();
  return Boolean(row);
}

export async function heartbeatJobLock(holderId: string): Promise<boolean> {
  const [row] = await db().update(gatewayJobLock)
    .set({ heartbeatAt: new Date() })
    .where(and(eq(gatewayJobLock.id, LOCK_ID), eq(gatewayJobLock.holderId, holderId)))
    .returning();
  return Boolean(row);
}

let started = false;

export function startGatewayJobs(): void {
  if (started) return;
  started = true;
  const holderId = `${hostname()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  let hasLock = false;
  let lastReconcileAt = 0;
  let lastInvariantAt = 0;

  // 执行期续租回调（评审 F8）：worker 每处理一条调用；10s 节流；false = 丢锁，worker 须中止本轮
  let lastBeatAt = 0;
  const keepAlive = async (): Promise<boolean> => {
    if (Date.now() - lastBeatAt < KEEPALIVE_THROTTLE_MS) return hasLock;
    lastBeatAt = Date.now();
    hasLock = await heartbeatJobLock(holderId);
    return hasLock;
  };

  const tick = async () => {
    try {
      lastBeatAt = Date.now();
      hasLock = hasLock ? await heartbeatJobLock(holderId) : await acquireJobLock(holderId);
      if (hasLock) {
        const { runCredentialWorkerOnce } = await import('./credentials');
        const { runUsageWorkerOnce } = await import('./backfill');
        await runCredentialWorkerOnce({ keepAlive }).catch((e) => console.error('[jobs] credential_worker', e));
        if (hasLock) await runUsageWorkerOnce({ keepAlive }).catch((e) => console.error('[jobs] usage_worker', e));
        const now = Date.now();
        if (hasLock && now - lastReconcileAt >= RECONCILE_EVERY_MS) {
          lastReconcileAt = now;
          const { runReconcileSyncOnce } = await import('./reconcile');
          await runReconcileSyncOnce({ keepAlive }).catch((e) => console.error('[jobs] reconcile_worker', e));
        }
        if (hasLock && now - lastInvariantAt >= INVARIANT_EVERY_MS) {
          lastInvariantAt = now;
          const { runWalletInvariantCheckOnce } = await import('./reconcile');
          await runWalletInvariantCheckOnce().catch((e) => console.error('[jobs] wallet_invariant', e));
        }
      }
    } catch (error) {
      console.error('[jobs] tick failed', error);
      hasLock = false;
    } finally {
      setTimeout(tick, TICK_MS).unref?.();
    }
  };
  setTimeout(tick, TICK_MS).unref?.();
}
```

```ts
// src/instrumentation.ts —— Next 16 register 钩子（进程启动一次）
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs') return;
  if (process.env.GATEWAY_JOBS_ENABLED === 'false') return;
  const { startGatewayJobs } = await import('@/features/gateway/server/jobs');
  startGatewayJobs();
}
```

- [ ] **Step 4: 跑测试确认通过**；`pnpm build` 验证 instrumentation 编译通过。
- [ ] **Step 5: Commit** `feat(gateway): 进程内串行 worker 宿主与 DB 锁`

---

### Task 20: `backfill.ts` —— usage_worker（定点回填 + 超时扫描）

**Files:**
- Create: `src/features/gateway/server/backfill.ts`
- Modify: `src/features/newapi-bridge/server/portal.ts`（`bindingToUserCredentials` 加 `export`）
- Test: `tests/gateway/backfill.test.ts`

**Interfaces:**
- Consumes: Task 12 `getUsageLogByRequestId`、Task 5 `normalizeBackfillUsage`、Task 10 `settleByNewapiRequestId`、Task 9 `markFailedUnbilled`、`bindingToUserCredentials`。
- Produces: `runUsageWorkerOnce(deps?: { client?: any; keepAlive?: () => Promise<boolean> }): Promise<{ backfilled: number; swept: number; exhausted: number }>`；回填与 sweeper 循环内**每条先 `await keepAlive()`，false 立即返回**（评审 F8，缺省恒 true）。
- 退避表（设计 §10.2）：`[5s, 15s, 60s, 5min, 15min, 30min]`，6 次穷尽 → `next_backfill_at=null` 留 pending_backfill 进人工队列（占槽直到 `resolved_at` 人工闭环）+ console 告警。
- sweeper 规则：`open` 且 `created_at < now − (hardTimeoutMs + 10min)`——无 `newapi_request_id` → `failed_unbilled`（policy B：结局未知不扣用户）；**有** request id（崩溃丢 finalize）→ 转 `pending_backfill`（交回填裁决；设计 §10.2 未显式写此分支，为崩溃恢复的最小闭合，穷尽后仍进人工队列）。

- [ ] **Step 1: 写失败测试**（setupDb + mock client 注入；播种 pending_backfill/open 各形态行 + binding 凭据可解密）

```ts
// tests/gateway/backfill.test.ts —— 关键用例：
test('定点回填命中：日志 usage/quota 落对账字段 + settled(log_backfill) + 扣费', ...);
test('日志显式 quota=0 → failed_unbilled 不扣费', ...);
test('未命中：attempts++ 且 next_backfill_at 按退避表推进；第 6 次后 next=null + 仍占槽', ...);
test('重复回填幂等：已 settled 行再跑 worker 零变化', ...);
test('sweeper：无 id 超时 open → failed_unbilled；有 id 超时 open → pending_backfill', ...);
```

- [ ] **Step 2: 跑测试确认失败**。
- [ ] **Step 3: 实现**（骨架；完整按规格）

```ts
// src/features/gateway/server/backfill.ts
import 'server-only';
import { and, eq, inArray, isNull, isNotNull, lt, lte } from 'drizzle-orm';
import { db } from '@/core/db';
import { newApiUserBinding, requestLedger } from '@/config/db/schema';
import { normalizeBackfillUsage } from '@/features/gateway/lib/billing';
import { gatewayConfig } from '@/features/gateway/lib/config';
import { markFailedUnbilled, markPendingBackfill } from './admission';
import { settleByNewapiRequestId } from './settlement';

const BACKOFF_MS = [5_000, 15_000, 60_000, 300_000, 900_000, 1_800_000];
const BATCH = 20;

export async function runUsageWorkerOnce(deps: { client?: any; keepAlive?: () => Promise<boolean> } = {}) {
  const { createNewApiClient } = await import('@/features/newapi-bridge/server/client');
  const { bindingToUserCredentials } = await import('@/features/newapi-bridge/server/portal');
  const client = deps.client ?? createNewApiClient();
  const keepAlive = deps.keepAlive ?? (async () => true);
  let backfilled = 0, swept = 0, exhausted = 0;
  const now = Date.now();

  // ① 定点回填
  const dueRows = await db().select().from(requestLedger)
    .where(and(eq(requestLedger.status, 'pending_backfill'), isNotNull(requestLedger.nextBackfillAt),
      lte(requestLedger.nextBackfillAt, new Date(now))))
    .limit(BATCH);
  for (const row of dueRows) {
    if (!(await keepAlive())) return { backfilled, swept, exhausted }; // 丢锁即停（评审 F8）
    try {
      const [binding] = await db().select().from(newApiUserBinding)
        .where(eq(newApiUserBinding.portalUserId, row.userId)).limit(1);
      const creds = bindingToUserCredentials(binding);
      const log = await client.getUsageLogByRequestId(creds, row.newapiRequestId);
      if (!log) { await scheduleRetry(row); continue; }
      await db().update(requestLedger).set({
        newapiQuota: quotaFromLog(log), newapiPromptTokens: log.inputTokens,
        newapiCompletionTokens: log.outputTokens, newapiTokenName: log.keyMasked, updatedAt: new Date(),
      }).where(eq(requestLedger.id, row.id));
      if (quotaFromLog(log) === 0) {
        await markFailedUnbilled(row.id, { errorCode: 'backfill_zero_quota' }); // 日志显式失败
        continue;
      }
      const buckets = normalizeBackfillUsage(log);
      const result = await settleByNewapiRequestId(row.newapiRequestId!, { buckets, usageSource: 'log_backfill' });
      if (result === 'settled') backfilled++;
    } catch (error) {
      await scheduleRetry(row, String(error));
    }
  }

  // ② open 超时扫描（sweeper）
  const staleCutoff = new Date(now - gatewayConfig().hardTimeoutMs - 10 * 60_000);
  const staleRows = await db().select().from(requestLedger)
    .where(and(eq(requestLedger.status, 'open'), lt(requestLedger.createdAt, staleCutoff))).limit(BATCH);
  for (const row of staleRows) {
    if (!(await keepAlive())) break; // 丢锁即停（评审 F8）
    if (row.newapiRequestId) { if (await markPendingBackfill(row.id, {})) swept++; }
    else if (await markFailedUnbilled(row.id, { errorCode: 'open_timeout' })) swept++;
  }
  return { backfilled, swept, exhausted };
}

async function scheduleRetry(row: any, error?: string) {
  const attempts = (row.backfillAttempts ?? 0) + 1;
  const next = attempts <= BACKOFF_MS.length ? new Date(Date.now() + BACKOFF_MS[attempts - 1]) : null;
  if (!next) console.error('[backfill] exhausted, manual queue', { ledgerId: row.id });
  await db().update(requestLedger)
    .set({ backfillAttempts: attempts, nextBackfillAt: next, lastBackfillError: error, updatedAt: new Date() })
    .where(and(eq(requestLedger.id, row.id), eq(requestLedger.status, 'pending_backfill')));
}
// quotaFromLog：RemoteUsageLog.spendUsd 是 quota/500_000，反算 quota = spendUsd 缺失 ? null : round(spendUsd*500000)
//（或 Task 12 让 toRemoteUsageLog 直接透出原始 quota 字段，二选一，以后者为准落地）
```

- [ ] **Step 4: 跑测试确认通过**。
- [ ] **Step 5: Commit** `feat(gateway): usage_worker 定点回填与超时扫描`

---

### Task 21: `reconcile.ts` —— 批量同步 + 孤儿可见性 + 对账 + 钱包不变量

**Files:**
- Create: `src/features/gateway/server/reconcile.ts`
- Test: `tests/gateway/reconcile.test.ts`

**Interfaces:**
- Consumes: Task 12 `listAdminUsageLogsPage`（Spike S1 主路径；回退逐 binding `listUserUsageLogsPage`——评审 R3-F1）、Task 10 `settleByNewapiRequestId`、Task 5 `computeChargeMicroUsd`、Task 1 `gatewayJobLock.reconcileWatermarkAt` + `reconcileOrphanObservation` + `modelPriceVersion` 五维 ref 快照列（勘误 E7）。
- Produces: PLAN.md 契约 `runReconcileSyncOnce(deps?)/runWalletInvariantCheckOnce`（返回值 `truncated` 语义 = 本轮未追平积压、下轮从新水位续跑）；页间与逐日志处理均先 `await keepAlive()`，false 立即返回（评审 F8）。
- 金额换算注释：`newapi_quota × 2 = micro-USD`（quota/500_000 USD × 10^6）。

**行为规格（设计 §10.2/§10.4 + 评审 F10/R2-F3）：**
1. **时间片驱动水位**（R2-F3：一窗一拉 + truncated 不推水位 = 积压时每轮重扫同一窗口、永久失活）：
   - 读 `reconcileWatermarkAt`（null → now−24h）；待扫区间 `[watermark − 10min, now]` 切成 **≤10min 的时间片**，逐片处理；
   - 片内翻页到耗尽：`for page=1.. { await keepAlive() || 中止; listAdminUsageLogsPage({page, 片区间}) → 逐条处理; !full → break }`；
   - 片内页数超 `SLICE_PAGE_LIMIT = 50`（5000 条/10min，远超 v1 量级）→ **自动二分**（评审 R3-F2：停在片起点=下一轮必然重扫同一片、永远到不了第 51 页——重现 R2-F3 死锁；告警不是自愈）：console.error 告警 `reconcile_slice_overflow` 后，片长 >1s → 将该片对半拆成两片推回待处理队列头部、丢弃本片已取数据（逐条处理本就幂等）；片长 ≤1s → 不再拆分、翻页直到耗尽（1 秒内日志量物理有限，页间仍 keepAlive）——任何量级下每轮都有净进展、水位最终必然推进；
   - **每完整处理一片 → `reconcileWatermarkAt = max(当前水位, 片末端)`（立即持久化）**——水位**单调不减**（评审 R4-F4：待扫区间从 `watermark−10min` 起含 overlap 回看，overlap 子片的末端低于旧水位，直接赋值会把水位写回过去、中断后反复倒退）；低于旧水位的 overlap 子片只做幂等重扫、不动水位。可续跑：丢锁/崩溃/积压都只损失当前片，下轮从新水位继续，不重扫已完成片；
   - 单轮最多 `MAX_SLICES_PER_RUN = 12` 片（≈2h 追赶量）防单轮过长，剩余积压下轮继续（返回 `truncated=true`）。
2. 逐条日志（consume 类型、有 requestId）匹配 `request_ledger.newapi_request_id`：
   - 命中 `settled` → 补 `newapi_quota/prompt/completion/token_name`，然后分层核对：
     - 用量层 0 容差：`newapi_prompt_tokens == uncached+cachedRead+write5m+write1h` ∧ `newapi_completion_tokens == output` → 否则 `token_mismatch`（最高告警）；**模型一致性**（评审 R6-F1 兜底）：`log.modelId == ledger.newapi_model_id` → 否则同列 `token_mismatch` + note `model_mismatch`（计费模型与上游执行模型分叉的离线证据）；
     - 金额层内部：`charged == computeChargeMicroUsd(桶, price_version)` 0 容差；外部：`|quota×2 − Σ(桶×newapiRef)/1e6| ≤ max(10, 1% × quota×2)` → 超差 `amount_mismatch`。**ref 只读 `model_price_version` 五维快照列**（勘误 E7 / 评审 R3-F7：catalog 基准价是活表，读现值会对历史请求产生假 matched/假 mismatch）；防御规则：某 ref 列为 null 且对应桶非零 → 跳过外部核对（`reconcile_note='ref_missing:<维>'`，只做内部一致性，不产生假 mismatch）——v1 发布校验保证五维齐，此规则仅兜历史/异常数据；
     - 全过 → `matched` + `reconciledAt`；
   - 命中 `open`/`pending_backfill` → `normalizeBackfillUsage` → 结算（log_backfill）；
   - 命中 `failed_unbilled`（我们判失败但 New API 有消费）→ 补对账字段 + `reconcile_status='waived_by_failure'`（运营吃、可见）；
   - **未命中（孤儿）**（勘误 E6 / 评审 R2-F4：`request_ledger` 的 portal_key_id/route_version/price_version_id 等非空快照在孤儿场景原理上不可恢复，禁止插主账本/伪造归因）：`tokenName` 以 `rk_` 开头 → 反查 `runtime_credential.remoteName` 归因（可失败）→ **`INSERT INTO reconcile_orphan_observation … ON CONFLICT(newapi_request_id) DO NOTHING`**：`portalUserId/newapiGroup/newapiModelId/credentialId` 取反查结果（失败留 null）、`tokenName` 原样保留为归因证据、usage/quota/logCreatedAt 落观测字段（不扣用户、不进主账本）；`tokenName` 非 `rk_`（旧 pk_/人工 token）→ 仅 console 记"域外消费"，不入表。
3. `waived_by_failure` + 孤儿观测新增行合计超阈（单轮 > 10 条）→ console.error 告警 `waived_by_failure_high`。
4. `runWalletInvariantCheckOnce`：`SELECT user_id, balance FROM wallet_account` LEFT JOIN `SELECT user_id, SUM(signed) FROM wallet_ledger GROUP BY user_id` → 不等者收集告警（**不自动修**，需求 7.9.4），返回 `{ broken: userId[] }` + console.error `wallet_invariant_broken`。

> **注（评审 R17-F2 回退）**：R16 曾在此加"PAID 缺 recharge 订单幂等补入"检查，因它绕过冻结在未验证镜像写真钱、且误命中钱包激活前 PAID 订单（本有 credit/远端加额）造成双重权益，已回退删除。wallet recharge 由 `handleCheckoutSuccess` 事务内直接入账、不经 reconcile 补入；结算不受 checkout 门控后无"冻结延后"需要补的场景。

- [ ] **Step 1: 写失败测试**（setupDb + mock client；播种 settled/open/failed_unbilled 行 + rk_ credential + 日志集合覆盖全分支）

```ts
// tests/gateway/reconcile.test.ts —— 关键用例：
test('settled 命中：对账字段回填、matched', ...);
test('用量层不一致 → token_mismatch', ...);
test('金额层外部超差 → amount_mismatch；容差内（±10 micro）→ matched', ...);
test('open 命中 → 结算 log_backfill', ...);
test('failed_unbilled 命中 → waived_by_failure（不产生扣费）', ...);
test('孤儿 rk_ → reconcile_orphan_observation 插行、归因正确、零扣费、request_ledger 零新增（评审 R2-F4）', ...);
test('孤儿幂等：同 newapi_request_id 二轮 → 观测表仍一行（ON CONFLICT DO NOTHING）', ...);
test('孤儿反查失败：runtime_credential 无匹配 remoteName → portalUserId=null、tokenName 原样保留', ...);
test('孤儿非 rk_ → 不入任何表（域外消费）', ...);
test('时间片推进（评审 R2-F3）：3 片数据一轮处理完 → 水位=区间末端、二轮零重复处理', ...);
test('积压续跑（评审 R2-F3）：>MAX_SLICES_PER_RUN 片积压 → 首轮 truncated=true、水位=已完成片末端；次轮从新水位继续、最终追平（每轮都有净进展，无死锁）', ...);
test('片溢出自动二分（评审 R3-F2）：单片 >SLICE_PAGE_LIMIT 页 → 二分推回队列、告警、最终全量处理完毕且水位推进（净进展，非人工介入）', ...);
test('1s 片兜底（评审 R3-F2）：构造同秒 >SLICE_PAGE_LIMIT 页日志 → 不再拆分、翻页到耗尽、水位推进', ...);
test('水位单调不减（评审 R4-F4）：overlap 首子片完成后 keepAlive=false 中断 → 水位 ≥ 旧值（不倒退）；重复中断多轮 → 起扫点不早于 旧水位−10min', ...);
test('页间丢锁（评审 F8）：keepAlive=false → 本片中止、水位停在上一完成片末端、重跑从此续、终态一致', ...);
test('ref 缺维防御（评审 R3-F7）：price_version 的 cache ref 为 null 且 cache 桶非零 → 跳过外部核对、note=ref_missing、不产生 amount_mismatch', ...);
test('模型一致性核对（评审 R6-F1）：日志 model_name ≠ ledger.newapi_model_id → token_mismatch + note=model_mismatch', ...);
test('未知维度可见性（评审 R6-F5 降级裁决）：settled 行含 unmapped 维度成本 → 外部金额核对必产生 amount_mismatch（差额不静默）', ...);
test('fallback 跨片追平（评审 R3-F1）：admin 接口全程失败 → 逐用户 listUserUsageLogsPage 按片区间取数，多个历史片全部命中处理、水位推进（集成：mock 仅 /api/log/self 可用）', ...);
test('钱包不变量：手工破坏 balance → broken 含该 user、不自动修', ...);
```

- [ ] **Step 2: 跑测试确认失败**。
- [ ] **Step 3: 实现 `reconcile.ts`**（按行为规格 1–4；admin 日志拉取失败时 console.warn 后回退逐 binding **`listUserUsageLogsPage(creds, { page, 片区间 })`** 循环聚合——Spike S1 的运行时兜底。**禁止调既有 `listUsageLogs`**：其公开签名 `(user, limit)` 不透传 range、第三参被静默忽略，每片都会读"最新首页"、水位却照常推进 = 静默漏账（评审 R3-F1，已实读 `client.ts:1404-1409` 验证）。fallback 片内翻页/溢出二分/keepAlive 与主路径同款规则）。
- [ ] **Step 4: 跑测试确认通过**。
- [ ] **Step 5: Commit** `feat(gateway): reconcile_worker 批量对账与孤儿可见性`
