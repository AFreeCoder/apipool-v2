# 模型价格配置与调用计费方案（设计）

- 日期：2026-07-18（第 2 轮裁决并入 2026-07-19）
- 状态：评审中（第 1、2 轮裁决已并入正文，评审过程见 [review-log.md](./review-log.md)；第 2 轮源自与 codex 独立方案的双线对比及其反评审）
- 关联调研：[research.md](./research.md)（厂商计费模式事实、newapi/LiteLLM 方案对比）
- 承接遗留：`docs/dev/portal-newapi-routing-billing-decoupling/issues.md` 中"gpt-5.5 三维价格（S2）""OpenAI 长上下文阶梯计费未支持""GPT-5.6 cache write 单一价"三项（前两项本设计直接实现，第三项为承载结构+发布硬门；勾选在实现合入时进行）

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
4. 价格完备性前移到发布门禁（完备集硬门，O10），运行期只做确定性计算；不存在按替代价格结算的路径。
5. 给出首发清单的落地配置示例与迁移顺序。

**非目标（显式 defer，见 §12）**

- 音频、视频模型计费——结构预留（per_call 同构扩展 per_second），不实现。
- 多币种、用户级/时段级折扣、生效时间调度、用量阶梯（volume tier）。
- newapi 同步管线重写——仅做降级改造（§9）。
- 服务模式/地域变体（Batch/Fast/priority/geo）拦截与差异计价——上游成本按 newapi quota 计、不分 tier，无直接资损（O8 裁决）；将来直连官方 API 时重开此题。

（第 2 轮裁决 O9 变更：OpenAI 长上下文阶梯计价从 defer 转为首版实现，见 §5.4。）

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
   model_price_version { billingScheme, ratesJson: {meter→单价, 含 *_long}, tiersJson: {sku→单价}, threshold }
                                    │
 请求 ──► 准入(锁定版本; SKU 判定/272K 拦截) ──► 转发上游 ──► usage 归一化+判档(§7.1/7.2) ──► 计价(§7.3) ──► 结算入账(§7.5)
                                                              meter 数量向量                  Σ qty×rate / sku×n
```

## 5. 计费词表与计费方案

### 5.1 meter 词表（规范键名）

meter 是"一种被计量计价的量"。键名全局唯一、snake_case，与账本/价格/归一化共用同一词表（单一 TS 常量模块导出，作为类型与校验的唯一事实源——实现于 `src/features/gateway/lib/meters.ts`，目录层引用同一模块）。

**首发启用（token 类，量纲 tokens，单价 micro-USD / 1M tokens）：**

| meter 键 | 语义 | 现五桶对应 |
|---|---|---|
| `input` | 非缓存输入（文本） | uncachedInput |
| `cached_input` | 缓存读（文本） | cachedRead |
| `cache_write` | 缓存写·无 TTL 区分（OpenAI GPT-5.6） | 新增 |
| `cache_write_5m` | 缓存写·5 分钟档（Anthropic） | cacheWrite5m |
| `cache_write_1h` | 缓存写·1 小时档（Anthropic） | cacheWrite1h |
| `output` | 输出 | output |
| `image_input` | 图片输入 token | 新增 |
| `cached_image_input` | 图片输入缓存读 | 新增 |
| `image_output` | 图片输出 token | 新增 |

各 meter 的必需性不在词表层承担，统一由发布门禁按模型计费能力声明判定（§7.4）。

**长上下文档（首发启用，O9 裁决）：** 上述文本 meter 各有一个同名 `_long` 后缀变体（`input_long` / `cached_input_long` / `cache_write_long` / `output_long`），承载 OpenAI 1.05M 上下文型号的整请求切档价，详见 §5.4。

**预留命名空间（不实现，仅约定命名规则以防未来冲突）：** `audio_input` / `audio_output`（音频 token）、`duration_seconds`（视频秒数）。

设计规则：

1. meter 之间数量**互斥不重叠**（归一化层负责消化上游"子集语义"，见 §7.1）。
2. `reasoning` tokens 维持现状：只记录不单独计价（包含在 `output` 内）。
3. OpenAI 无 TTL 的缓存写走独立 `cache_write`，不复用 `cache_write_5m`——账本审计语义干净，meter map 下新增键零公式成本；这同时是对 issues"GPT-5.6 cache write 单一价"的承载结构（价格数值仍需生产证据，见 §12）。
4. `_long` 档与普通档整请求互斥（一次请求的全部用量要么全普通、要么全长档），档位选择只发生在归一化层（§5.4/§7.1），计价公式不感知档位。

### 5.2 billing scheme（计费方案）

| scheme | 计费表达 | 适用 | 费用公式 |
|---|---|---|---|
| `token` | `rates: {meter → 单价}` | 文本模型、embeddings（token 制图片模型的结构保留，首发清单暂无） | `ceilDiv(Σ qty_m × rate_m, 1e6)`，min 1 micro-USD |
| `per_call` | `tiers: {skuKey → 单价/次}`，必含 `default` | 按次售卖的图片模型（首发：gpt-image-2，O11 裁决） | `n × tiers[sku]`，min 1 micro-USD |

- 一个模型恰好一种 scheme（沿用 newapi"按次/按量二选一"的经验；同模型分组间不同 scheme 不支持——newapi 同样未支持，见 research §2.1）。
- **门户售价形态不必复刻官方计费制**（O11）：gpt-image-2 官方按 token 计费（research §1.2 事实不变），门户对外按"质量 × 尺寸每张定价"售卖——价格对用户可预测；其 token 用量仍完整入账供成本核算（§7.2）。
- `per_call` 的 `skuKey` 规范：**按参数名字典序**拼接 `k=v` 对，`;` 分隔，如 `quality=high;size=1024x1024`。`default` 的语义是**参数缺省/`auto` 档**：请求未显式指定 SKU 参数（或传 `auto`）时映射到 `default` 行；用户显式传入而价表中不存在的组合在准入时直接拒绝，不回退任何档（§7.2）。缺省/`auto` 到档位的完整映射规则随模型的 SKU 参数白名单一起维护。
- 数量 `n` = 实际生成张数（响应实际，非请求参数，§7.2）。
- 未来视频按秒 = 新 scheme `per_second`，复用 `tiers`（sku=分辨率/档位）+ 数量（秒数），结构零新增——这是 per_call 结构的刻意同构（research §1.4）。

### 5.3 覆盖性自检（首发清单 → 结构）

| 模型 | scheme | 需要的价格数据 |
|---|---|---|
| gpt-5.4 / 5.4-mini / 5.4-nano / gpt-5.5 | token | input, cached_input, output（三维，S2 结论的正式承载）；1.05M 上下文型号另配长档（§5.4） |
| gpt-5.4-pro / 5.5-pro | token | input, output（无缓存价） |
| gpt-5.6-sol / terra / luna | token | input, cached_input, cache_write, output；1.05M 上下文型号另配长档四价（§5.4） |
| claude 全系（fable-5 → haiku-4.5） | token | input, cached_input, cache_write_5m, cache_write_1h, output（当前官方无长上下文溢价，不配长档，§5.4） |
| gpt-image-2 | per_call | tiers: default（缺省/auto 档）+ 各 质量×尺寸（O11 裁决：门户按次售卖；token 用量照记不计费） |
| dall-e-3（同构对照） | per_call | tiers: default + 各 质量×尺寸（与 gpt-image-2 同一结构） |
| text-embedding-3-*（已有类目） | token | input（不再强迫配 output 假价，修复 G6） |

哪些 GPT 型号是 1.05M 上下文窗口（进而需要配长档），发布前按官方模型页逐型号核对，不从家族名推断。

### 5.4 长上下文阶梯计价（整请求切档，O9 裁决首版实现）

**官方事实**（research 及官方定价页）：GPT-5.4/5.5/5.6 三代的 1.05M 上下文型号，当一次请求的**全部输入 token**（未缓存 + 缓存读 + 缓存写之和，即 `inputTotalTokens`）超过 272K 时，**整次请求的所有计费通道**切换为长上下文价——是整请求换价，不是仅对超出部分加价。首发清单中的 Claude 系当前官方 1M 上下文无溢价、Haiku 4.5 为 200K 窗口，均不配长档；运营不得给官方未发布长档价的模型自行配置长档。

**结构承载**（加数据不改公式）：

- 模型级事实（目录价格表，§6.1）：`long_context_threshold_tokens` 阈值列（如 272000，NULL = 该模型无长档）+ 长档价列（`input_long` / `cached_input_long` / `cache_write_long` / `output_long` 对应档，均为官方长档价手填）。配了阈值的模型，其长档价按 §7.4 完备集门禁必须配齐。
- listing 级开关（§6.1）：`allow_long_context`，默认关。粒度 = 分组 × 模型，与折扣同层。

**运行时行为**：

- 开关**关**：转发层对配有阈值的模型做**保守估算**拦截（估算值宁高勿低），估算输入 ≥ 阈值即拒绝并明确报错。若估算漏拦、实际 usage 超阈值：按**普通档**结算（不按用户未被允许使用的长档收费，平台自担差价），`billing_flags` 标记 + 告警，用于校准估算系数。
- 开关**开**：放行，无需估算拦截。归一化层按实际 usage 判档：`inputTotalTokens ≥ 阈值` → 全部用量归入 `*_long` meter，否则归普通 meter。计价查长档单价 × 折扣——**计价方式与官方完全一致，门户与官方的差异只有折扣**。
- 判档口径与官方一致：`inputTotalTokens` = 该请求全部输入（含各类缓存），不是仅未缓存输入。

## 6. 数据模型变更

### 6.1 目录层（人工配置面，最小增量）

`catalog_model_price` 变更：

```sql
ALTER TABLE catalog_model_price ADD COLUMN billing_scheme TEXT NOT NULL DEFAULT 'token';
  -- 'token' | 'per_call'；原 pricing_mode 的 'fixed_price' 语义迁入 per_call，
  -- pricing_mode 保留表达"价格来源形态"（token_ratio/manual_token/...），逐步废弃 fixed_price 值
ALTER TABLE catalog_model_price ADD COLUMN base_cache_write_micro_usd INTEGER;      -- OpenAI 无 TTL 缓存写
ALTER TABLE catalog_model_price ADD COLUMN base_cached_image_input_micro_usd INTEGER; -- 图片缓存读（token 制图片模型预留）
-- 长上下文阶梯（§5.4，O9）：阈值 NULL = 该模型无长档；配了阈值则长档四价受完备集门禁约束
ALTER TABLE catalog_model_price ADD COLUMN long_context_threshold_tokens INTEGER;
ALTER TABLE catalog_model_price ADD COLUMN base_input_long_micro_usd INTEGER;
ALTER TABLE catalog_model_price ADD COLUMN base_cached_input_long_micro_usd INTEGER;
ALTER TABLE catalog_model_price ADD COLUMN base_cache_write_long_micro_usd INTEGER;
ALTER TABLE catalog_model_price ADD COLUMN base_output_long_micro_usd INTEGER;
-- 语义调整（不改列）：全部价格列允许 NULL = "该模型无此计费项"；
-- 必需性不再由列级 notNull 承担，统一交给发布门禁按模型计费能力声明判定（§7.4 完备集硬门）
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
| base_input_long_micro_usd（新） | input_long |
| base_cached_input_long_micro_usd（新） | cached_input_long |
| base_cache_write_long_micro_usd（新） | cache_write_long |
| base_output_long_micro_usd（新） | output_long |

演进预留：长档 4 列使价格列达到 13 个，已触及原"约 12 个再评估"线；评估结论为维持列式——长档列仅 1.05M GPT 型号使用、表单按阈值有无按需展示，不构成通用配置负担。`extra_rates_json` 的评估点顺延至下一模态（音频/视频）进清单时（§3 裁决 4）。

`catalog_model_listing` 变更：

- 定价策略机制整体删除（配合 §8 单一公式，评审裁决 O2）——`pricePolicy` 与 `override*` 系列列随迁移移除（未上线无存量，seed 重建）；`discountRateBps` 保留并真实生效（默认 10000 = 不打折）。
- 新增 `allow_long_context INTEGER NOT NULL DEFAULT 0`（O9）：分组 × 模型粒度的长上下文开关，语义见 §5.4；对无阈值的模型该开关无效果。
- listing 继续承载展示缓存、上架、排序、冒烟标记等售卖属性；不同分组如需差异价，用各自 listing 的折扣字段表达，不引入新机制。

### 6.2 网关层（结算事实源，一次性一般化）

`model_price_version` 破坏性重建（未上线裁决；schema-guard 与相关测试同步更新）：

```sql
-- 删除五个单价列，替换为：
billing_scheme TEXT NOT NULL,               -- 'token' | 'per_call'
rates_json     TEXT NOT NULL DEFAULT '{}',  -- {meter: microUsdPer1M}，仅含已定价 meter（含 *_long 长档键）
tiers_json     TEXT NOT NULL DEFAULT '{}',  -- {skuKey: microUsdPerUnit}，per_call 时必含 default
long_context_threshold_tokens INTEGER,      -- 判档阈值快照；NULL = 本版本不启用长档
-- 保留：newapiRef* 参照列（方向校验）、publishedBy、版本链
CHECK (billing_scheme IN ('token','per_call'))
CHECK (billing_scheme != 'per_call' OR json_extract(tiers_json,'$.default') IS NOT NULL)
-- 门禁保证：threshold 非空时 rates_json 必含四个 *_long 键
```

长上下文开关（listing 级）**编译进版本内容而非另存标志**：`allow_long_context = false` 的 listing 生成的版本不写入阈值与 `*_long` 键——归一化层查不到阈值即永不判长档，漏拦请求自然按普通档结算；开着的版本写入阈值与长档键，判档自动生效。运行期零开关分支，也无结算时读 listing 现值的时序问题。

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
ALTER TABLE request_ledger ADD COLUMN sku_key TEXT;                      -- 命中的 SKU（显式组合或 default 缺省档）
ALTER TABLE request_ledger ADD COLUMN unit_count INTEGER;                -- 实际张数/次数
-- 长上下文档标志（O9）：
ALTER TABLE request_ledger ADD COLUMN long_context_applied INTEGER;      -- 1 = 本请求按长档结算
ALTER TABLE request_ledger ADD COLUMN billing_flags_json TEXT;           -- 仅异常时非空：未知计量项零计、漏拦超阈值等标记
-- 原始 usage 凭证（第 3 轮 N1 裁决）：
ALTER TABLE request_ledger ADD COLUMN raw_usage_json TEXT;               -- 上游返回的原始 usage 原文
```

- 现有五桶列**保留且语义不变**；全部 meter 数量都有专列，报表/对账 SQL 直查（裁决 O3：不走"图片量入 JSON"的方案）。未来新增 meter 时账本同步加列——与目录层同一取舍，频率低、可接受。
- 长档**不加平行数量列**：`*_long` 与普通档整请求互斥（§5.1 规则 4），数量语义相同，复用同名数量列 + `long_context_applied` 标志即可无损表达，报表仍是列式直查（O3 精神不变）。
- `billing_flags_json` 只承载异常标记（§7.4 未知计量项零计、§5.4 漏拦超阈值），不承载数量。
- `billing_scheme = per_call` 的请求：`sku_key`/`unit_count` 承载计费依据，token 数量列**照常写入实际用量**（不参与计费，供成本核算与对账，O11）。
- `raw_usage_json`（N1 裁决：门户自留凭证，不引 newapi 日志作证据——它只是对照参照）：上游返回的原始 usage 原文，仅作审计凭证——争议时可复核"上游当时返回了什么"及归一化推导链。不参与计费与查询，与 O3 不冲突（O3 约束的是用量**数量**的查询形态，凭证是证据不是查询字段）；usage 对象只含计量数字与字段名、无用户内容，无脱敏负担。pending 补差的请求此列存 newapi 日志记录原文，配合粒度降级标记（§7.5）。
- 单价快照依旧通过 `priceVersionId` 指向不可变版本，不在账本重复存 rates。

## 7. 计费流水线

### 7.1 usage 归一化（meter 数量向量）

`normalizeUsage` 的返回从五字段结构改为 `Record<MeterKey, bigint>`（仅含非零项）+ 元信息。`unmappedNonZero`（未知非零计量字段）从现状"仅日志告警"升级为：**零计费 + 账本 `billing_flags` 标记 + 强告警**（O10 兜底：宁少收平台自担，绝不按替代价收费；管理员补配后新请求正确计费，历史不追收）。各 endpoint 适配器：

| endpoint | 取数规则（沿用现状，新增图片） |
|---|---|
| chat_completions | `cached_input = prompt_tokens_details.cached_tokens`；`cache_write = cache_creation_tokens ?? cache_creation_input_tokens`；`input = max(0, prompt_tokens − cached_input − cache_write)`（OpenAI 子集语义做减法）；`output = completion_tokens` |
| responses | 同上，字段取自 `input_tokens_details.*`（cache_write_tokens） |
| messages（Anthropic） | `input = input_tokens`（互斥语义不减）；`cached_input = cache_read_input_tokens`；`cache_write_5m/1h = cache_creation.ephemeral_*_input_tokens`（缺细分时汇总额入 5m）。**新增等式校验**（第 3 轮 R9，现状无）：聚合字段与细分同时存在时校验 `cache_creation_input_tokens = 5m + 1h`，不等则按细分结算 + `billing_flags` 标记 + 告警——可抓住"5m 在、1h 字段缺失"类漏计 |
| embeddings | `input = prompt_tokens` |
| **images（新增）** | `input = input_tokens_details.text_tokens`；`image_input = input_tokens_details.image_tokens`；`image_output = output_tokens`；缓存细分字段（若上游提供）映射到 `cached_input`/`cached_image_input`，未提供细分时缓存量计 0 并进对账观察（调研未取到 gpt-image-2 缓存 usage 字段样例，适配器留口）。**gpt-image-2 为 per_call：以上 token 归一化照常执行但只入账不计费**（O11，成本核算用） |

关键规范：归一化输出的 meter 数量**互斥不重叠**；"OpenAI cached 是输入子集、Anthropic 各桶互斥"的语义差异只允许在适配器内消化（research §1.5），计价公式不感知来源。

**长档判定（O9，归一化的最后一步）**：价格版本含 `long_context_threshold_tokens` 且 `inputTotalTokens`（= input + cached_input + cache_write* 之和，口径见 §5.4）≥ 阈值时，把全部 meter 键改写为对应 `*_long` 键；否则保持普通键。计价层只按键查 `rates_json`，不感知档位逻辑。

**server-side tools 与结构化未知项防御（第 3 轮 R10，三处现状缺口的修补）**：

1. **请求侧拦截**：首版不开放会产生独立计费的 server-side tools（Anthropic `web_search` 等按次收费工具）。转发层检查 `tools` 数组，含 server-side 工具类型即拒绝（4xx 明示未开放）；客户端 function calling（普通 tool use，无独立计费）放行。不拦截 = 放任一个未定价计费项被触发（工具费成本经渠道传导、门户收入侧为零），与 O10 完备性原则直接冲突。
2. **检测升级**：现状 `unmappedNonZero` 只检测**顶层数值**字段——`iterations[]`（数组）、`server_tool_use`（对象）会静默逃逸，且 `server_tool_use` 在已知字段白名单中但无任何桶映射（次数被静默忽略）。升级为：未知的**对象/数组结构**、以及白名单内但无 meter 映射的非零字段，一律触发 O10 兜底（零计 + `billing_flags` 标记 + 强告警）。
3. 拦截与检测双层并存：拦截防正门，检测防"上游行为变化/拦截遗漏"的旁路。

流式提取（sse-parser）不变；images 端点非流式，但**不走现有整体缓冲的 `extractBodyUsage` 路径**——响应含 base64 图片数据，受 32 MiB 解析缓冲上限约束，接入约束见 §7.6。

### 7.2 per_call 的量与 SKU 判定（准入 fail-closed，O11）

按次计费的单价在**请求转发前完全确定**，这是 per_call 的结构优势——预估即精确价，无 usage 依赖：

- **SKU 判定前移到准入**：从请求体参数派生 SKU（图片：`quality`、`size`；参数名白名单按模型能力配置，默认取这两个），按 §5.2 规范拼 key 查 `tiers`：
  - 参数缺省或 `auto` → 命中 `default` 档（映射规则随白名单维护）；
  - 用户显式传入而价表中不存在的组合 → **准入直接拒绝**（4xx，明示"该质量/尺寸组合未开放"），不回退任何档、不产生上游成本——与 O10"绝不按不确定价格收费"同一原则。
- **量 n = 响应实际张数**（`data.length`；部分成功按实际成功数收）。响应无法解析出张数时**不得用请求参数 `n` 猜测**：无法确认向用户交付即走失败路径复核，不扣费。
- 按次模型请求失败（上游 4xx/5xx 无产出）沿用现状失败路径（`failed_unbilled`），不扣费。
- 结算写入：`sku_key`（实际命中档）、`unit_count`（实际张数）；token 用量照记不计费（§6.3）。

### 7.3 计价（唯一舍入点，公式一般化）

```ts
// scheme = token：qty、rate 均 BigInt；rates 仅含已定价 meter
total = Σ_m qty[m] × rates[m]          // 键必在 rates 中（§7.4 完备集门禁保证）；无价的未知键零计 + 标记，不参与求和
charged = max(ceilDiv(total, 1_000_000n), 1n)

// scheme = per_call：单价已是 micro-USD/次，整数直乘，无除法舍入
charged = max(BigInt(n) × tierPrice, 1n)
```

不变式沿用：全程 BigInt、无中间舍入、不跨请求携带余数。`computeChargeMicroUsd` 是仍然唯一的舍入位置。

### 7.4 价格完备性：完备集发布硬门 + 未知项零计标记（O10 重写）

第 2 轮裁决 O10：**在发布时就把每个模型的计价彻底搞清楚**，运行期不存在按替代价格结算的路径——收错钱引发的争议、事后核算与退款成本，高于任何回退机制省下的配置工夫。

**发布门禁 = 完备集硬门（快照桥，配置期 fail-closed）**：

- 判定基准是**模型计费能力声明**（人工维护的模型级事实：有无缓存读/写、写入是否分 TTL、有无长档等；newapi 同步的 `cache_ratio`/`create_cache_ratio` 等仅作预填提示信号，不是判定源）。
- 能力声明所列的每个计费项**必须显式配价**，任何一项缺失即拒绝发布，错误信息指明缺哪个 meter——GPT-5.6 漏配 `cache_write` 是发布失败，不是告警。能力声明无此项 → 对应列留空合法（"无此计费项"，如 gpt-5.4-pro 无缓存价）。
- scheme/endpoint 基础必需集兜底：token 类要求 `input`（及按 endpoint 的 `output`/`image_*`）；per_call 类要求 `tiers.default`；配有长档阈值的模型要求长档四价齐全（§5.4）。
- 第 1 轮的"发布期告警（不阻断）"层取消，其防混淆职责由能力声明承担。

**运行期无回退**（第 1 轮"运行期保守回退"机制删除）：完备集门禁下，已知计费项必有精确价。运行期仍出现无价非零计量的场景只剩上游给存量端点追加 usage 字段一类（有先例：`prompt_tokens_details`、`cache_creation` 5m/1h 细分都是后加的），兜底为：该部分**零计费 + 账本 `billing_flags` 标记 + 强告警**——宁少收平台自担，绝不按替代价格向用户收费。管理员补配能力声明与价格后新请求正确计费，历史不追收。

这组规则替代现状"五维全量必填正整数"（修复 G6：embeddings 不再配 output 假价；gpt-5.4-pro 不配 cached_input 是合法明确的"无此计费项"）。

### 7.5 结算入账

结算事务结构不变（账本行终态 + 钱包流水 + 余额回填 + 透支冻结）。新增写入：`billing_scheme`、各新增 meter 数量列、`sku_key`、`unit_count`、`long_context_applied`、异常时 `billing_flags_json`；既有五桶列继续按同名 meter 写入（长档请求写同名数量列 + 标志位，§6.3）。`newapiQuota` 等对账参照列不变。

**usage 缺失路径（第 3 轮 R23 显式化，机制沿用现状）**：响应完整但无可靠 usage 时进 `pending`，由 newapi 日志（`usage_log_snapshot`）补差结算——meter 化后补差同样走归一化。已知局限：日志粒度粗于响应 usage（只有 input/output 总量，无缓存细分），补差结算等于按全价 input 收费（用户失去缓存折扣）；按 O10"不收错"方向，补差结算的请求必须打 `billing_flags` 标记（粒度降级可追溯）。per_call 模型无此问题（张数可数，计费不依赖 usage）。

### 7.6 images 端点接入约束（首发含 gpt-image-2 的必要成本）

网关现只开放 chat/responses/messages/embeddings/models，images 是全新端点。以下四条是设计约束，机制细节归 plan：

1. **端点注册**：在网关端点注册表为 `images/generations`、`images/edits` 声明请求格式（JSON / `multipart/form-data`）、模型与 SKU 参数的提取方式、响应 usage 与张数的提取位置、非流式模式。缺注册则请求不可达或不可结算。
2. **multipart 白名单提取**（edits）：只解析 `model`、SKU 参数（`quality`/`size`）、`n` 等白名单文本字段且内存有界；图片文件部分流式透传，不整体读入内存、不进日志。SKU 参数在 per_call 下**直接决定计费档位**（O11），提取错误即计费错误，需 fixture 覆盖。
3. **跳过媒体正文的响应解析**：现有非流式 usage 提取整体缓冲响应、上限 32 MiB（`GATEWAY_PARSE_BUFFER_MAX`），base64 图片响应可能超限导致"图已交付、无法结算"。解析必须跳过 `b64_json` 大块内容，只提取顶层 usage、张数（`data.length`）与必要元数据；若上游支持 URL 返回格式可配置优先，但不得作为唯一依赖。
4. **张数以响应实际为准**：`unit_count` 取实际返回；部分成功按实际；解析不出张数走失败复核路径（§7.2）。
5. **newapi 透传实测（第 3 轮 R-门槛）**：以上四条全部建立在 newapi 能正确透传 images 端点的前提上，该前提必须实测——JSON 生成、multipart 编辑、长耗时请求（上游 issue #4478 记录过长请求被切断、流式未按 Images SSE 处理的缺陷）三个场景真实跑通，且本地部署的 newapi 版本需确认含 gpt-image-2 支持（上游 issue #4480 为其支持路径）。

五条未齐前，gpt-image-2 不得标记为可调用。

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

1. **成本参照采集**：定期拉取 `/api/pricing` 快照（沿用现有 client/fixture 体系），按可比子集换算成本参照价：`成本(meter) = ratio 系推导价 × 该分组 group_ratio`（推导规则沿用现状：`model_ratio × $2/1M`、`completion_ratio`、`cache_ratio`；`quota_type=1` 对 default tier）。newapi 表达不了的 meter（OpenAI 无 TTL 缓存写、图片输入缓存、长档价）**不参与对比**——字段不匹配的兼容问题自然消解。gpt-image-2 在 newapi 侧将同步配置为按次（`quota_type=1`，O11 确认），其 `model_price × group_ratio` 与门户 `default` tier 直接可比；非 default 的 SKU 档位 newapi 单价制表达不了，不参与自动对比，毛利由人工核价保障（官方每图成本估算做参考，§10 示例）。
2. **倒挂与变动告警**：逐「模型 × 分组」比较 有效卖价（§8）vs 成本参照，卖价低于成本 → 倒挂告警；成本参照较上次快照变动 → 调价提醒。只告警，不改数。现有 `driftStatus`/告警管道复用，语义从"漂移检测"转为"成本守卫"。
3. **录入辅助（预填）**：管理台价格表单提供"按 newapi 参照价预填"按钮，换算值填入表单、人工确认才保存——同步进程不落库，预填只是打字的替代。首次建库可用现有 `backfill-catalog-pricing.ts` 一次性生成草稿，人工复核后定稿。

配套简化：`catalog_model_price.syncStatus` 语义收敛（价格一律 `manual`，参照数据新鲜度另行标记）；`source*` 参照列保留用于对比展示；`model_price_version.newapiRef*` 列保留（发布方向校验与成本守卫共用）。

**callable 判定重定义（第 2 轮反评审发现，实施阻断级）**：现状 `isCatalogRouteReady`（`src/features/api-catalog/server/queries.ts`）要求 `priceDriftStatus === 'matched'`、`groupPricingSyncStatus === 'synced'`、`groupRatioBps > 0` 三个 newapi 同步硬门同时成立。O1 手填定价后门户价是售价、newapi 参照是成本价，漂移状态几乎必然不再 matched——**不删这三个门，手填价格发布后所有模型直接不可调用**。新条件集：

- 售卖状态可调用（`catalogStatus.isCallable`）；
- 路由分组映射非空（`newapiGroup`，路由仍需要）；
- 发布门禁通过（§7.4 完备集，取代原五维价格非空检查）；价格复核状态收敛为 `manual` + 已复核（`reviewedAt` 非空）。

删除：`priceDriftStatus`/`groupPricingSyncStatus`/`groupRatioBps` 三门（成本守卫输入的缺失或漂移只产生告警，不得阻断调用）；`pricePolicy === 'inherit_group'` 门随 O2 删列自然消失。

## 10. 首发清单落地示例

（基准价为 2026-07-18 官方价，见 research；micro-USD/1M。示例含九折 `discountRateBps=9000` 演示值；分组不参与卖价，见 §8。）

**gpt-5.6-sol（token，四维 + 长档，1.05M 型号）**

```
目录: base_input=5_000_000  base_cached_input=500_000  base_cache_write=6_250_000  base_output=30_000_000
      long_context_threshold_tokens=272_000（官方长档价，§5.4）:
      base_input_long=10_000_000  base_cached_input_long=1_000_000
      base_cache_write_long=12_500_000  base_output_long=45_000_000
快照(九折, listing 开长上下文): rates_json = {"input":4500000,"cached_input":450000,"cache_write":5625000,
      "output":27000000,"input_long":9000000,"cached_input_long":900000,"cache_write_long":11250000,
      "output_long":40500000}，long_context_threshold_tokens=272000
快照(同折扣, listing 关长上下文): rates_json 只含普通四键、无阈值——超阈值请求在转发层被估算拦截
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

**gpt-image-2（per_call 按次售卖，O11；官方按 token 计费的事实不变，门户按张定价）**

```
tiers（演示值）: default=15_000（缺省/auto 档）
               quality=medium;size=1024x1024 → 80_000
               quality=high;size=1024x1024   → 300_000
定价参考: 官方每图成本估算 low≈$0.006 / medium≈$0.053 / high≈$0.211（1024²，research §1.2）；
         按次定价含毛利并吸收同档位内的 token 用量方差，建议按高分位成本留毛利
请求 quality=high, size=1024x1024, n=3, 实际成功 2 张 → charged = 2 × 300_000 = 600_000 micro-USD = $0.60
请求 quality=ultra（价表无此档）→ 准入拒绝，不转发（§7.2）
token 用量（input/image_input/image_output）照常入账本，不参与计费（成本核算用）
```

**dall-e-3（per_call + 阶梯，对照样例）**

```
tiers: default=40_000 ；quality=hd;size=1024x1024 → 80_000 ；quality=hd;size=1792x1024 → 120_000
请求 quality=hd,size=1024x1024,n=2 → charged = 2 × 80_000 = 160_000 micro-USD = $0.16
```

## 11. 迁移与实施顺序

**迁移约束（第 2 轮 O7 定稿）**：未上线阶段允许对 `model_price_version` 破坏性重建（存量为 Stripe 沙盒数据）。执行规则：

- 实施时列出"清理/迁移哪些表"的清单（价格版本、请求账本清理或等价迁移；`wallet_ledger` 是否保留一并列明），**经人工确认后执行**；清空是显式批准的独立操作，不得作为迁移脚本的自动 fallback 分支。
- 迁移在停写窗口内执行（窗口内无 open 请求）；执行前备份 + 恢复验证，执行后 SQLite 完整性检查；失败回滚到备份。

每步以现有测试缝为锚（tests/gateway/*、tests/api-catalog/*、tests/db/*）：

1. **词表与类型**：`meters.ts` 常量模块（含 `*_long` 键）+ scheme 类型；schema-guard 测试更新预告。
2. **网关引擎一般化**（tests 先行）：`normalizeUsage` 输出 meter 向量（五桶键名映射）+ 长档判定 + 缓存写等式校验 + 结构化未知项检测升级（§7.1）、`computeChargeMicroUsd` 按 map 遍历 + per_call 分支；`billing.test.ts` 重写为向量断言，新增 images/per_call/272K 边界（含 272000/272001）/聚合不等式/iterations 结构逃逸用例。
3. **网关 schema**：`model_price_version` 重建（rates/tiers/billing_scheme/threshold），`request_ledger` 增列（含 `long_context_applied`）；迁移 0013+。
4. **目录 schema**：增 7 列（2 计费档 + 阈值 + 4 长档）+ tier 表 + listing `allow_long_context` + NULL 语义放开；fixed_price 迁移到 default tier；`catalog-pricing-migration.test.ts` 扩展。
5. **快照桥改造**：折算全 meter + tiers + 长档（基准 × 折扣单一公式；开关编译进版本，§6.2）、完备集发布硬门（§7.4）、策略字段移除；`catalog-route-snapshot` 测试补门禁/折扣/长档矩阵。
6. **images 端点接入**（§7.6 四项约束）：端点注册 + multipart 白名单提取 + 跳过 b64 的响应解析 + usage 适配器 + SKU 准入判定 + 结算写新列；`handler/integration` 用例补 gpt-image-2、dall-e-3 fixture（tests/fixtures/newapi/ 增补）。
7. **同步降级为成本守卫 + callable 重定义**（§9）：停写价格、可比子集成本换算（含按次 default 档）、倒挂/变动告警、预填接口；`isCatalogRouteReady` 删三硬门。
8. **转发层准入**：272K 保守估算拦截（listing 开关关时）+ per_call 未知 SKU 拒绝 + server-side tools 拦截（§7.1）。
9. **管理 UI**：价格表单补计费档与长档列（按阈值有无展示）、listing 长上下文开关、tier 编辑、四数展示（基准/折扣/最终价/成本参照）、预填按钮、门禁错误提示。
10. **对账与冒烟**：reconcile 覆盖 `billing_flags` 统计（未知计量零计、漏拦超阈值）；dev smoke 增图片模型一跑；272K 实际切档一跑（开着开关的分组）。

依赖关系：1→2→3 严格串行；4/5 可与 2/3 并行开发但发布门禁依赖 3；6/8 依赖 2+3+5。

## 12. 已知局限与 defer 清单

| 项 | 处理 | 回链 |
|---|---|---|
| GPT-5.6 缓存写成本侧无 newapi 参照（`create_cache_ratio` 生产未返回） | 完备集硬门下卖价必手填、漏配即发布失败；成本守卫对 `cache_write` 仍是盲区，倒挂监控不覆盖该 meter | issues.md 行 26，实现合入时勾选升级 |
| GPT-5.6 `cache_write` 字段可得性未证实（第 3 轮 R1）：官方 Responses API 参考页未列该字段；取不到时写入量混入 input 按 input 价收（低收 20%） | 上线门槛：每个开放的模型 × 端点组合，能力声明的缓存写字段须经真实非零 smoke 证明可得；取不到的组合暂缓开放，或显式按"无独立写入价"定价并接受成本差 | §7.1、§11 步骤 10 |
| OpenAI 长上下文阶梯 | **第 2 轮 O9 裁决转为首版实现**（§5.4，整请求切档 + listing 开关）；1.05M 型号清单与长档价发布前逐型号按官方页核对 | issues.md 行 25，实现合入时勾选 |
| 272K 保守估算系数 | 关开关分组的拦截靠估算，低估即漏拦（按普通档结算 + 标记，平台自担差价）；靠 `billing_flags` 漏拦统计持续校准系数 | §5.4 |
| gpt-image-2 缓存 usage 字段形态未证实 | 按次售卖（O11）后不影响计费，仅影响成本核算精度；适配器留口 + 观察 | §7.1 |
| per_call 非 default 档无自动成本参照 | newapi 单价制表达不了 SKU 阶梯，倒挂监控只覆盖 default 档；其余档位毛利靠人工核价（官方每图成本估算参考） | §9、§10 |
| 服务模式/地域变体（service_tier/Fast/Batch/geo） | 不拦截不差价（O8：上游成本按 newapi quota 计、不分 tier，无直接资损）；**将来直连官方 API 时重开** | §2 非目标 |
| 供应商模型漂移防护（requested/expected/resolved 分层记录、rolling ID 策略） | defer（自营 newapi 渠道阶段暴露度低）；直连或多渠道时重评 | codex 案 §6.1 可作输入 |
| Claude 缓存写聚合缺 TTL 细分时汇总入 5m | 沿用现状（1h 写入按 5m 价低收、平台小损；现代 usage 基本有细分）；对抗评审可重题 | §7.1 |
| Sonnet 5 促销价 2026-09-01 到期 | 人工改价发新版本（O4）；8 月底设运营提醒，按自选时刻执行（官方未明时区） | research §1.3 |
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

第 2 轮评审（2026-07-18/19，用户；源自与 codex 独立方案的双线对比及其反评审）裁决已并入正文，往返过程见 [review-log.md](./review-log.md)：

- **O6** → 双线对比总裁决：本方案为唯一实施底座；codex 案不合入主线，其价值以修订输入与对抗评审题库吸收。
- **O7** → 迁移定稿：破坏性重建 + 清理/迁移清单人工确认制；清空是显式批准的独立操作（§11）。
- **O8** → 服务模式/地域变体不拦截：上游成本按 newapi quota 计、不分 tier，无直接资损；直连官方 API 时重开（§2、§12）。
- **O9** → 长上下文阶梯从 defer 转为首版实现：整请求切档、`*_long` 平行 meter 承载、listing 级开关，开 = 计价与官方完全一致、差异只有折扣（§5.4）。
- **O10** → 计价完备性：完备集发布硬门 + 删除运行期回退；未知计量项零计费 + 账本标记 + 告警，绝不按替代价收费（§7.4 重写）。
- **O11** → gpt-image-2 门户按次售卖（newapi 侧同步配按次）；per_call 首发启用，SKU 准入 fail-closed、数量按响应实际、token 照记不计费（§5.2、§7.2、§7.6）。
- 反评审补充 → callable 判定删 newapi 三硬门（实施阻断级发现，§9）。

## 14. 需求映射自查

| 需求 | 方案落点 |
|---|---|
| 未上线阶段、方案简单 | 目录层 +7 列 +1 表 + listing 开关，表单结构照旧；无长档的文本模型配置零变化；破坏性迁移一次到位不留双轨（清单确认制，§11） |
| 首发清单全覆盖 | §5.3 逐模型自检通过（含 gpt-image-2 按次 + token 照记、GPT 1.05M 型号长档、Claude 双 TTL 缓存写） |
| 扩展性 | 加计费项=加 meter 键（网关零公式改动，长档即为实例：`*_long` 键 + 归一化一处判定）；加计费方式=新 scheme 复用 tiers 结构（per_second 同构）；音频命名空间预留 |
| 参考 newapi | 保留按次/按量二选一经验；吸取倍率制教训改为绝对单价 + 四数展示；其价格数据转作成本守卫参照、callable 与其同步状态彻底解耦（§9）；缓存计费一等公民化 |
