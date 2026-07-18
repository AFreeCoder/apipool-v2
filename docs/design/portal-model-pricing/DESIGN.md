# 模型价格配置与调用计费方案（设计）

- 日期：2026-07-18
- 状态：评审中（第 1 轮裁决已并入正文，评审过程见 [review-log.md](./review-log.md)）
- 关联调研：[research.md](./research.md)（厂商计费模式事实、newapi/LiteLLM 方案对比）
- 承接遗留：`docs/dev/portal-newapi-routing-billing-decoupling/issues.md` 中"gpt-5.5 三维价格（S2）""OpenAI 长上下文阶梯计费未支持""GPT-5.6 cache write 单一价"三项（本设计给出承载结构；勾选在实现合入时进行）

## 1. 背景与需求回顾

门户的模型基础价格、折扣与计费独立结算（不依赖 newapi 扣费）。需要优化模型元数据中的价格配置方案，因为后续模型形态发散：

1. 模型类型多样：文本之外将有图片模型（首发含 GPT-image-2），远期有视频模型。
2. 同类型计费方式有差异：GPT 早期只有输入/输出，后续加缓存读，GPT-5.6 起再加缓存写；Claude 缓存写还分 5 分钟/1 小时两档，各类 token 单价不同。
3. 图片模型两种模式并存：token 计量制（输入还分文本 token/图片 token）与按次计费制（按 质量/尺寸/张数 阶梯定价）。
4. 要求：贴合未上线阶段、优先覆盖首发清单（GPT-5.6/5.5/5.4、GPT-image-2、Claude Fable-5/Opus-4.8/4.7/4.6/Sonnet-5/4.6/Haiku-4.5）、方案简单但可扩展、可参考 newapi。

### 1.1 现状摘要（事实基础，摸查报告 2026-07-18）

现有架构分两层，中间以快照桥连接：

```
目录层（人工配置/展示）                     网关层（结算唯一事实源）
catalog_model ──┬─ catalog_model_price      model_route ── model_price_version
                └─ catalog_model_listing        │              （不可变价格版本）
catalog_group（分组倍率 bps）                    ▼
        │            ▲                      request_ledger ── wallet_ledger
        └── 快照桥 catalog-route-snapshot.ts ──┘（准入锁定 priceVersionId）
```

- 目录层：`catalog_model_price` 存五档文本基准价 + 图片两列 + 按次两列（micro-USD/1M 整数）；`catalog_group.newapiGroupRatioBps` 分组倍率；`catalog_model_listing` 有折扣字段与四态 pricePolicy。基准价可由 newapi `/api/pricing` 同步推导（`model_ratio × $2/1M` 起算），带漂移检测。
- 网关层：`normalizeUsage` 把上游 usage 归一为五个互斥桶（uncachedInput/cachedRead/cacheWrite5m/cacheWrite1h/output），`computeChargeMicroUsd` 全程 BigInt、唯一舍入点向上取整、最低 1 micro-USD；结算单事务写账本+扣钱包，价格版本在准入时快照。
- 该骨架与调研结论（绝对单价、meter 互斥、账本快照）方向一致，**保留不推翻**。

### 1.2 现状缺口（本设计要解决的问题）

| # | 缺口 | 后果 |
|---|---|---|
| G1 | 网关 `PriceVector` 与计费公式固定五桶，无图片维度 | gpt-image-2 类 token 制图片模型无法结算 |
| G2 | `model_price_version` 无按次价格，快照桥要求五维 token 价为正 | 按次模型（dall-e-3 类）不生成路由，不可调用 |
| G3 | 目录层缺"图片输入缓存读"档、缺无 TTL 的通用"缓存写"档 | gpt-image-2 五个计费项配不齐；GPT-5.6 缓存写只能借用 5m 档 |
| G4 | 按次无阶梯：`fixedPriceMicroUsd` 单价一档 | 质量×尺寸×张数 的价表无处表达 |
| G5 | 折扣残缺：listing 折扣字段纯展示；启用非 inherit_group 策略即被快照桥拒绝（模型不可调用） | "折扣设置"事实上只有分组倍率一层 |
| G6 | 五维价格全量必填（含 embeddings 的 output 价） | 配置语义别扭，无法表达"此模型没有这个计费项" |
| G7 | OpenAI 长上下文阶梯、音频/视频计费无承载结构 | 后续扩展需再动 schema 与公式 |

## 2. 目标 / 非目标

**目标**

1. 一套模型价格配置结构，覆盖首发清单全部模型（文本多档缓存 + token 制图片 + 按次图片），并让"加计费项"退化为加数据而非改公式。
2. 计费引擎一般化：usage 归一化 → meter 数量向量 × 单价向量 → 单舍入点，两种计费方案（token / per_call）同一骨架。
3. 折扣闭环：卖价公式收敛为「手填基准价 × 折扣」唯一策略，折扣真实参与定价并进入账本快照。
4. 价格完备性前移到发布门禁（配置时校验），运行期只做确定性计算与保守回退。
5. 给出首发清单的落地配置示例与迁移顺序。

**非目标（显式 defer，见 §12）**

- 长上下文阶梯计价（>200K 溢价档）——预留 meter 命名空间，不实现。
- 音频、视频模型计费——结构预留（per_call 同构扩展 per_second），不实现。
- 多币种、用户级/时段级折扣、生效时间调度、用量阶梯（volume tier）。
- newapi 同步管线重写——仅做降级改造（§9）。

## 3. 候选方案对比与裁决

| | 方案 A：全列式扩展 | 方案 B：全 JSON 化 | 方案 C：分层混合（推荐） |
|---|---|---|---|
| 思路 | 每个新计费项在目录层与网关层各加一列，公式遍历固定列 | 目录层与网关层价格全部改为 meter→单价 JSON | 目录层维持列式（补 2 列 + 1 阶梯表）；网关价格版本改为 meter map + 阶梯 map |
| 加新计费项 | 两层各加列 + 迁移 + 改 PriceVector + 改公式 | 加键 | 网关侧加键；目录侧加列（低频，见裁决理由） |
| 按次/阶梯 | 列无法表达，仍需新表 | tiers JSON | tiers 表（目录）+ tiers JSON（网关快照） |
| 人工配置体验 | 好（表单一项一格） | 差（裸 JSON 或需重写整套表单） | 好（表单照旧，微增） |
| 对现有代码冲击 | 目录小、网关公式反复改 | 目录层 UI/同步/漂移检测全部重写 | 目录层微调；网关层一次性一般化 |
| SQL 可查询性 | 好 | 差（SQLite JSON 查询弱） | 目录好；网关版本表不需查询（只读快照） |

**裁决：方案 C。** 理由：

1. 两层的约束不同。目录层是人工配置面，列式 + 表单 + 同步/漂移检测刚收敛完（model-admin-pricing-simplification），首发清单只差 2 列 + 1 张阶梯表，重写为 JSON 收益为负；网关层的 `model_price_version` 本来就是系统自动生成的不可变快照、无人工编辑界面，改为 meter map 的影响面收敛在代码内部，而这里恰是"加计费项不改公式"最需要发生的地方。
2. LiteLLM 证明 meter map 承载全部模态可行（research §2.2）；newapi 证明"把计费项塞进固定公式"的路线每加一项都痛（research §2.1）。
3. 未上线阶段允许网关层破坏性迁移（重建 `model_price_version`），一次到位比双轨兼容便宜。
4. 目录层何时 JSON 化，推迟到第三种模态（音频/视频）真正进清单时再评估——届时若列继续膨胀（>12 个价格列），以 `extraRatesJson` 承接低频 meter，高频列保留。本设计不实现，仅在 §6.1 预留演进说明。

## 4. 总体设计

不变式（沿用现状）：

- 结算唯一事实源是不可变 `model_price_version`，准入时锁定 `priceVersionId`，账本审计不依赖目录层现值。
- 全链路整数运算：单价 micro-USD（token 类为 per 1M tokens），BigInt 求和，唯一舍入点向上取整，最低扣费 1 micro-USD。
- 折扣在**配置期**折算进快照单价，运行期引擎只做 Σ(数量 × 单价)。

新增的核心抽象是两个：**计费词表（meter）**与**计费方案（billing scheme）**。

```
                     ┌────────── 目录层（人工配置）──────────┐
                     │ catalog_model_price（列式基准价，手填）│
                     │ catalog_model_price_tier（按次价表）   │
                     │ listing.discountRateBps（折扣，默认1.0）│
                     └──────────────┬───────────────────────┘
                                    │ 快照桥：折算 + 发布门禁（§7.4）
                                    ▼
   model_price_version { billingScheme, ratesJson: {meter→单价}, tiersJson: {sku→单价} }
                                    │
 请求 ──► 准入(锁定版本) ──► 转发上游 ──► usage 归一化(§7.1/7.2) ──► 计价(§7.3) ──► 结算入账(§7.5)
                                          meter 数量向量              Σ qty×rate / sku×n
```

## 5. 计费词表与计费方案

### 5.1 meter 词表（规范键名）

meter 是"一种被计量计价的量"。键名全局唯一、snake_case，与账本/价格/归一化共用同一词表（单一 TS 常量模块导出，作为类型与校验的唯一事实源——实现于 `src/features/gateway/lib/meters.ts`，目录层引用同一模块）。

**首发启用（token 类，量纲 tokens，单价 micro-USD / 1M tokens）：**

| meter 键 | 语义 | 现五桶对应 | 回退基 meter（§7.4） |
|---|---|---|---|
| `input` | 非缓存输入（文本） | uncachedInput | —（必需） |
| `cached_input` | 缓存读（文本） | cachedRead | `input` |
| `cache_write` | 缓存写·无 TTL 区分（OpenAI GPT-5.6） | 新增 | `input` |
| `cache_write_5m` | 缓存写·5 分钟档（Anthropic） | cacheWrite5m | `input` |
| `cache_write_1h` | 缓存写·1 小时档（Anthropic） | cacheWrite1h | `input` |
| `output` | 输出 | output | —（按 endpoint 必需） |
| `image_input` | 图片输入 token | 新增 | —（images 必需） |
| `cached_image_input` | 图片输入缓存读 | 新增 | `image_input` |
| `image_output` | 图片输出 token | 新增 | —（images 必需） |

**预留命名空间（不实现，仅约定命名规则以防未来冲突）：** `audio_input` / `audio_output`（音频 token）、`input_above_200k` / `output_above_200k`（长上下文阶梯档）、`duration_seconds`（视频秒数）。

设计规则：

1. meter 之间数量**互斥不重叠**（归一化层负责消化上游"子集语义"，见 §7.1）。
2. `reasoning` tokens 维持现状：只记录不单独计价（包含在 `output` 内）。
3. OpenAI 无 TTL 的缓存写走独立 `cache_write`，不复用 `cache_write_5m`——账本审计语义干净，meter map 下新增键零公式成本；这同时是对 issues"GPT-5.6 cache write 单一价"的承载结构（价格数值仍需生产证据，见 §12）。

### 5.2 billing scheme（计费方案）

| scheme | 计费表达 | 适用 | 费用公式 |
|---|---|---|---|
| `token` | `rates: {meter → 单价}` | 文本模型、token 制图片模型（gpt-image-2）、embeddings | `ceilDiv(Σ qty_m × rate_m, 1e6)`，min 1 micro-USD |
| `per_call` | `tiers: {skuKey → 单价/次}`，必含 `default` | 按次图片模型（dall-e-3 类） | `n × tiers[sku]`，min 1 micro-USD |

- 一个模型恰好一种 scheme（沿用 newapi"按次/按量二选一"的经验；同模型分组间不同 scheme 不支持——newapi 同样未支持，见 research §2.1）。
- `per_call` 的 `skuKey` 规范：**按参数名字典序**拼接 `k=v` 对，`;` 分隔，如 `quality=hd;size=1024x1024`；查表失败逐级回退（§7.2）。数量 `n` = 实际生成张数。
- 未来视频按秒 = 新 scheme `per_second`，复用 `tiers`（sku=分辨率/档位）+ 数量（秒数），结构零新增——这是 per_call 结构的刻意同构（research §1.4）。

### 5.3 覆盖性自检（首发清单 → 结构）

| 模型 | scheme | 需要的价格数据 |
|---|---|---|
| gpt-5.4 / 5.4-mini / 5.4-nano / gpt-5.5 | token | input, cached_input, output（三维，S2 结论的正式承载） |
| gpt-5.4-pro / 5.5-pro | token | input, output（无缓存价） |
| gpt-5.6-sol / terra / luna | token | input, cached_input, cache_write, output |
| claude 全系（fable-5 → haiku-4.5） | token | input, cached_input, cache_write_5m, cache_write_1h, output |
| gpt-image-2 | token | input, cached_input, image_input, cached_image_input, image_output |
| dall-e-3（对照样例） | per_call | tiers: default + 各 质量×尺寸 |
| text-embedding-3-*（已有类目） | token | input（不再强迫配 output 假价，修复 G6） |

## 6. 数据模型变更

### 6.1 目录层（人工配置面，最小增量）

`catalog_model_price` 变更：

```sql
ALTER TABLE catalog_model_price ADD COLUMN billing_scheme TEXT NOT NULL DEFAULT 'token';
  -- 'token' | 'per_call'；原 pricing_mode 的 'fixed_price' 语义迁入 per_call，
  -- pricing_mode 保留表达"价格来源形态"（token_ratio/manual_token/...），逐步废弃 fixed_price 值
ALTER TABLE catalog_model_price ADD COLUMN base_cache_write_micro_usd INTEGER;      -- OpenAI 无 TTL 缓存写
ALTER TABLE catalog_model_price ADD COLUMN base_cached_image_input_micro_usd INTEGER; -- gpt-image-2 图片缓存读
-- 语义调整（不改列）：全部价格列允许 NULL = "该模型无此计费项"；
-- 必需性不再由列级 notNull 承担，统一交给发布门禁按 scheme 与 endpoint 判定（§7.4）：
-- token 类至少要 input（及按 endpoint 的 output/image_*），per_call 类可全空、只用 tier 表
```

新表 `catalog_model_price_tier`（按次价表）：

```sql
CREATE TABLE catalog_model_price_tier (
  id             TEXT PRIMARY KEY,
  model_id       TEXT NOT NULL REFERENCES catalog_model(id),
  sku_key        TEXT NOT NULL,            -- 'default' 或 'quality=hd;size=1024x1024'
  price_micro_usd INTEGER NOT NULL CHECK (price_micro_usd > 0),
  note           TEXT,
  UNIQUE (model_id, sku_key)
);
-- billing_scheme='per_call' 的发布门禁要求存在 sku_key='default' 行
-- 迁移：fixed_price_micro_usd/fixed_price_unit → default tier 一行，原两列标记废弃
```

现有列与新 meter 的对应关系（快照桥折算时的映射表）：

| 目录列 | meter |
|---|---|
| base_input_micro_usd | input |
| base_cached_input_micro_usd | cached_input |
| base_cache_write_micro_usd（新） | cache_write |
| base_cache_write_5m_micro_usd | cache_write_5m |
| base_cache_write_1h_micro_usd | cache_write_1h |
| base_output_micro_usd | output |
| base_image_input_micro_usd | image_input |
| base_cached_image_input_micro_usd（新） | cached_image_input |
| base_image_output_micro_usd | image_output |

演进预留：当价格列超过约 12 个（音频/视频等模态进清单）时，再评估把低频 meter 收进 `extra_rates_json` 一列，高频列不动；本期不做（§3 裁决 4）。

`catalog_model_listing` 变更：定价策略机制整体删除（配合 §8 单一公式，评审裁决 O2）——`pricePolicy` 与 `override*` 系列列随迁移移除（未上线无存量，seed 重建）；`discountRateBps` 保留并真实生效（默认 10000 = 不打折）。listing 继续承载展示缓存、上架、排序、冒烟标记等售卖属性；不同分组如需差异价，用各自 listing 的折扣字段表达，不引入新机制。

### 6.2 网关层（结算事实源，一次性一般化）

`model_price_version` 破坏性重建（未上线裁决；schema-guard 与相关测试同步更新）：

```sql
-- 删除五个单价列，替换为：
billing_scheme TEXT NOT NULL,               -- 'token' | 'per_call'
rates_json     TEXT NOT NULL DEFAULT '{}',  -- {meter: microUsdPer1M}，仅含已定价 meter
tiers_json     TEXT NOT NULL DEFAULT '{}',  -- {skuKey: microUsdPerUnit}，per_call 时必含 default
-- 保留：newapiRef* 参照列（方向校验）、publishedBy、版本链
CHECK (billing_scheme IN ('token','per_call'))
CHECK (billing_scheme != 'per_call' OR json_extract(tiers_json,'$.default') IS NOT NULL)
```

选择"删列改 map"而非"列 + map 双写"的理由：结算事实源必须单一表达，双写必然漂移；此表无人工编辑入口，影响面=代码与测试，一次迁移即收敛。

### 6.3 账本层（审计与报表）

`request_ledger` 变更（增列，不删列；评审裁决 O3：用量一律列式）：

```sql
ALTER TABLE request_ledger ADD COLUMN billing_scheme TEXT;               -- 结算时从价格版本冗余
-- token 用量补齐为"每 meter 一列"（与现有五桶列同构；列名实现时对齐既有命名风格）：
ALTER TABLE request_ledger ADD COLUMN cache_write_tokens INTEGER;        -- meter: cache_write
ALTER TABLE request_ledger ADD COLUMN image_input_tokens INTEGER;        -- meter: image_input
ALTER TABLE request_ledger ADD COLUMN cached_image_input_tokens INTEGER; -- meter: cached_image_input
ALTER TABLE request_ledger ADD COLUMN image_output_tokens INTEGER;       -- meter: image_output
-- 按次计费独立承载：
ALTER TABLE request_ledger ADD COLUMN sku_key TEXT;                      -- 命中的 SKU（含回退后实际用的）
ALTER TABLE request_ledger ADD COLUMN unit_count INTEGER;                -- 实际张数/次数
ALTER TABLE request_ledger ADD COLUMN billing_flags_json TEXT;           -- 仅异常时非空：缺价回退/SKU 回退等标记
```

- 现有五桶列**保留且语义不变**；全部 meter 数量都有专列，报表/对账 SQL 直查（裁决 O3：不走"图片量入 JSON"的方案）。未来新增 meter 时账本同步加列——与目录层同一取舍，频率低、可接受。
- `billing_flags_json` 只承载异常标记（§7.4 回退、SKU 回退），不承载数量。
- 单价快照依旧通过 `priceVersionId` 指向不可变版本，不在账本重复存 rates。

## 7. 计费流水线

### 7.1 usage 归一化（meter 数量向量）

`normalizeUsage` 的返回从五字段结构改为 `Record<MeterKey, bigint>`（仅含非零项）+ 元信息（`unmappedNonZero` 维持现状：告警、不入账、靠对账补差）。各 endpoint 适配器：

| endpoint | 取数规则（沿用现状，新增图片） |
|---|---|
| chat_completions | `cached_input = prompt_tokens_details.cached_tokens`；`cache_write = cache_creation_tokens ?? cache_creation_input_tokens`；`input = max(0, prompt_tokens − cached_input − cache_write)`（OpenAI 子集语义做减法）；`output = completion_tokens` |
| responses | 同上，字段取自 `input_tokens_details.*`（cache_write_tokens） |
| messages（Anthropic） | `input = input_tokens`（互斥语义不减）；`cached_input = cache_read_input_tokens`；`cache_write_5m/1h = cache_creation.ephemeral_*_input_tokens`（缺细分时汇总额入 5m，现状规则不变） |
| embeddings | `input = prompt_tokens` |
| **images（新增）** | `input = input_tokens_details.text_tokens`；`image_input = input_tokens_details.image_tokens`；`image_output = output_tokens`；缓存细分字段（若上游提供）映射到 `cached_input`/`cached_image_input`，**未提供细分时缓存量计 0 并进对账观察**（调研未取到 gpt-image-2 缓存 usage 字段样例，适配器留口） |

关键规范：归一化输出的 meter 数量**互斥不重叠**；"OpenAI cached 是输入子集、Anthropic 各桶互斥"的语义差异只允许在适配器内消化（research §1.5），计价公式不感知来源。

流式提取（sse-parser）不变；images 端点非流式，走现有 `extractBodyUsage` 路径。

### 7.2 per_call 的量与 SKU 判定

- **SKU**：从请求体参数派生（图片：`quality`、`size`；参数名白名单按模型能力配置，默认取这两个），按 §5.2 规范拼 key。
- **量 n**：优先响应实际张数（`data.length`），响应异常时回退请求参数 `n ?? 1`。
- **查表回退链**：`tiers[skuKey]` → 未命中则 `tiers['default']`，并在账本 `sku_key` 记录实际命中的 key、`billing_flags_json` 打回退标记（对账可见）。按次模型请求失败（上游 4xx/5xx 无产出）沿用现状失败路径（`failed_unbilled`），不扣费。

### 7.3 计价（唯一舍入点，公式一般化）

```ts
// scheme = token：qty、rate 均 BigInt；rates 仅含已定价 meter
total = Σ_m qty[m] × rateFor(m)        // rateFor 含 §7.4 回退
charged = max(ceilDiv(total, 1_000_000n), 1n)

// scheme = per_call：单价已是 micro-USD/次，整数直乘，无除法舍入
charged = max(BigInt(n) × tierPrice, 1n)
```

不变式沿用：全程 BigInt、无中间舍入、不跨请求携带余数。`computeChargeMicroUsd` 是仍然唯一的舍入位置。

### 7.4 价格完备性：发布门禁 + 运行期保守回退

**发布门禁（快照桥，配置期 fail-closed）**——缺以下必需项则拒绝发布路由（模型不可调用），错误信息指明缺哪个 meter：

| scheme | 必需集 |
|---|---|
| token | `input`；`output`（endpoint 含 chat/responses/messages 时）；`image_input` + `image_output`（endpoint 含 images 时） |
| per_call | `tiers.default` |

**发布期告警（不阻断）**——模型能力表明存在某可选计费项（如同步带出的 `cache_ratio`/`create_cache_ratio` 非零）而对应缓存价未配：发布成功但产生告警，防"忘配"与"确无此项"混淆（gpt-5.4-pro 无缓存能力，不告警；GPT-5.6 漏配 cache_write，会告警）。

**运行期保守回退（可选 meter 缺价时）**——上游返回了某可选 meter 的用量而版本未定价：按其**回退基 meter**（§5.1 表）单价计费，回退事件写入 `billing_flags_json` 标记并计数告警。方向性说明：对 `cached_*`（折扣档）回退到 `input`/`image_input` 是向上计费（用户失去缓存折扣、平台不亏）；对 `cache_write*`（溢价档，真实成本 1.25×–2× input）回退到 `input` 价是**成本低估**（低估幅度有界：该部分用量 × 写价与输入价之差），靠发布期告警 + 对账（`newapiQuota` 参照）驱动尽快补配。基础 meter（input/output/image_*）不存在"回退"，它们由门禁保证必有价。

这组规则替代现状"五维全量必填正整数"（修复 G6：embeddings 不再配 output 假价；gpt-5.4-pro 不配 cached_input 是合法明确的"无此计费项"）。

### 7.5 结算入账

结算事务结构不变（账本行终态 + 钱包流水 + 余额回填 + 透支冻结）。新增写入：`billing_scheme`、各新增 meter 数量列、`sku_key`、`unit_count`、异常时 `billing_flags_json`；既有五桶列继续按同名 meter 写入。`newapiQuota` 等对账参照列不变。

## 8. 定价公式（单一策略）

评审裁决（O2）：卖价公式收敛为**唯一一种**，不设策略判别器：

```
有效单价(meter) = 手填基准价(目录列) × 折扣(discountRateBps/10000)
per_call tier 同式。快照桥配置期折算，round-half-up 到整数 micro-USD，产出不可变版本。
```

1. **分组倍率退出卖价链**：`catalog_group.newapiGroupRatioBps` 不再乘入门户卖价，仅作为成本守卫的输入（§9，计算该分组的上游成本用）。不同分组默认同价；确需分组差异价时，用各自 listing 的折扣字段表达，不引入新机制。
2. **策略态全部删除**：O1 裁决（手填定价）后，"覆盖价"失去存在理由——基准价本身就是手填值，想改价直接改基准价或折扣。`pricePolicy`、`override*` 列随迁移移除；快照桥不再设策略硬门，配齐必需价即可发布（§7.4 门禁），修复"配折扣即不可调用"（G5）。
3. 折扣默认 10000（不打折）。
4. 展示与计费同源：`/models` 页与管理后台展示价直接读快照折算结果（`effectivePriceFormula` 继续记录换算式）——运营界面同屏显示 基准价 / 折扣 / 最终价 / 成本参照（§9）四个数，杜绝 newapi 式倍率心算。
5. 折扣进账本：账本经 `priceVersionId` 引用的版本即含折后单价，审计天然闭环；`discountRateBps` 作为版本元数据留存（快照桥写入），追溯"当时打几折"。
6. 促销价（如 sonnet-5 限时 $2/$10）：直接改基准价或设折扣，发新版本；历史账本引用旧版本不受影响。到期切换靠人工，不做生效时间调度（O4 裁决接受；远期可加官网价监控任务辅助盯价，见 §12）。

## 9. newapi 同步：降级为只读成本守卫

评审裁决（O1）：门户价格全部手填、唯一事实源在门户；同步管线保留但**永不写入任何门户价格**，职责收敛为三件事：

1. **成本参照采集**：定期拉取 `/api/pricing` 快照（沿用现有 client/fixture 体系），按可比子集换算成本参照价：`成本(meter) = ratio 系推导价 × 该分组 group_ratio`（推导规则沿用现状：`model_ratio × $2/1M`、`completion_ratio`、`cache_ratio`；`quota_type=1` 对 default tier）。newapi 表达不了的 meter（OpenAI 无 TTL 缓存写、图片输入缓存、阶梯 SKU）**不参与对比**——字段不匹配的兼容问题自然消解。
2. **倒挂与变动告警**：逐「模型 × 分组」比较 有效卖价（§8）vs 成本参照，卖价低于成本 → 倒挂告警；成本参照较上次快照变动 → 调价提醒。只告警，不改数。现有 `driftStatus`/告警管道复用，语义从"漂移检测"转为"成本守卫"。
3. **录入辅助（预填）**：管理台价格表单提供"按 newapi 参照价预填"按钮，换算值填入表单、人工确认才保存——同步进程不落库，预填只是打字的替代。首次建库可用现有 `backfill-catalog-pricing.ts` 一次性生成草稿，人工复核后定稿。

配套简化：`catalog_model_price.syncStatus` 语义收敛（价格一律 `manual`，参照数据新鲜度另行标记）；`source*` 参照列保留用于对比展示；`model_price_version.newapiRef*` 列保留（发布方向校验与成本守卫共用）。

## 10. 首发清单落地示例

（基准价为 2026-07-18 官方价，见 research；micro-USD/1M。示例含九折 `discountRateBps=9000` 演示值；分组不参与卖价，见 §8。）

**gpt-5.6-sol（token，四维）**

```
目录: base_input=5_000_000  base_cached_input=500_000  base_cache_write=6_250_000  base_output=30_000_000
快照(九折): rates_json = {"input":4500000,"cached_input":450000,"cache_write":5625000,"output":27000000}
```

**claude-fable-5（token，五维）**

```
目录: base_input=10_000_000  base_cached_input=1_000_000
      base_cache_write_5m=12_500_000  base_cache_write_1h=20_000_000  base_output=50_000_000
```

**gpt-5.4-nano（token，三维——cache_write 列留空=无此计费项）**

```
目录: base_input=200_000  base_cached_input=20_000  base_output=1_250_000
```

**gpt-image-2（token 制图片，五维，manual 录入）**

```
目录: base_input=5_000_000  base_cached_input=1_250_000
      base_image_input=8_000_000  base_cached_image_input=2_000_000  base_image_output=30_000_000
一次典型调用: input=120, image_input=0, image_output=6200
费用 = ceil((120×5e6 + 6200×30e6)/1e6) = 186_600 micro-USD ≈ $0.187（high/1024² 量级与官方估算一致）
```

**dall-e-3（per_call + 阶梯，对照样例）**

```
tiers: default=40_000 ；quality=hd;size=1024x1024 → 80_000 ；quality=hd;size=1792x1024 → 120_000
请求 quality=hd,size=1024x1024,n=2 → charged = 2 × 80_000 = 160_000 micro-USD = $0.16
```

## 11. 迁移与实施顺序

未上线阶段，允许对 `model_price_version` 破坏性重建；每步以现有测试缝为锚（tests/gateway/*、tests/api-catalog/*、tests/db/*）：

1. **词表与类型**：`meters.ts` 常量模块 + scheme 类型；schema-guard 测试更新预告。
2. **网关引擎一般化**（tests 先行）：`normalizeUsage` 输出 meter 向量（五桶键名映射）、`computeChargeMicroUsd` 按 map 遍历 + per_call 分支；`billing.test.ts` 重写为向量断言，新增 images/per_call 用例。
3. **网关 schema**：`model_price_version` 重建（rates/tiers/billing_scheme），`request_ledger` 增列；迁移 0013+。
4. **目录 schema**：增 2 列 + tier 表 + NULL 语义放开；fixed_price 迁移到 default tier；`catalog-pricing-migration.test.ts` 扩展。
5. **快照桥改造**：折算全 meter + tiers（基准 × 折扣单一公式）、发布门禁、策略字段移除；`catalog-route-snapshot` 测试补门禁/折扣矩阵。
6. **images 端点接入**：usage 适配器 + per_call SKU 判定 + 结算写新列；`handler/integration` 用例补 gpt-image-2、dall-e-3 fixture（tests/fixtures/newapi/ 增补）。
7. **同步降级为成本守卫**（§9）：停写价格、可比子集成本换算、倒挂/变动告警、预填接口。
8. **管理 UI**：价格表单补 2 档、tier 编辑、四数展示（基准/折扣/最终价/成本参照）、预填按钮、门禁错误提示。
9. **对账与冒烟**：reconcile 覆盖回退标记统计；dev smoke 增图片模型一跑。

依赖关系：1→2→3 严格串行；4/5 可与 2/3 并行开发但发布门禁依赖 3；6 依赖 2+3+5。

## 12. 已知局限与 defer 清单

| 项 | 处理 | 回链 |
|---|---|---|
| GPT-5.6 缓存写成本侧无 newapi 参照（`create_cache_ratio` 生产未返回） | O1 裁决后卖价手填即可发布、不再阻塞；但成本守卫对 `cache_write` 是盲区，倒挂监控不覆盖该 meter | issues.md 行 26，实现合入时勾选升级 |
| OpenAI 长上下文阶梯（`billing_mode/billing_expr`） | defer；meter 命名空间已预留 `*_above_200k` | issues.md 行 25，保持未勾 |
| gpt-image-2 缓存 usage 字段形态未证实 | 适配器留口 + 缓存量计 0 告警观察 | §7.1 |
| 同模型跨分组不同 scheme | 不支持（与 newapi 同边界） | research §2.1 |
| 多币种 / 用户级折扣 / 时段折扣 / volume 阶梯 / per_second | defer，结构已说明扩展位 | §2 非目标 |
| 官网价格监控定时任务（各厂商官网价自动比对） | 远期（O4 衍生想法）；成本守卫架构可挂第二参照源 | §9 |

## 13. 评审裁决记录

第 1 轮评审（2026-07-18，用户）裁决已全部并入正文，往返过程见 [review-log.md](./review-log.md)：

- **O1** → 手填定价 + newapi 降级为只读成本守卫（§9 重写）。
- **O2** → 比原两态提案更进一步：删除全部策略态，唯一公式 基准价 × 折扣；分组倍率退出卖价链（§8 重写、§6.1）。
- **O3** → 账本用量全列式：token 每 meter 一列、按次独立 sku/数量列（§6.3 重写）。
- **O4** → 接受人工改价；官网价监控任务记远期 defer（§12）。
- **O5** → 同意：计费方式（token/per_call）配置在模型元数据（§6.1 `billing_scheme`），SKU 参数白名单先代码常量（§5.2）。

## 14. 需求映射自查

| 需求 | 方案落点 |
|---|---|
| 未上线阶段、方案简单 | 目录层仅 +2 列 +1 表；文本模型配置零变化；破坏性迁移一次到位不留双轨 |
| 首发清单全覆盖 | §5.3 逐模型自检通过（含 gpt-image-2 五 meter、Claude 双 TTL 缓存写） |
| 扩展性 | 加计费项=加 meter 键（网关零公式改动）；加计费方式=新 scheme 复用 tiers 结构（per_second 同构）；长上下文/音频命名空间已预留 |
| 参考 newapi | 保留按次/按量二选一经验；吸取倍率制教训改为绝对单价 + 四数展示；其价格数据转作成本守卫参照（§9）；缓存计费一等公民化 |
