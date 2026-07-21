# 模型价格配置与调用计费 实施计划

> **执行说明：** 按任务顺序逐项执行，步骤用 checkbox（`- [ ]`）跟踪勾选；每任务测试先行、独立验收、至少一次 commit。执行者（人、主会话或子代理均可）在动手前先读该任务 Files 的现场代码。

- 日期：2026-07-20
- 依据：[../../design/portal-model-pricing/DESIGN.md](../../design/portal-model-pricing/DESIGN.md)（终审 GO，O1–O13 全部并入）
- 状态：已过第 1 轮对抗评审（codex needs-attention，5 findings 全成立并采纳，含 3 项追问澄清与 1 项设计裁决翻转 E3；过程见 [../../design/portal-model-pricing/review-log.md](../../design/portal-model-pricing/review-log.md)）——可开工版本

## 设计基线调整记录（PLAN 阶段勘误，DESIGN 正文已冻结不回改）

| # | 对应设计条目 | 调整 | 来源 |
|---|---|---|---|
| E1 | §6.2"开关编译进版本、运行期零开关分支" | 该方案使关闭态漏拦请求在响应侧不可检测（版本无阈值 → 无法判断实际用量越阈、无法打标校准估算），与 §5.4"漏拦按普通档结算 + 标记 + 校准系数"自相矛盾。调整：**计费**仍零分支（版本内容不变）；**检测**走请求上下文——准入时快照目录现值 `admissionLongContextThreshold` + `allowLongContext`（不参与计费），关闭态响应后按实际 inputTotalTokens 检测漏拦并写 `billing_flags: long_context_block_missed` | 第 6 轮 F4 |
| E2 | §7.6.2"multipart 文件部分流式透传，不整体读入内存" | 内测阶段按暴露度减配：请求侧维持现状整体缓冲 + 请求体上限（`maxBodyBytes` 25MiB）即可，内存压力可控，`forward` 的 `Uint8Array` 接口不动；流式透传记 issues 延后至流量上规模。响应侧不受影响（本就是流） | 第 6 轮 F1（减配裁量） |
| E3 | §7.5"usage 缺失路径：pending → newapi 日志补差 + 粒度降级标记" | **翻转（第 6 轮用户裁决）**：token 制 usage 缺失改为**直接 `waived`（该笔零计费）+ `billing_flags` 标记 + 告警**，不再进 pending 等待日志补差——与 O1（newapi 只读参照）/N1（不引 newapi 日志作证据）/O10（宁少收不收错）自洽，门户用量事实链闭环于自身响应解析。`usage_log_snapshot` 拉取保留但只喂 reconcile 对照（发现异常与系统性丢 usage 告警）；backfill 的**结算职责退役**（`normalizeBackfillUsage` 与重试调度的结算路径删除）。per_call 不受影响（本就按张数结算） | 第 6 轮追问裁决 |

**Goal:** 把门户模型定价从五桶宽表改造为 meter map 计费体系：唯一公式 官方基准价 × 折扣、长上下文阶梯、gpt-image-2 按次售卖、web_search 工具计费、完备集发布硬门、callable 与 newapi 同步解耦。

**Architecture:** 目录层列式微增（+9 列 +1 tier 表 + listing 开关），网关 `model_price_version` 破坏性重建为 `rates_json`/`tiers_json` map，账本增列不删列；计费流水线 = usage 归一化为 meter 向量（含长档判定）→ Σ qty×rate + 工具附加 / SKU×n → 单舍入点结算。

**Tech Stack:** Next.js + Drizzle ORM（SQLite）、node:test + assert/strict（测试名用中文）、BigInt 整数金额运算。

## Global Constraints（每个任务隐含遵守）

- 金额全程整数 micro-USD；BigInt 求和、`ceilDiv` 唯一舍入点、最低扣费 1 micro-USD（DESIGN §7.3）。
- O13：价格表按官方计费说明满配；usage 缺字段 qty=0 套标准公式，无渠道分支；usage 多出未知字段（含对象/数组结构）→ 零计 + `billing_flags` 标记 + 告警，绝不按替代价收费。
- O2/O8：卖价 = 手填基准价 × `listing.discountRateBps`（默认 10000）；`catalogGroup.newapiGroupRatioBps` 不得出现在卖价链。
- O3：账本用量全列式；JSON 列仅 `billing_flags_json`（异常标记）与 `raw_usage_json`（凭证）。
- 破坏性迁移允许（存量 Stripe 沙盒）；但清空必须是人工确认的独立操作，不做脚本自动 fallback（§11 迁移约束）。
- 测试缝锚点：`tests/gateway/*`、`tests/api-catalog/*`、`tests/db/*`；提交信息中文、每任务至少一次 commit。
- 任务 T7–T12 的代码块为**骨架级**（写明接口契约与验收命令）；执行者必须先 Read 现场文件再展开，禁止照抄骨架跳过现场核对。

**依赖关系：** T1→T2→T3 严格串行；T4/T5 可与 T2/T3 并行；T6 依赖 T4+T5；T7 依赖 T3+T4+T6；T8 依赖 T6+T7；T9 依赖 T7+T8；T10/T11 依赖 T5+T6；T12 收尾。

---

### Task 1: meter 词表与类型模块

**Files:**
- Create: `src/features/gateway/lib/meters.ts`
- Test: `tests/gateway/meters.test.ts`

**Interfaces:**
- Produces: `MeterKey`（union 类型）、`TOKEN_METER_KEYS`、`LONG_METER_MAP: Record<string, MeterKey>`、`toLongMeterKey(key: MeterKey): MeterKey`、`MeterQuantities = Partial<Record<MeterKey, number>>`、`BillingScheme = 'token' | 'per_call'`

- [x] **Step 1: 写失败测试**

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  LONG_METER_MAP,
  TOKEN_METER_KEYS,
  toLongMeterKey,
} from '@/features/gateway/lib/meters';

test('词表：token meter 键集合与设计 §5.1 一致', () => {
  assert.deepEqual(
    [...TOKEN_METER_KEYS].sort(),
    [
      'cache_write',
      'cache_write_5m',
      'cache_write_1h',
      'cached_image_input',
      'cached_input',
      'image_input',
      'image_output',
      'input',
      'output',
    ].sort()
  );
});

test('词表：长档映射只覆盖文本四通道且键名带 _long 后缀', () => {
  assert.deepEqual(LONG_METER_MAP, {
    input: 'input_long',
    cached_input: 'cached_input_long',
    cache_write: 'cache_write_long',
    output: 'output_long',
  });
  assert.equal(toLongMeterKey('input'), 'input_long');
  assert.equal(toLongMeterKey('image_input'), 'image_input'); // 无长档变体的键原样返回
});
```

- [x] **Step 2: 运行确认失败**：`npm test -- tests/gateway/meters.test.ts`，预期 "Cannot find module .../meters"。
- [x] **Step 3: 最小实现**

```ts
// src/features/gateway/lib/meters.ts
// 计费词表唯一事实源（DESIGN §5.1）：账本/价格/归一化共用。
export const TOKEN_METER_KEYS = [
  'input',
  'cached_input',
  'cache_write',
  'cache_write_5m',
  'cache_write_1h',
  'output',
  'image_input',
  'cached_image_input',
  'image_output',
] as const;

export const LONG_TOKEN_METER_KEYS = [
  'input_long',
  'cached_input_long',
  'cache_write_long',
  'output_long',
] as const;

export type MeterKey =
  | (typeof TOKEN_METER_KEYS)[number]
  | (typeof LONG_TOKEN_METER_KEYS)[number]
  | 'web_search';

export const LONG_METER_MAP: Partial<Record<MeterKey, MeterKey>> = {
  input: 'input_long',
  cached_input: 'cached_input_long',
  cache_write: 'cache_write_long',
  output: 'output_long',
};

export function toLongMeterKey(key: MeterKey): MeterKey {
  return LONG_METER_MAP[key] ?? key;
}

export type MeterQuantities = Partial<Record<MeterKey, number>>;
export type BillingScheme = 'token' | 'per_call';
```

- [x] **Step 4: 测试通过**：`npm test -- tests/gateway/meters.test.ts` 全绿。
- [x] **Step 5: Commit**：`git add src/features/gateway/lib/meters.ts tests/gateway/meters.test.ts && git commit -m "feat: 新增计费 meter 词表模块"`

---

### Task 2: normalizeUsage 向量化（含等式校验、结构检测、长档判定）

**Files:**
- Modify: `src/features/gateway/lib/billing.ts`（现有 `normalizeUsage` L58–147 改造为 meter 向量输出）
- Test: `tests/gateway/billing.test.ts`（现有五桶断言改写为向量断言）

**Interfaces:**
- Consumes: T1 的 `MeterKey`/`MeterQuantities`/`toLongMeterKey`
- Produces:
```ts
export type NormalizedUsage = {
  meters: MeterQuantities;          // 仅非零项
  webSearchCount: number;           // usage.server_tool_use.web_search_requests（O12）
  flags: string[];                  // 'unmapped:<key>' | 'cache_write_sum_mismatch' | 'unmapped_struct:<key>'
};
export function normalizeUsageMeters(
  endpoint: GatewayEndpointKey,
  usage: Record<string, unknown>,
  opts?: { longContextThresholdTokens?: number | null }
): NormalizedUsage;
```

要点（每个要点 = 一轮"测试先行 → 实现 → 绿"循环，全部在本任务内完成后一次 commit）：

- [x] **Step 1: 向量映射测试**（把现有五桶用例翻译成 meter 键；沿用现有取数规则，含 chat/responses/messages/embeddings）

```ts
test('Chat：prompt_tokens 子集语义拆桶并输出 meter 向量', () => {
  const r = normalizeUsageMeters('chat_completions', {
    prompt_tokens: 1000,
    completion_tokens: 50,
    prompt_tokens_details: { cached_tokens: 600, cache_creation_tokens: 100 },
  });
  assert.deepEqual(r.meters, {
    input: 300,
    cached_input: 600,
    cache_write: 100,
    output: 50,
  });
  assert.deepEqual(r.flags, []);
});
```

注意：OpenAI 侧缓存写映射到 `cache_write`（无 TTL 键，DESIGN §5.1 规则 3），**不再**如现状放入 `cacheWrite5m`；Anthropic 细分映射到 `cache_write_5m`/`cache_write_1h`。

- [x] **Step 2: R9 等式校验测试**

```ts
test('Messages：聚合与细分不一致时按细分结算并打标记', () => {
  const r = normalizeUsageMeters('messages', {
    input_tokens: 100,
    output_tokens: 10,
    cache_creation_input_tokens: 10000, // 聚合
    cache_creation: { ephemeral_5m_input_tokens: 3000 }, // 细分缺 1h
  });
  assert.equal(r.meters.cache_write_5m, 3000);
  assert.ok(r.flags.includes('cache_write_sum_mismatch'));
});
```

- [x] **Step 3: R10 结构化未知项测试**

```ts
test('Messages：iterations 数组与 server_tool_use 不再静默逃逸', () => {
  const r = normalizeUsageMeters('messages', {
    input_tokens: 100,
    output_tokens: 10,
    iterations: [{ input_tokens: 50 }],
    server_tool_use: { web_search_requests: 3 },
  });
  assert.equal(r.webSearchCount, 3);
  assert.ok(r.flags.includes('unmapped_struct:iterations'));
});
```

实现要点：未知检测从"仅顶层数值"扩展为——顶层数值（现状逻辑保留）+ 未知**对象/数组**键 → `unmapped_struct:<key>`；`server_tool_use` 特判读取 `web_search_requests` 计次（不入 flags）。

- [x] **Step 4: O9 长档判定测试**

```ts
test('长档：inputTotalTokens（含缓存）达阈值时全部键改写为 _long', () => {
  const r = normalizeUsageMeters(
    'responses',
    {
      input_tokens: 280_000,
      output_tokens: 10,
      input_tokens_details: { cached_tokens: 100_000, cache_write_tokens: 0 },
    },
    { longContextThresholdTokens: 272_000 }
  );
  assert.deepEqual(r.meters, {
    input_long: 180_000,
    cached_input_long: 100_000,
    output_long: 10,
  });
});

test('长档：无阈值参数时永不判长档', () => {
  const r = normalizeUsageMeters('responses', { input_tokens: 500_000, output_tokens: 1 });
  assert.equal(r.meters.input, 500_000);
});
```

判档口径：`inputTotalTokens = input + cached_input + cache_write + cache_write_5m + cache_write_1h`（改写前求和），≥ 阈值则对每个非零键做 `toLongMeterKey` 改写。

- [x] **Step 5: 全量跑 `npm test -- tests/gateway/billing.test.ts`，旧五桶断言全部改写完毕、全绿。**
- [x] **Step 6: Commit**：`git commit -m "feat: usage 归一化输出 meter 向量（等式校验/结构检测/长档判定）"`

---

### Task 3: 计费公式 map 化 + per_call + 工具附加费

**Files:**
- Modify: `src/features/gateway/lib/billing.ts`（`computeChargeMicroUsd` L181–193 重写；`PriceVector` 类型退役）
- Test: `tests/gateway/billing.test.ts`

**Interfaces:**
- Consumes: T1/T2 的 `MeterQuantities`
- Produces:
```ts
export type RatesMap = Partial<Record<MeterKey, number>>; // micro-USD / 1M tokens（web_search 为 micro-USD/次）
export function computeTokenChargeMicroUsd(
  meters: MeterQuantities,
  rates: RatesMap,
  tool: { webSearchCount: number; webSearchPriceMicroUsd: number | null }
): { charged: bigint; unpricedMeters: MeterKey[] };  // unpricedMeters = 非零但 rates 无键（O13 零计 + 上层打标）
export function computePerCallChargeMicroUsd(unitCount: number, tierPriceMicroUsd: number): bigint;
```

- [x] **Step 1: 失败测试**

```ts
test('token 计费：按 rates map 求和、未定价键零计并回报', () => {
  const { charged, unpricedMeters } = computeTokenChargeMicroUsd(
    { input: 1000, output: 50, image_output: 999 }, // image_output 未配价
    { input: 2_500_000, output: 10_000_000 },
    { webSearchCount: 0, webSearchPriceMicroUsd: null }
  );
  // (1000×2.5e6 + 50×1e7) / 1e6 = 3000 micro-USD
  assert.equal(charged, 3000n);
  assert.deepEqual(unpricedMeters, ['image_output']);
});

test('token 计费：web_search 附加费与 token 费同分母一次取整', () => {
  const { charged } = computeTokenChargeMicroUsd(
    { input: 1 },
    { input: 2_500_000 },
    { webSearchCount: 3, webSearchPriceMicroUsd: 10_000 }
  );
  // ceil((1×2.5e6 + 3×1e4×1e6) / 1e6) = ceil(2.5 + 30000) = 30003
  assert.equal(charged, 30_003n);
});

test('per_call：单价×实际张数，最低 1 micro-USD', () => {
  assert.equal(computePerCallChargeMicroUsd(2, 300_000), 600_000n);
  assert.equal(computePerCallChargeMicroUsd(0, 300_000), 1n);
});
```

- [x] **Step 2: 实现**（骨架，保持 `ceilDiv` 唯一舍入点与 min 1）

```ts
export function computeTokenChargeMicroUsd(
  meters: MeterQuantities,
  rates: RatesMap,
  tool: { webSearchCount: number; webSearchPriceMicroUsd: number | null }
): { charged: bigint; unpricedMeters: MeterKey[] } {
  let total = 0n;
  const unpricedMeters: MeterKey[] = [];
  for (const [key, qty] of Object.entries(meters) as [MeterKey, number][]) {
    if (!qty) continue;
    const rate = rates[key];
    if (rate === undefined || rate === null) {
      unpricedMeters.push(key); // O13：零计，由调用方写 billing_flags
      continue;
    }
    total += BigInt(qty) * BigInt(rate);
  }
  if (tool.webSearchCount > 0 && tool.webSearchPriceMicroUsd != null) {
    total += BigInt(tool.webSearchCount) * BigInt(tool.webSearchPriceMicroUsd) * MICRO_PER_M;
  }
  const charged = ceilDiv(total, MICRO_PER_M);
  return { charged: charged > 0n ? charged : 1n, unpricedMeters };
}
```

注意：工具未配价（null）而 `webSearchCount > 0` 的场景由 T8 准入拦截兜前门；此处不加价也不报错，`unpricedMeters` 不含 web_search（它不是 token meter）——由调用方按 `webSearchCount > 0 && price == null` 单独打 flag（旁路防御，DESIGN §7.1）。

- [x] **Step 3: 新旧并存（第 6 轮 F3）**：`PriceVector` 与旧 `computeChargeMicroUsd` **本任务不删除**——现场 `catalog-route-snapshot.ts`、`routing.ts`、结算与 `reconcile.ts` 仍依赖它们，且要到 T6/T7/T12 才逐个切换。给旧导出加 `@deprecated 由 T12 收尾统一删除` 注释；`normalizeBackfillUsage` 不新增变体（其结算职责将由 E3 在 T7 退役）。统一删除在 T12 收尾步骤执行。
- [x] **Step 4: Commit**：`git commit -m "feat: 计费公式 map 化并支持 per_call 与工具附加费"`

---

### Task 4: 网关层 schema 重建与账本增列

**Files:**
- Modify: `src/config/db/schema.sqlite.ts`（`modelPriceVersion` L1225–1277、`requestLedger` L1366–1431；postgres/mysql 两份同步）
- Create: `src/config/db/migrations/<下一编号>_pricing_v2.sql`（编号用 `ls src/config/db/migrations | tail -1` 确认）
- Test: `tests/db/schema-guard.test.ts`（按现有 schema-guard 模式更新期望列集）

**Interfaces（Produces，T6/T7 依赖）：**
- `modelPriceVersion` 新列：`billingScheme text NOT NULL default 'token'`、`ratesJson text NOT NULL default '{}'`、`tiersJson text NOT NULL default '{}'`、`longContextThresholdTokens integer`；**删除** `inputMicroUsdPerM` 等五个单价列；`newapiRef*` 五列与版本链、`uniq_model_price_version_active` 索引保留。
- `requestLedger` 增列（全部可空）：`billingScheme`、`cacheWriteTokens`、`imageInputTokens`、`cachedImageInputTokens`、`imageOutputTokens`、`skuKey`、`unitCount`、`longContextApplied`（integer 0/1）、`billingFlagsJson`、`rawUsageJson`、`webSearchCount`；现有 `uncachedInputTokens/cachedReadTokens/cacheWrite5mTokens/cacheWrite1hTokens/outputTokens/reasoningTokens` 保留语义不变。

- [x] **Step 1: 更新 schema-guard 期望**（先改测试，跑出列差异失败清单）。
- [x] **Step 2: 改 schema.sqlite.ts + 迁移 SQL**。`model_price_version` 用 SQLite 十二步重建法（建新表→迁移旧行：五列值折算为 `rates_json`（键名 input/cached_input/cache_write_5m/cache_write_1h/output）→改名替换）；**迁移脚本不含清空分支**——若旧行存在则等价迁移，清空是独立的人工脚本（Global Constraints）。
- [x] **Step 3: `npm test -- tests/db/` 全绿；`npm run build` 通过。**
- [x] **Step 4: Commit**：`git commit -m "feat: 网关价格版本 map 化重建与账本增列"`

---

### Task 5: 目录层 schema 与按次价表

**Files:**
- Modify: `src/config/db/schema.sqlite.ts`（`catalogModelPrice` L544–592、`catalogModelListing` L634+；三方言同步）
- Create: 迁移 SQL（同 T4 编号规则，可与 T4 合并为一个迁移文件）
- Test: `tests/api-catalog/catalog-pricing-migration.test.ts`（现有文件扩展）

**Interfaces（Produces）：**
- `catalogModelPrice` 增列：`billingScheme text NOT NULL default 'token'`、`baseCacheWriteMicroUsd`、`baseCachedImageInputMicroUsd`、`baseWebSearchMicroUsd`、`longContextThresholdTokens`、`baseInputLongMicroUsd`、`baseCachedInputLongMicroUsd`、`baseCacheWriteLongMicroUsd`、`baseOutputLongMicroUsd`、`billingCapabilitiesJson text`（能力声明 = 官方计费说明，如 `{"cache_write":true,"cache_ttl_split":false,"long_context":true,"web_search":false}`，O13 完备集门禁判定源）。
- 新表 `catalogModelPriceTier`：`id`/`modelId`（FK cascade）/`skuKey`/`priceMicroUsd`（CHECK > 0）/`note`，`UNIQUE(modelId, skuKey)`。
- `catalogModelListing`：**删除** `pricePolicy`、`overrideInputMicroUsd`、`overrideOutputMicroUsd`、`overrideImageInputMicroUsd`、`overrideImageOutputMicroUsd`、`overrideReason`、`overrideStatus`（O2；seed 同步更新）；新增 `allowLongContext integer NOT NULL default 0`；`discountRateBps` 保留。
- 数据迁移（第 6 轮 F5 修订）：`fixedPriceMicroUsd` 非空的行 → `catalogModelPriceTier(modelId, 'default', fixedPriceMicroUsd)` **并同步 `SET billing_scheme='per_call'`**（判定条件：`pricing_mode='fixed_price'` 或 `fixedPriceMicroUsd` 非空）；`fixed_price_unit` 存在无法映射为"每次"的值时**迁移中止、人工处理**（与"清空须人工批准"同精神，不做静默猜测）。原两列标记废弃（暂保留列、停止读写）。
- 端到端迁移测试：造一行旧 fixed_price 数据 → 跑迁移 → 断言 `billing_scheme='per_call'` + default tier 存在 + 发布门禁通过 + 按次计费结果正确。

- [x] Step 1–4 同 T4 节奏（测试先行 → schema+迁移 → 绿 → commit `git commit -m "feat: 目录价格增列与按次价表"`）。

---

### Task 6: 快照桥完备集门禁 + callable 解耦

**Files:**
- Create: `src/features/api-catalog/server/publish-readiness.ts`（第 6 轮 F2：**唯一**发布就绪判定实现）
- Modify: `src/features/gateway/server/catalog-route-snapshot.ts`（全文改造，消费 publish-readiness）
- Modify: `src/features/api-catalog/server/queries.ts`（`isCatalogRouteReady` L230–245 退役，`isListingCallable` 与公开目录 DTO 的 callable 字段改由 publish-readiness 承担）
- Test: `tests/api-catalog/publish-readiness.test.ts`（新建，门禁矩阵）+ `tests/gateway/catalog-route-snapshot.test.ts`（重写）

**Interfaces:**
- Consumes: T4/T5 的新列
- Produces（三处共用的单一判定，杜绝"目录显示可调用、请求时 404"的分裂）：
```ts
export type PublishReadiness =
  | { ready: true; snapshot: {
      newapiGroup: string; newapiModelId: string;
      billingScheme: BillingScheme; ratesJson: string; tiersJson: string;
      longContextThresholdTokens: number | null;      // 计费用：开关关 = null（E1 计费零分支不变）
      admissionLongContextThreshold: number | null;   // 检测用：目录阈值现值，与开关无关（E1）
      allowLongContext: boolean;                      // 检测用（E1）
    } }
  | { ready: false; reasons: string[] };              // reasons 供 UI 门禁错误透出（T11）
export async function assessPublishReadiness(
  portalGroupId: string, portalModelId: string
): Promise<PublishReadiness>;
```
- `ensureCatalogRouteSnapshot` 签名不变（T7 依赖），内部 `loadCatalogRouteConfig` 改为调用 `assessPublishReadiness`。

核心改造点（每点先写门禁矩阵测试）：

- [x] **Step 1: `assessPublishReadiness` 实现**——一次查询 join listing/group/model/price/**tier 表**/能力声明，判定集：`isCallable`（售卖状态）+ `newapiGroup` 非空 + `basePriceSyncStatus === 'manual' && reviewedAt 非空` + 完备集门禁（Step 2）。**不含** `pricePolicy`、`priceDriftStatus`、`groupPricingSyncStatus`、`groupRatioBps` 四项（DESIGN §9 删三硬门；pricePolicy 随 T5 删列消失）。
- [x] **Step 2: 完备集门禁**：按 `billingCapabilitiesJson` 声明逐项校验对应价格列非空（声明 `cache_write:true` 则 `baseCacheWriteMicroUsd` 必填；`long_context:true` 则阈值 + 长档四价必填；`web_search:true` 则 `baseWebSearchMicroUsd` 必填；非法/不可解析的能力声明 = not ready）；基础必需集：token 类 `input`（+按 endpoint 的 `output`/`image_*`）、per_call 类 **tier 表存在 `default` 行**（这正是旧行谓词覆盖不了的判定）。缺失项全部写入 `reasons`。
- [x] **Step 3: 三处消费者切换**——`isListingCallable` 改为 `(await assessPublishReadiness(...)).ready`；公开目录 DTO 的 callable 字段同源（列表页逐行调用，内测流量下可接受，性能优化记 issues）；`isCatalogRouteReady` 行谓词删除。**API Catalog 与 Gateway 跑同一门禁矩阵测试**：缺 default tier / 缺官方 meter / 非法能力声明三案例在两侧断言一致结论。
- [x] **Step 4: 折算与编译**：`scaledPrice(base, listing.discountRateBps ?? 10000)`（**弃用 groupRatioBps**，O2）逐列折算 → `rates_json`（长档键仅当 `allowLongContext=1` 时写入并置 `longContextThresholdTokens`；关 = 不写，计费零分支）；`admissionLongContextThreshold`/`allowLongContext` 始终按目录现值输出（E1 检测通道）；per_call 折算 tier 表 → `tiers_json`；`priceMatches` 改为比对 `billingScheme + ratesJson + tiersJson + longContextThresholdTokens` 字符串相等。
- [x] **Step 5: 门禁矩阵测试全绿**（覆盖：满配可发布 / 声明有而未配拒绝 / 长档开关两态的 rates_json 与检测字段差异 / per_call 无 default 拒绝 / 折扣折算 round-half-up / 三处消费者同结论）。
- [x] **Step 6: Commit**：`git commit -m "feat: 统一发布就绪判定与快照桥完备集门禁"`

---

### Task 7: 结算路径写入新列（骨架级）

**Files:**
- Modify: `src/features/gateway/server/handler.ts`（finalize L438–480：`normalizeUsage` → `normalizeUsageMeters`，携带价格版本 threshold 与 E1 检测字段）
- Modify: `src/features/gateway/server/routing.ts`（第 6 轮 F3：旧 PriceVector 消费点切换，`grep -n "PriceVector" src/features/gateway/server/routing.ts` 定位）
- Modify: 结算模块（`deps.settle` 实现处，`grep -rn "function settle\|settle(" src/features/gateway/server` 定位）
- Modify: `src/features/gateway/server/backfill.ts`（**E3 结算职责退役处置**：`normalizeBackfillUsage` 与重试调度的结算路径删除；`usage_log_snapshot` 拉取逻辑保留、消费方改为仅 reconcile 对照）
- Test: `tests/gateway/settlement.test.ts` 扩展 / `tests/gateway/backfill.test.ts` 改写为退役后行为断言

**契约：**
- `settle` 入参从 `{buckets, usageSource}` 扩为 `{meters, flags, webSearchCount, rawUsage, usageSource}`；结算事务内完成：meter 数量 → 对应账本列（`input→uncachedInputTokens`、`cache_write→cacheWriteTokens`、`*_long→同名普通列 + longContextApplied=1`……映射表写为常量并测试）、`computeTokenChargeMicroUsd`/`computePerCallChargeMicroUsd` 计费、`unpricedMeters`/flags → `billingFlagsJson`、`rawUsage` → `rawUsageJson`、`chargedMicroUsd` 与钱包扣款事务结构不变。
- **finalize 按 scheme 分支（E3 + F1）**：`per_call` 结算条件 = 响应 `data` 可数（`unitCount`），usage 缺失照常 settle（token 照记列为空，flags 记 `usage_missing`）；`token` 制 usage 缺失 → **直接 `waived`（零计费）+ flags `usage_missing_waived` + 告警**，不再进 pending 等日志补差（E3 翻转，pending→backfill 结算链退役）。
- **漏拦检测**（E1）：请求上下文携带 `admissionLongContextThreshold`/`allowLongContext`（来自 T6 判定结果）；`allowLongContext=false` 且实际 `inputTotalTokens ≥ admissionLongContextThreshold` 时按普通档结算 + flag `long_context_block_missed` + 告警。
- 本任务完成后 routing/settlement/backfill 均已脱离旧接口；`PriceVector` 统一删除在 T12 收尾步骤执行（第 6 轮 F3）。
- 验收：`npm test -- tests/gateway/` 全绿；既有幂等/透支冻结用例不回归；usage 缺失两 scheme 分支用例（token→waived、per_call→settle）；漏拦三态用例（命中长档 / 关态漏拦打标 / 无长档能力不检测）。
- [x] 完成后 commit：`git commit -m "feat: 结算写入 meter 列与凭证/标记"`

---

### Task 8: 转发层准入三项（骨架级）

**Files:**
- Modify: `src/features/gateway/server/handler.ts`（准入段，`ensureCatalogRouteSnapshot` 返回后、转发前）
- Test: `tests/gateway/admission.test.ts` 扩展

**契约：**
1. **272K 拦截**（读 T6 判定结果的 `admissionLongContextThreshold` + `allowLongContext`，E1 检测通道；不从 rates_json 反推）：`allowLongContext=false` 且模型配有阈值时，保守估算 `estimatedInputTokens = ceil(totalRequestChars / 2.5) + 128 × messageCount`（系数常量可调，宁高勿低），≥ 阈值 → 413/400 明示"该分组未开放长上下文"。
2. **server tools 未配价拒绝**：请求体 `tools[]` 含 server-side 类型（首版名单常量：`web_search` 系 type 前缀）且快照 `rates_json.web_search` 缺失 → 400 明示未开放；配价（含 0）→ 放行。client function calling（`type:"function"`/`custom`）不受影响。
3. **per_call SKU 准入**：`billingScheme='per_call'` 时从请求体取 `quality`/`size` 拼 skuKey（字典序 `k=v;` 规范，缺省/`auto` → `default`），查 `tiers_json` 不存在 → 400 明示"该质量/尺寸组合未开放"；命中价随请求上下文传给 T7 结算。
- 验收：admission 测试覆盖三项 × 放行/拒绝两态；272K 拦截另覆盖三态（开着开关放行命中长档 / 关着开关拦截 / 关着开关低估漏拦由 T7 响应侧打标——与 T7 用例衔接）。
- [x] commit：`git commit -m "feat: 转发层准入——长上下文/工具/SKU 三项拦截"`

---

### Task 9: images 端点接入（骨架级）

**Files（第 6 轮 F1 扩围：请求/转发/超时链路全部纳入本任务）：**
- Modify: `src/features/gateway/lib/config.ts`（端点注册表：新增 `images_generations`（JSON）、`images_edits`（multipart）；**新增 endpoint 级上游首包超时覆盖**——images ≥180s，现状全局 120s 不满足 DESIGN §7.6）
- Modify: `src/features/gateway/server/handler.ts`（multipart 请求体解析分支：从整体缓冲的 body 中按白名单提取文本字段——E2 减配后请求侧维持 `readBodyBounded` 整体缓冲 + 25MiB 上限，不做流式落盘）
- Modify: `src/features/gateway/server/forward.ts`（multipart 原文转发：`Uint8Array` 请求体与 `content-type: multipart/form-data; boundary=...` 头原样透传，确认现签名兼容或扩展）
- Modify: `src/features/gateway/lib/sse-parser.ts`（非流式响应提取：跳过 `b64_json` 大块，仅取顶层 `usage` + `data.length` + 每项 `url` 有无）
- Create: `tests/fixtures/newapi/images-generations-runapi.json`（用第 4 轮实测真实响应脱敏落 fixture：URL 格式、双风格合成 usage）
- Test: `tests/gateway/handler` 集成用例 + `billing.test.ts` images 归一化用例

**契约（DESIGN §7.6 五条 + E2 减配）：**
1. 端点注册声明请求格式 / model 提取 / usage 与张数位置 / 非流式 / **首包超时 ≥180s**（endpoint 级覆盖全局值）。
2. multipart 白名单提取（E2 减配版）：请求体整体缓冲（25MiB 上限内，内测可接受），从中仅解析 `model`/`prompt`（长度上限）/`quality`/`size`/`n` 文本字段用于准入与 SKU 判定；**boundary/字段顺序不做任何假设**；图片文件字段不解码、不入日志；转发按原文字节透传。流式落盘方案记 issues。
3. 响应解析不整体缓冲 b64：SAX 式跳过或按 `parseBufferMax` 前置判断 + URL 响应快路径；`data.length` 为 `unitCount` 事实源。
4. 张数按实际；**per_call 结算独立于 usage**（T7 契约）：有张数即结算，usage 缺失只影响 token 照记列；解析不出张数 → 失败复核路径不扣费。
5. 上线冒烟（转 T12）。
- 验收（第 6 轮 F1 补齐四类）：fixture 驱动端到端（准入 SKU → 转发 stub → 结算 per_call 列）+ **任意字段顺序 multipart** + **无 usage 但有 data 的响应正常按次结算** + **>32MiB b64 响应仍能提取张数结算** + **慢首包（>120s <180s）不被中断**，全绿。
- [x] commit：`git commit -m "feat: images 端点接入与按次结算链路"`

---

### Task 10: newapi 同步降级为成本守卫（骨架级）

**Files:**
- Modify: `src/features/api-catalog/server/pricing-sync.ts`（停写 `base*` 价格列；`syncStatus` 语义收敛为参照新鲜度）
- Modify: 告警/对比逻辑所在模块（`grep -rn "driftStatus" src/features/api-catalog/server` 定位）
- Test: `tests/api-catalog/` 对应扩展

**契约：** 同步只更新 `source*` 参照列与 `sourceSyncedAt`；倒挂告警 = 有效卖价（rates_json）vs `ratio 推导 × groupRatio` 可比子集逐项对比 + 按次 default 档对比；预填接口返回换算值不落库。`driftStatus` 语义改为 `cost_alert`（倒挂）/`cost_changed`（变动）/`ok`，不再参与 callable（T6 已删门）。
- [x] commit：`git commit -m "feat: newapi 同步降级为只读成本守卫"`

---

### Task 11: 管理 UI（骨架级）

**Files:**
- Modify: 价格表单组件（`grep -rn "baseInputMicroUsd" src/app src/features --include='*.tsx' -l` 定位）与对应 server action
- Test: 对应表单 action 的单测（若现有表单无测试则仅 action 层）

**契约（字段清单）：** ① 价格表单补：计费方式（token/per_call 切换）、cache_write/cached_image_input/web_search 三列、长档阈值 + 四价（配了阈值才显示）、能力声明勾选（billingCapabilitiesJson）；② tier 价目表编辑器（增删行，default 行必填校验）；③ listing 行加"长上下文"开关；④ 四数展示：基准价 / 折扣 / 折后价 / 成本参照；⑤ 门禁拒绝原因透出到表单错误；⑥ "按 newapi 参照预填"按钮。
- [x] commit：`git commit -m "feat: 定价管理界面适配 meter 化配置"`

---

### Task 12: 对账、冒烟与收尾验收

**Files:**
- Modify: `src/features/gateway/server/reconcile.ts`（第 6 轮 F3：旧公式消费点显式归属本任务——对账重算切换到 meter 公式，覆盖 token / per_call（`unit_count × tier`）/ 工具附加费三种口径；`billingFlagsJson` 非空请求计数入对账报表；**E3：`usage_log_snapshot` 仅作对照源**——门户 waived/结算结果 vs newapi 日志逐笔对照，异常与系统性丢 usage 计数告警，不回写结算）
- Modify: `scripts/smoke-gateway.ts`：增 images 一跑（low 档）+ 272K 切档一跑（开着开关的测试分组，输入 >272K 校验账本 `longContextApplied=1` 且按长档价结算）

**收尾步骤（第 6 轮 F3）：**
- [x] reconcile 切换完成后，删除 `PriceVector` 与旧 `computeChargeMicroUsd`，全仓 `grep -rn "PriceVector\|computeChargeMicroUsd(" src tests` 清零。

**最终验收清单（全部通过才算完成）：**
- [x] `npm test` 三绿（test/lint/build）；schema-guard 与全部既有用例无回归。
- [ ] 手工验收：管理台配置 gpt-5.6-luna 满配（含 cache_write 6.25/长档/能力声明）→ 发布 → 网关实调 → 账本行 meter 列、凭证列、charged 与手算一致。
- [ ] gpt-image-2：配 per_call tier（default 按最贵档）→ 实调生成 → `skuKey`/`unitCount`/token 照记列正确、charged = n × tier。
- [ ] 272K：关开关分组被拦截（明示错误）；开开关分组实调 >272K 按长档价结算。
- [x] 迁移演练：备份 → 迁移 → SQLite `PRAGMA integrity_check` + `PRAGMA foreign_key_check` → 冒烟；存量 `model_price_version` 行等价迁移核对（若选择清空，走独立人工脚本并留审计记录）。
- [x] commit：`git commit -m "test: 对账统计与定价冒烟收尾"`

---

## 外部依赖（非代码任务，实施期间并行推进）

1. sub2api 侧为分组账号开通 gpt-image-2（旧 apipool 管理面，用户操作）——完成前 gpt-image-2 仅经 runapi 渠道冒烟。
2. multipart edits 场景的渠道级验证（依赖 1 或 runapi edits 支持确认）。
3. Sonnet 5 促销价 2026-09-01 到期：8 月底人工改价（运营日历提醒）。
