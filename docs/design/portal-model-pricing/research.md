# 模型定价模式调研

- 日期：2026-07-18
- 背景：门户需要独立于 newapi 的模型价格配置与计费方案（见同目录 DESIGN.md）。本文沉淀调研事实：主流厂商的计费模式、代表性网关/代理项目的价格配置方案，以及对本项目设计的启示。
- 范围：首发模型清单相关厂商（OpenAI、Anthropic）+ 图片/视频模型计费模式 + newapi / LiteLLM 两个参考实现。价格均为官方 API 标准档（Standard tier）美元价，采集于 2026-07-18，仅作设计输入，不作为运营定价依据。

## 1. 厂商计费模式盘点

### 1.1 OpenAI 文本模型（GPT-5.4 / 5.5 / 5.6 家族）

单位：USD / 1M tokens。

| 模型 | 输入 | 缓存读 | 缓存写 | 输出 |
|---|---:|---:|---:|---:|
| gpt-5.6-sol | 5.00 | 0.50 | 6.25 | 30.00 |
| gpt-5.6-terra | 2.50 | 0.25 | 3.125 | 15.00 |
| gpt-5.6-luna | 1.00 | 0.10 | 1.25 | 6.00 |
| gpt-5.5 | 5.00 | 0.50 | — | 30.00 |
| gpt-5.5-pro | 30.00 | — | — | 180.00 |
| gpt-5.4 | 2.50 | 0.25 | — | 15.00 |
| gpt-5.4-mini | 0.75 | 0.075 | — | 4.50 |
| gpt-5.4-nano | 0.20 | 0.02 | — | 1.25 |
| gpt-5.4-pro | 30.00 | — | — | 180.00 |

要点：

1. **计费项随代际增加**。GPT-5.4/5.5 只有 输入/缓存读/输出 三项；GPT-5.6 家族新增了独立的**缓存写**计费（1.25× 输入价），向 Anthropic 模式靠拢。同一厂商同一类型（文本）内部，计费项集合就不一致。
2. 缓存读折扣为输入价的 10%；pro 档没有缓存价（不支持缓存折扣）。
3. OpenAI usage 的语义：`prompt_tokens`（chat completions）/ `input_tokens`（responses API）**包含** `*_tokens_details.cached_tokens`，即缓存读 token 是输入 token 的子集，计费时需做减法：`(输入总量 − 缓存读) × 输入价 + 缓存读 × 缓存读价`。GPT-5.6 缓存写的 usage 字段名以实际返回为准（本次调研未取到官方字段样例，网关的 usage 解析层需为新增字段留口）。

### 1.2 OpenAI 图片模型（gpt-image-2）

gpt-image-2 是 **token 计费制**的图片模型，输入侧区分文本 token 与图片 token，价格不同：

| 计费项 | 单价（USD / 1M tokens） |
|---|---:|
| 文本输入 | 5.00 |
| 文本输入（缓存读） | 1.25 |
| 图片输入 | 8.00 |
| 图片输入（缓存读） | 2.00 |
| 图片输出 | 30.00 |

要点：

1. **一次调用最多出现 5 个计费项**，且输入侧同时存在两种 token 类型（文本/图片）。
2. **缓存读折扣比例与文本模型不同**：gpt-image-2 是 25%（1.25/5、2/8），文本模型是 10%。"全局统一缓存倍率"的假设不成立。
3. 每张图的成本由输出 token 数决定，输出 token 数由 质量 × 尺寸 决定。官方参考估算（1024×1024）：low ≈ $0.006、medium ≈ $0.053、high ≈ $0.211 每张。即 token 制模型的"每图价"只是派生估算，计费仍走 token。
4. usage 结构（images API）：`usage.input_tokens`、`usage.output_tokens`、`usage.input_tokens_details: {text_tokens, image_tokens}`。
5. 对照：市面另一类图片模型（DALL·E 3 及多数第三方图模型，如 Flux、豆包生图）是**纯按次计费**，单价由 质量/尺寸/张数 等请求参数决定，通常呈价表（SKU）形式。两种模式会长期并存。

### 1.3 Anthropic Claude 系列

单位：USD / 1M tokens。基础价来自 Anthropic 官方（缓存价按官方规则由基础价推导）。

| 模型 | 输入 | 输出 | 缓存读(0.1×) | 缓存写 5m(1.25×) | 缓存写 1h(2×) |
|---|---:|---:|---:|---:|---:|
| claude-fable-5 | 10.00 | 50.00 | 1.00 | 12.50 | 20.00 |
| claude-opus-4-8 / 4-7 / 4-6 | 5.00 | 25.00 | 0.50 | 6.25 | 10.00 |
| claude-sonnet-5 | 3.00（限时 2.00） | 15.00（限时 10.00） | 0.30 | 3.75 | 6.00 |
| claude-sonnet-4-6 | 3.00 | 15.00 | 0.30 | 3.75 | 6.00 |
| claude-haiku-4-5 | 1.00 | 5.00 | 0.10 | 1.25 | 2.00 |

要点：

1. **缓存写按 TTL 分两档**：5 分钟 1.25×、1 小时 2×。usage 里有对应细分：`cache_creation.ephemeral_5m_input_tokens` / `ephemeral_1h_input_tokens`（汇总字段 `cache_creation_input_tokens`）。
2. **Anthropic usage 的语义与 OpenAI 相反**：`input_tokens` 是**不含**缓存部分的余量，四个 meter（input / cache_creation / cache_read / output）互斥不重叠，直接乘价相加即可。归一化层必须消化"含/不含"这一语义差异，否则要么重复计费要么漏计费。
3. claude-sonnet-5 存在限时促销价（2026-08-31 前 $2/$10）：**价格本身会随时间变**，账本里必须留存计费时刻的单价快照，而不是事后反查元数据。
4. 部分模型/场景存在 >200K 上下文溢价档（LiteLLM 专门有 `*_above_200k_tokens` 字段承接），当前主力 Opus/Fable 已宣布 1M 上下文无溢价。设计上不必现在支持阶梯，但 schema 不应堵死。

### 1.4 视频模型（前瞻，不在首发清单）

代表性定价（2026-07 市面价，仅看模式）：

- Sora 2：$0.10/秒（720p）；Sora 2 Pro：$0.30/秒（720p）→ $0.50/秒（1024p 档）。
- Veo 3.1：Fast $0.15/秒、Standard $0.40/秒、4K 档 ≈ $0.60/秒（含音频）。

模式总结：**按秒计量 × 档位查表**——计量单位是"输出秒数"，单价由请求参数（模型变体/分辨率）决定。结构上与"图片按次 + 阶梯"同构：一个数量 meter，乘以由请求参数决定的档位单价。

### 1.5 各家 usage 返回结构对照（归一化的事实依据）

| 来源 | 字段 | 语义 |
|---|---|---|
| OpenAI chat completions | `usage.prompt_tokens` / `completion_tokens` / `prompt_tokens_details.cached_tokens` | cached 是 prompt 的子集（需减法） |
| OpenAI responses API | `usage.input_tokens` / `output_tokens` / `input_tokens_details.cached_tokens` | 同上 |
| OpenAI images API | `usage.input_tokens` / `output_tokens` / `input_tokens_details.{text_tokens, image_tokens}` | 输入拆文本/图片两种 token |
| Anthropic messages | `usage.input_tokens` / `output_tokens` / `cache_creation_input_tokens` / `cache_read_input_tokens` / `cache_creation.{ephemeral_5m,1h}_input_tokens` | 各 meter 互斥不重叠 |
| 流式 | OpenAI：`stream_options.include_usage` 末尾 chunk；Anthropic：`message_delta` 事件带 usage | 计费须在流结束后 finalize |

## 2. 网关/代理项目的价格配置方案

### 2.1 newapi：倍率制

- 三层倍率：**模型倍率**（ModelRatio，基准 1 = $0.002/1K tokens，即 $2/1M，源自 OpenAI 早期 davinci 定价的历史包袱）、**补全倍率**（CompletionRatio = 输出价/输入价）、**分组倍率**（GroupRatio，按用户分组的乘数）。
- 按量公式：`quota = (输入tokens + 输出tokens × 补全倍率) × 模型倍率 × 分组倍率`；quota 单位 500,000 = $1。
- 按次计费：配置了 `model_price` 的模型走 `固定价 × 分组倍率`，与按量互斥（同一模型二选一；"同一模型按分组配不同计费模式"还是开放的 feature request，issue #4602）。
- 配置形态：三个全局 JSON 大字典（`{"gpt-4o": 1.25, ...}`），价格语义隐藏在换算链里（想知道 gpt-4o 输出价 = 1.25 × 2 × 补全倍率，人工核对成本高，社区里"倍率配错"是高频事故）。
- **缓存计费支持弱**：倍率体系原生只有三层，prompt cache 长期靠"透传/补丁"支持，相关问题频发（缓存未透传导致计费显著偏高 issue #3389、缓存读计费异常 issue #3110、面板 cache token 统计 2025 年才补 issue #5069、"如何支持输入缓存" discussion #2097）。
- 优点：配置极其紧凑；跟 OpenAI 系兼容生态成熟；分组倍率提供了现成的差异化定价层。
- 缺点：$0.002 基准的历史包袱让每个价格都要心算换算；输出价用"比率"表达导致改输入价会连带改输出价；缓存/图片 token/按秒等新 meter 塞不进"输入+输出×比率"的二元公式，每加一种计费项都要动公式而非动数据。

### 2.2 LiteLLM：每计费项绝对单价（业界事实标准）

`model_prices_and_context_window.json` 为每个模型维护一条 JSON 记录，每个计费项一个绝对单价字段（USD/token 或 USD/单位）：

- 文本：`input_cost_per_token`、`output_cost_per_token`
- 缓存：`cache_read_input_token_cost`、`cache_creation_input_token_cost`，以及 TTL/长上下文变体 `cache_creation_input_token_cost_above_1hr`、`*_above_200k_tokens`
- 多模态：`input_cost_per_image`、`output_cost_per_image`、`input_cost_per_audio_token`、`output_cost_per_second` 等
- 元数据同记录承载：`max_tokens`、`max_input_tokens`、`mode`（chat/image_generation/audio_transcription/...）、能力开关

要点：**扩展 = 加可选字段，不动计算公式**；缺失字段视为 0 或继承默认；每条记录自描述、可直接人工审读。该文件被大量下游项目直接引用，是"绝对单价 per meter"路线可行性的最强佐证。

### 2.3 小结对比

| 维度 | newapi 倍率制 | LiteLLM 绝对单价制 |
|---|---|---|
| 可读性 | 差（需心算换算链） | 好（所见即价格） |
| 新 meter 扩展 | 改公式 | 加字段 |
| 缓存计费 | 补丁式，事故多 | 一等公民字段 |
| 按次/按秒 | model_price 单独一套 | mode + per-unit 字段统一承载 |
| 差异化定价 | 分组倍率成熟 | 无内建（网关层自理） |
| 人工配置成本 | 低（一个数字） | 中（多个字段） |

## 3. 对设计的启示

1. **计费项（meter）集合是开放的**：input / output / cache_read / cache_write（还分 TTL）/ input_text / input_image / output_image / duration_seconds……同一厂商代际之间都会增删。方案必须"加数据不改公式"。
2. **缓存折扣比例因模型而异**（10% vs 25%；写 1.25× vs 2×），排除"全局缓存倍率"类设计；缓存价必须落到每个模型自己的价格记录里。
3. **两种计费模式长期并存**：token 计量制（含 gpt-image-2 这种多 meter 图片模型）与 按次/按量单位 × 档位查表制（DALL·E 类、视频按秒）。方案需要显式的计费模式判别，且同构地支持"数量 × 档位单价"。
4. **usage 语义不统一**（OpenAI cached 是子集、Anthropic 各 meter 互斥；图片模型输入拆两种 token），必须有独立的"usage 归一化"层把上游返回翻译成统一的 meter 数量向量，计费公式只面对归一化结果。
5. **价格随时间变**（sonnet-5 促销价、厂商调价），账本必须快照计费时刻的单价与折扣，审计不依赖可变的元数据现值。
6. **业界成熟方向是绝对单价**：LiteLLM 的字段命名可直接借用（降低理解成本、方便未来导入其数据）；newapi 值得保留的是"分组/折扣作为独立乘数层"和"按次计费与按量计费显式二选一"的经验，以及"倍率配错是高频事故"的教训——配置界面要直接展示换算后的美元价。

## 来源

- OpenAI 官方定价页：https://developers.openai.com/api/docs/pricing （GPT-5.4/5.5/5.6 与 gpt-image-2 各档单价）
- gpt-image-2 每图成本估算参考：https://wavespeed.ai/blog/posts/gpt-image-2-pricing-2026/ 、https://unifically.com/blogs/gpt-image-2
- Anthropic 定价：https://platform.claude.com/docs/en/pricing.md （基础价，缓存 0.1×/1.25×/2× 规则；本仓库 claude-api 技能缓存副本 2026-06-24 校对）
- newapi 倍率文档：https://doc.newapi.pro/en/guide/console/settings/rate-settings/
- newapi 缓存计费相关：https://github.com/QuantumNous/new-api/discussions/2097 、issues #3389 / #3110 / #5069 / #4602
- LiteLLM 定价元数据：https://github.com/BerriAI/litellm/blob/main/model_prices_and_context_window.json 、https://docs.litellm.ai/docs/proxy/custom_pricing
- 视频模型定价：https://costgoat.com/pricing/sora 、https://www.veo3gen.app/pricing 、https://costgoat.com/pricing/google-veo
