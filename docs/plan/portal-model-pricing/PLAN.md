# 模型价格配置与调用计费 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

- 日期：2026-07-20
- 依据：[../../design/portal-model-pricing/DESIGN.md](../../design/portal-model-pricing/DESIGN.md)（终审 GO，O1–O13 全部并入）
- 状态：计划初版（待对抗评审）

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

- [ ] **Step 1: 写失败测试**

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

- [ ] **Step 2: 运行确认失败**：`npm test -- tests/gateway/meters.test.ts`，预期 "Cannot find module .../meters"。
- [ ] **Step 3: 最小实现**

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

- [ ] **Step 4: 测试通过**：`npm test -- tests/gateway/meters.test.ts` 全绿。
- [ ] **Step 5: Commit**：`git add src/features/gateway/lib/meters.ts tests/gateway/meters.test.ts && git commit -m "feat: 新增计费 meter 词表模块"`

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

- [ ] **Step 1: 向量映射测试**（把现有五桶用例翻译成 meter 键；沿用现有取数规则，含 chat/responses/messages/embeddings）

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

- [ ] **Step 2: R9 等式校验测试**

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

- [ ] **Step 3: R10 结构化未知项测试**

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

- [ ] **Step 4: O9 长档判定测试**

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

- [ ] **Step 5: 全量跑 `npm test -- tests/gateway/billing.test.ts`，旧五桶断言全部改写完毕、全绿。**
- [ ] **Step 6: Commit**：`git commit -m "feat: usage 归一化输出 meter 向量（等式校验/结构检测/长档判定）"`

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

- [ ] **Step 1: 失败测试**

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

- [ ] **Step 2: 实现**（骨架，保持 `ceilDiv` 唯一舍入点与 min 1）

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

- [ ] **Step 3: 全绿后删除 `PriceVector` 旧类型与旧 `computeChargeMicroUsd`**（`normalizeBackfillUsage` 同步改为输出 `MeterQuantities`，Anthropic/OpenAI 语义分支保留）。全仓 `grep -rn "PriceVector\|computeChargeMicroUsd(" src tests` 清零旧引用。
- [ ] **Step 4: Commit**：`git commit -m "feat: 计费公式 map 化并支持 per_call 与工具附加费"`

---

### Task 4: 网关层 schema 重建与账本增列

**Files:**
- Modify: `src/config/db/schema.sqlite.ts`（`modelPriceVersion` L1225–1277、`requestLedger` L1366–1431；postgres/mysql 两份同步）
- Create: `src/config/db/migrations/<下一编号>_pricing_v2.sql`（编号用 `ls src/config/db/migrations | tail -1` 确认）
- Test: `tests/db/schema-guard.test.ts`（按现有 schema-guard 模式更新期望列集）

**Interfaces（Produces，T6/T7 依赖）：**
- `modelPriceVersion` 新列：`billingScheme text NOT NULL default 'token'`、`ratesJson text NOT NULL default '{}'`、`tiersJson text NOT NULL default '{}'`、`longContextThresholdTokens integer`；**删除** `inputMicroUsdPerM` 等五个单价列；`newapiRef*` 五列与版本链、`uniq_model_price_version_active` 索引保留。
- `requestLedger` 增列（全部可空）：`billingScheme`、`cacheWriteTokens`、`imageInputTokens`、`cachedImageInputTokens`、`imageOutputTokens`、`skuKey`、`unitCount`、`longContextApplied`（integer 0/1）、`billingFlagsJson`、`rawUsageJson`、`webSearchCount`；现有 `uncachedInputTokens/cachedReadTokens/cacheWrite5mTokens/cacheWrite1hTokens/outputTokens/reasoningTokens` 保留语义不变。

- [ ] **Step 1: 更新 schema-guard 期望**（先改测试，跑出列差异失败清单）。
- [ ] **Step 2: 改 schema.sqlite.ts + 迁移 SQL**。`model_price_version` 用 SQLite 十二步重建法（建新表→迁移旧行：五列值折算为 `rates_json`（键名 input/cached_input/cache_write_5m/cache_write_1h/output）→改名替换）；**迁移脚本不含清空分支**——若旧行存在则等价迁移，清空是独立的人工脚本（Global Constraints）。
- [ ] **Step 3: `npm test -- tests/db/` 全绿；`npm run build` 通过。**
- [ ] **Step 4: Commit**：`git commit -m "feat: 网关价格版本 map 化重建与账本增列"`

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
- 数据迁移：`fixedPriceMicroUsd` 非空的行 → `catalogModelPriceTier(modelId, 'default', fixedPriceMicroUsd)`，原两列标记废弃（暂保留列、停止读写）。

- [ ] Step 1–4 同 T4 节奏（测试先行 → schema+迁移 → 绿 → commit `git commit -m "feat: 目录价格增列与按次价表"`）。

---

### Task 6: 快照桥完备集门禁 + callable 解耦

**Files:**
- Modify: `src/features/gateway/server/catalog-route-snapshot.ts`（全文改造）
- Modify: `src/features/api-catalog/server/queries.ts`（`isCatalogRouteReady` L230–245）
- Test: `tests/gateway/catalog-route-snapshot.test.ts`（现有文件重写门禁矩阵）

**Interfaces:**
- Consumes: T4/T5 的新列
- Produces: `loadCatalogRouteConfig` 产出 `{ newapiGroup, newapiModelId, billingScheme, ratesJson, tiersJson, longContextThresholdTokens }`；`ensureCatalogRouteSnapshot` 签名不变（T7 依赖）。

核心改造点（每点先写门禁矩阵测试）：

- [ ] **Step 1: `isCatalogRouteReady` 删三硬门**——新条件集：`isCallable` + `newapiGroup` 非空 + `basePriceSyncStatus === 'manual' && reviewedAt 非空` + 发布门禁通过（由 `loadCatalogRouteConfig` 返回非 null 承担）；**删除** `pricePolicy === 'inherit_group'`、`priceDriftStatus === 'matched'`、`groupPricingSyncStatus === 'synced'`、`groupRatioBps > 0` 四项（DESIGN §9）。
- [ ] **Step 2: 完备集门禁**（替换 L84–113 的固定检查）：按 `billingCapabilitiesJson` 声明逐项校验对应价格列非空（声明 `cache_write:true` 则 `baseCacheWriteMicroUsd` 必填；`long_context:true` 则阈值 + 长档四价必填；`web_search:true` 则 `baseWebSearchMicroUsd` 必填）；基础必需集：token 类 `input`（+按 endpoint 的 `output`/`image_*`）、per_call 类 tier 表存在 `default` 行。任何缺失 → 返回 null（不可调用），错误原因写入日志。
- [ ] **Step 3: 折算与编译**：`scaledPrice(base, listing.discountRateBps ?? 10000)`（**弃用 groupRatioBps**，O2）逐列折算 → `rates_json`（长档键仅当 `allowLongContext=1` 时写入，含阈值；关 = 不写，DESIGN §6.2 开关编译）；per_call 折算 tier 表 → `tiers_json`；`priceMatches` 改为比对 `billingScheme + ratesJson + tiersJson + longContextThresholdTokens` 字符串相等。
- [ ] **Step 4: 门禁矩阵测试全绿**（覆盖：满配可发布 / 声明有而未配拒绝 / 长档开关开关两态的 rates_json 差异 / per_call 无 default 拒绝 / 折扣折算 round-half-up）。
- [ ] **Step 5: Commit**：`git commit -m "feat: 快照桥完备集门禁与 callable 三硬门解耦"`

---

### Task 7: 结算路径写入新列（骨架级）

**Files:**
- Modify: `src/features/gateway/server/handler.ts`（finalize L438–480：`normalizeUsage` → `normalizeUsageMeters`，携带价格版本的 threshold）
- Modify: 结算模块（`deps.settle` 实现处，`grep -rn "function settle\|settle(" src/features/gateway/server` 定位）
- Test: `tests/gateway/settlement.test.ts` / `tests/gateway/backfill.test.ts` 扩展

**契约：**
- `settle` 入参从 `{buckets, usageSource}` 扩为 `{meters, flags, webSearchCount, rawUsage, usageSource}`；结算事务内完成：meter 数量 → 对应账本列（`input→uncachedInputTokens`、`cache_write→cacheWriteTokens`、`*_long→同名普通列 + longContextApplied=1`……映射表写为常量并测试）、`computeTokenChargeMicroUsd`/`computePerCallChargeMicroUsd` 计费、`unpricedMeters`/flags → `billingFlagsJson`、`rawUsage` → `rawUsageJson`、`chargedMicroUsd` 与钱包扣款事务结构不变。
- pending 补差路径（`normalizeBackfillUsage`）：结算时追加 flag `backfill_degraded`（DESIGN §7.5）。
- 验收：`npm test -- tests/gateway/` 全绿；既有幂等/透支冻结用例不回归。
- [ ] 完成后 commit：`git commit -m "feat: 结算写入 meter 列与凭证/标记"`

---

### Task 8: 转发层准入三项（骨架级）

**Files:**
- Modify: `src/features/gateway/server/handler.ts`（准入段，`ensureCatalogRouteSnapshot` 返回后、转发前）
- Test: `tests/gateway/admission.test.ts` 扩展

**契约：**
1. **272K 拦截**（配 threshold 且 listing 关开关，即快照 `rates_json` 无长档键但目录配了阈值——注意：开关状态需在 config 加载时一并返回）：保守估算 `estimatedInputTokens = ceil(totalRequestChars / 2.5) + 128 × messageCount`（系数常量可调，宁高勿低），≥ 阈值 → 413/400 明示"该分组未开放长上下文"。
2. **server tools 未配价拒绝**：请求体 `tools[]` 含 server-side 类型（首版名单常量：`web_search` 系 type 前缀）且快照 `rates_json.web_search` 缺失 → 400 明示未开放；配价（含 0）→ 放行。client function calling（`type:"function"`/`custom`）不受影响。
3. **per_call SKU 准入**：`billingScheme='per_call'` 时从请求体取 `quality`/`size` 拼 skuKey（字典序 `k=v;` 规范，缺省/`auto` → `default`），查 `tiers_json` 不存在 → 400 明示"该质量/尺寸组合未开放"；命中价随请求上下文传给 T7 结算。
- 验收：admission 测试覆盖三项 × 放行/拒绝两态。
- [ ] commit：`git commit -m "feat: 转发层准入——长上下文/工具/SKU 三项拦截"`

---

### Task 9: images 端点接入（骨架级）

**Files:**
- Modify: 网关端点注册（`grep -rn "GatewayEndpointKey\|chat_completions" src/features/gateway/lib/config.ts src/features/gateway/lib` 定位注册表）：新增 `images_generations`（JSON）、`images_edits`（multipart）
- Modify: `src/features/gateway/lib/sse-parser.ts`（非流式响应提取：跳过 `b64_json` 大块，仅取顶层 `usage` + `data.length` + 每项 `url` 有无）
- Create: `tests/fixtures/newapi/images-generations-runapi.json`（用第 4 轮实测真实响应脱敏落 fixture：URL 格式、双风格合成 usage）
- Test: `tests/gateway/handler` 集成用例 + `billing.test.ts` images 归一化用例

**契约（DESIGN §7.6 五条）：**
1. 端点注册声明请求格式 / model 提取 / usage 与张数位置 / 非流式。
2. multipart 白名单提取：仅 `model`/`prompt` 长度上限/`quality`/`size`/`n` 文本字段，文件部分流式透传不进内存缓冲（有界读）。
3. 响应解析不整体缓冲 b64：SAX 式跳过或按 `parseBufferMax` 前置判断 + URL 响应快路径；`data.length` 为 `unitCount` 事实源。
4. 张数按实际；解析不出张数 → 失败复核路径不扣费。
5. 上线冒烟（转 T12）。
- 验收：fixture 驱动的端到端测试（准入 SKU → 转发 stub → 结算 per_call 列）全绿。
- [ ] commit：`git commit -m "feat: images 端点接入与按次结算链路"`

---

### Task 10: newapi 同步降级为成本守卫（骨架级）

**Files:**
- Modify: `src/features/api-catalog/server/pricing-sync.ts`（停写 `base*` 价格列；`syncStatus` 语义收敛为参照新鲜度）
- Modify: 告警/对比逻辑所在模块（`grep -rn "driftStatus" src/features/api-catalog/server` 定位）
- Test: `tests/api-catalog/` 对应扩展

**契约：** 同步只更新 `source*` 参照列与 `sourceSyncedAt`；倒挂告警 = 有效卖价（rates_json）vs `ratio 推导 × groupRatio` 可比子集逐项对比 + 按次 default 档对比；预填接口返回换算值不落库。`driftStatus` 语义改为 `cost_alert`（倒挂）/`cost_changed`（变动）/`ok`，不再参与 callable（T6 已删门）。
- [ ] commit：`git commit -m "feat: newapi 同步降级为只读成本守卫"`

---

### Task 11: 管理 UI（骨架级）

**Files:**
- Modify: 价格表单组件（`grep -rn "baseInputMicroUsd" src/app src/features --include='*.tsx' -l` 定位）与对应 server action
- Test: 对应表单 action 的单测（若现有表单无测试则仅 action 层）

**契约（字段清单）：** ① 价格表单补：计费方式（token/per_call 切换）、cache_write/cached_image_input/web_search 三列、长档阈值 + 四价（配了阈值才显示）、能力声明勾选（billingCapabilitiesJson）；② tier 价目表编辑器（增删行，default 行必填校验）；③ listing 行加"长上下文"开关；④ 四数展示：基准价 / 折扣 / 折后价 / 成本参照；⑤ 门禁拒绝原因透出到表单错误；⑥ "按 newapi 参照预填"按钮。
- [ ] commit：`git commit -m "feat: 定价管理界面适配 meter 化配置"`

---

### Task 12: 对账、冒烟与收尾验收

**Files:**
- Modify: reconcile 模块（`grep -rn "reconcileStatus" src/features/gateway/server` 定位）：`billingFlagsJson` 非空请求计数入对账报表
- Modify: `scripts/smoke-gateway.ts`：增 images 一跑（low 档）+ 272K 切档一跑（开着开关的测试分组，输入 >272K 校验账本 `longContextApplied=1` 且按长档价结算）

**最终验收清单（全部通过才算完成）：**
- [ ] `npm test` 三绿（test/lint/build）；schema-guard 与全部既有用例无回归。
- [ ] 手工验收：管理台配置 gpt-5.6-luna 满配（含 cache_write 6.25/长档/能力声明）→ 发布 → 网关实调 → 账本行 meter 列、凭证列、charged 与手算一致。
- [ ] gpt-image-2：配 per_call tier（default 按最贵档）→ 实调生成 → `skuKey`/`unitCount`/token 照记列正确、charged = n × tier。
- [ ] 272K：关开关分组被拦截（明示错误）；开开关分组实调 >272K 按长档价结算。
- [ ] 迁移演练：备份 → 迁移 → SQLite `PRAGMA integrity_check` → 冒烟；存量 `model_price_version` 行等价迁移核对（若选择清空，走独立人工脚本并留审计记录）。
- [ ] commit：`git commit -m "test: 对账统计与定价冒烟收尾"`

---

## 外部依赖（非代码任务，实施期间并行推进）

1. sub2api 侧为分组账号开通 gpt-image-2（旧 apipool 管理面，用户操作）——完成前 gpt-image-2 仅经 runapi 渠道冒烟。
2. multipart edits 场景的渠道级验证（依赖 1 或 runapi edits 支持确认）。
3. Sonnet 5 促销价 2026-09-01 到期：8 月底人工改价（运营日历提醒）。
