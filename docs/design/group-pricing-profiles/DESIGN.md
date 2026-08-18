# 分组定价档案设计

## 领域边界

系统拆成三条互不反向驱动的数据链：

1. 模型目录：模型身份、供应商、分类和能力。
2. 售卖定价：定价档案、listing 选择、分组折扣、不可变价格快照和客户扣费。
3. 上游成本：New API 价格参照、分组倍率和成本变化报告。

上游成本允许与售卖价采用不同计费方式。成本同步不写定价档案、不写 listing 售卖状态，
也不参与发布就绪判断。

## 数据模型

### `catalog_model_pricing_profile`

模型级可复用售卖配置：

- `model_id`：所属模型。
- `name`：同一模型内唯一的档案名称。
- `pricing_basis`：`token | unit | duration`。
- `quantity_meter`：
  - Token 档案为空；
  - 图片按次为 `output_count`；
  - 音频/视频按次可为 `request_count` 或 `output_count`；
  - 按时长为 `audio_duration_ms` 或 `video_duration_ms`。
- `sku_rule_source`：管理员输入的规则源码。
- `sku_rule_ast_json`：保存时编译的 AST。
- `compiler_version`、`rule_hash`：保证快照可追踪、规则变化可检测。
- `long_context_threshold_tokens`：Token 档案可选的长上下文阈值。
- `reviewed_by`、`reviewed_at`：人工确认的售卖配置证据。

### `catalog_model_pricing_rate`

一个档案包含多条费率：

- `meter_key`：Token meter 或档案的数量 meter。
- `sku_key`：Token 费率使用 `default`；按次/按时长使用实际 SKU。
- `unit_size`：Token 为 `1_000_000`，按次为 `1`，按时长为 `1_000`
  （价格单位是每秒，数量单位是毫秒）。
- `price_micro_usd`：折扣前的整数 micro-USD 单价。
- `(profile_id, meter_key, sku_key)` 唯一。

### `catalog_model_listing`

新增 `pricing_profile_id`。listing 继续拥有：

- 模型与门户分组；
- 独立的 New API 分组映射；
- 售卖状态；
- `discount_rate_bps`；
- 长上下文开关和展示文案。

旧的 listing 价格列仅作为迁移遗留缓存，发布和扣费不再读取。

### 不可变价格快照

`model_price_version.pricing_spec_json` 保存完整折后规格：

```json
{
  "version": 1,
  "basis": "unit",
  "quantityMeter": "output_count",
  "rates": [
    {
      "meterKey": "output_count",
      "skuKey": "default",
      "unitSize": 1,
      "priceMicroUsd": 40000
    }
  ],
  "skuRule": {
    "version": 1,
    "rules": [],
    "fallback": { "type": "sku", "template": "default" }
  }
}
```

快照同时保存档案 ID、规则 hash、长上下文准入阈值和是否开放长上下文。历史请求始终按
自己的快照重算，不读取当前档案或 listing。

## 分类约束

| 模型分类    | Token | 按次 `unit` | 按时长 `duration` |
| ----------- | ----: | ----------: | ----------------: |
| `llm`       |    是 |          否 |                否 |
| `embedding` |    是 |          否 |                否 |
| `image`     |    是 |          是 |                否 |
| `video`     |    是 |          是 |                是 |
| `audio`     |    是 |          是 |                是 |

图片 `unit` 固定使用实际响应 `output_count`，避免请求参数与实际交付不一致。

按时长档案的数据约束和计费器继续保留，但本期不增加音频/视频端点、时长提取器或线上
验收模型。接入首个真实模型时再补充对应端点适配，并以可信内容时长完成端到端验收；
上游处理墙钟时间不得复用为内容时长。

## SKU DSL

规则采用行式受限 DSL：

```text
when quality in ["low", "medium", "high"] && size in ["1024x1024", "1024x1536", "1536x1024"] => "quality=${quality};size=${size}"
when quality is missing => "default"
when quality == "auto" => "default"
when size is missing => "default"
when size == "auto" => "default"
else => reject
```

语义：

- 按顺序匹配第一条 `when`。
- 条件支持 `==`、`!=`、`in`、`is missing`、`is present` 和 `&&`。
- 输出只能是字符串模板或 `reject`。
- 模板只能插值规则中允许的字段。
- 图片当前允许字段为 `quality` 和 `size`；JSON 与 multipart 解析结果统一成 facts。
- 编译器拒绝未知字段、重复 `else`、无 `else`、非法 JSON 字符串、超长程序和过多规则。

DSL 不包含循环、函数调用、算术或动态属性访问，因此保存和运行都可确定性限界。

## 计费算法

运行时只接受已经发布的 `pricing_spec_json`：

- Token：按 meter 找费率；相同 `unit_size` 的分子先求和再向上取整，保持现有 Token
  计费语义。网页搜索等按次 meter 可使用 `unit_size = 1`。
- 按次：`ceil(actual_output_count × price / 1)`。
- 按时长：`ceil(duration_ms × price_per_second / 1000)`。
- 非零成功请求最低扣 `1 micro-USD`。
- 数量、单价和中间值均校验安全整数，金额计算使用 `BigInt`。

SKU DSL 只在准入阶段选择 SKU。结算从响应/usage 读取可信数量，再以价格快照计算金额。

## 异步图片任务

### 公共 API 契约

对任务型图片模型统一使用 APIPool 异步任务，不在一次 HTTP 请求中等待 APIMart 终态：

- `POST /v1/images/generations`：完成准入、锁定路由与价格快照后，内部调用 New API
  `POST /v1/images/async/generations`，返回 `202 Accepted`、APIPool 任务 ID 和
  `Location: /v1/tasks/{task_id}`。
- `GET /v1/tasks/{task_id}`：校验原用户和原 API Key 的所有权后，返回 APIPool 数据库中
  的最新状态。常规轮询不查询 APIMart；后台 worker 按有界退避查询 New API
  `GET /v1/tasks/{newapi_task_id}`，用户不轮询时任务仍会推进和结算。
- `completed` 响应使用 OpenAI 图片结果习惯的 `data[].url`，URL 是 New API 为已托管在
  R2 的产物新签发的链接，并同时返回链接与结果的过期时间。官方组返回规范化 `usage`，
  EXT 组不伪造 token usage。
- APIPool 可以在签名链接接近过期时按需向 New API 刷新；该查询只读取 New API 数据库并
  重新签名 R2 URL，不查询 APIMart，也不重复下载图片。

提交响应示例：

```json
{
  "id": "imgtask_01...",
  "object": "image_generation.task",
  "status": "submitted",
  "model": "gpt-image-2",
  "created_at": 1787068800
}
```

完成响应示例：

```json
{
  "id": "imgtask_01...",
  "object": "image_generation.task",
  "status": "completed",
  "model": "gpt-image-2",
  "data": [
    {
      "url": "https://r2.example/image-tasks/results/task_01.../0.png?...",
      "expires_at": 1787072400
    }
  ],
  "result_expires_at": 1787155200
}
```

APIPool 只暴露自己的任务 ID；New API task ID 和 APIMart task ID 作为内部关联证据，不进入
面向用户的主键空间。

### 状态机

```text
submitted -> processing -> completed
    |             |
    +-------------+-> failed_unbilled
                  +-> meter_pending
```

- `submitted`：New API 已确认接收并返回任务 ID。
- `processing`：APIMart 仍在处理，或 New API 正在把完成产物搬运到 R2。
- `meter_pending`：New API 已交付 R2 产物，但 Token usage 缺失或矛盾，等待补偿或人工处置；
  APIPool 不结算、不把任务标成完成。
- `completed`：New API 已确认全部 R2 产物可用，且 APIPool 客户账本已经按提交时快照完成
  唯一结算。
- `failed_unbilled`：上游失败、终态无图片或 New API 的 R2 搬运经过补偿仍失败；APIPool
  用户不扣费。

提交超时且没有可信 task ID 时保持未知状态，不盲目重提；价格、listing 或渠道的后续变化
不得改变在途任务保存的路由和价格快照。

### 持久化

新增 `gateway_task`，本期只允许 `task_type = image_generation`：

- `id`：对外暴露的高熵 APIPool task ID。
- `request_ledger_id`：唯一关联原请求账本；路由、分组和价格继续以账本快照为准。
- `user_id`、`portal_key_id`：任务查询所有权。
- `status`、`newapi_task_id`、`provider_task_id`、`next_poll_at`、`poll_attempts`、
  `last_error` 和各状态时间戳。
- `terminal_evidence_json`：脱敏后的终态状态、usage、实际图片数和结果保留期，不保存上游
  凭据或 R2 object key。
- `result_cache_json`、`result_url_expires_at`：短时缓存 New API 签名 URL；过期前可直接返回，
  接近过期时向 New API 刷新，不把签名 URL 当永久证据。

`request_ledger` 增加任务关联和异步状态所需索引；已有
`uniq_wallet_ledger_request_charge` 继续作为最多扣一次的最终约束。

### New API 与上游查询

生产 New API `81877e7c` 已经具备 APIMart 图片任务适配：

- 标准 `POST /v1/images/generations` 会内部轮询最多 5 分钟并返回 R2 产物的 base64，兼容
  同步 OpenAI 调用，但会超过 APIPool 默认 3 分钟图片首字节超时，因此本期不使用。
- `POST /v1/images/async/generations` 返回 `202 + task_id`；`GET /v1/tasks/{task_id}` 返回
  持久化状态，并在完成后从 R2 新签发结果 URL。
- New API 后台轮询和 APIMart webhook 都能推进任务；只有结果图片全部写入 R2 后任务才成功。
- New API 已保存终态 usage，但当前统一任务响应没有返回 usage。本期 New API 的必要代码
  改动是把已校验的 usage 加入 `UnifiedTaskResponse`，供 APIPool 官方组准确结算；EXT 根据
  `result.images` 实际数量结算。

APIPool worker 使用串行调度、任务 claim 租约和有界退避，多个实例或重复调度不能并发
结算同一个任务。New API 校验自己的 token / 用户所有权；APIPool 再校验门户用户和 API
Key，形成两层任务隔离。

## R2 结果交付

### 搬运顺序

上游 `completed` 后按以下顺序处理：

1. New API 校验终态、usage 和图片列表，拒绝空结果和超出请求上限的结果。
2. New API 通过已有 SSRF 防护下载结果，以确定性 key 写入 R2，并逐个保存 artifact 证据。
3. 全部对象就绪后，New API 才把任务标记成功；任务查询按需签发 R2 URL。
4. APIPool 读到完成态后，以 `result.images` 数量生成 `output_count`，官方组同时校验 usage。
5. APIPool 在一个数据库事务内写入最终 meter、钱包扣费和 `completed` 状态。

对象存储由 New API 统一托管，APIPool 不再下载和上传第二份结果，避免双份存储、重复 SSRF
面和两套清理生命周期。New API 当前结果保留 24 小时，单次签名 URL 最长 1 小时；APIPool
原样返回 `expires_at` 和 `result_expires_at`，结果保留期内可重新查询刷新链接。

### URL 与安全边界

- New API 异步提交前必须验证 R2 配置；缺配置时在调用 APIMart 前失败，避免已产生成本却
  无法交付。
- 对外只返回按需签发的 R2 URL，不暴露内部 object key，不返回 APIMart 临时 URL。
- New API 已对单图大小、Content-Type、私网/回环/link-local/云元数据地址和重定向实施
  边界检查；本期保持既有有界读取，不在 APIPool 重复实现下载器。
- New API 搬运失败会重试并保持非成功态；超过边界后任务失败并退款。APIPool 映射为
  `failed_unbilled`，不做部分交付或部分计费。

## 图片结算时点

- 官方组：对象全部就绪且终态 usage 合法后，按提交时 Token 价格快照结算。
- Codex 特惠组：New API R2 对象全部就绪后，按 `result.images` 数量和提交时 resolution
  SKU 结算；请求 `n` 只用于准入上限，不是最终数量。
- APIMart official 仅返回未按文本/图片拆分的缓存总数，本期公共零售价不提供缓存 token
  优惠；文本和图片输入都按各自普通输入价结算，不猜测缓存模态分摊。
- New API / APIMart 金额只作为成本参照；APIPool 钱包账本是客户账单唯一事实源。
- APIPool 任务 `completed`、终态证据和钱包扣费在同一数据库事务中落定；重复 worker、
  重复查询或迟到终态不能产生第二笔扣费。

## 发布与失效

发布就绪要求：

- listing 可调用且有 New API 分组映射；
- listing 选择的档案属于同一模型并已人工确认；
- 分类、计费方式、数量 meter、费率和已编译规则全部合法；
- 折扣为合法正 bps；
- 长上下文配置一致。

目录变化后，请求热路径比较当前配置与活动快照；发生变化就退役旧快照并原子发布新版本。
上游成本参照不在比较项中，因此成本同步不会触发售卖快照变化。

## 迁移

新增表和外键后执行一次性转换：

- 每条旧 `catalog_model_price` 生成一个“默认售卖价”档案。
- `token` 宽表字段转换为 meter 费率。
- `per_call` tiers 转换为 `unit` 费率；图片使用 `output_count`，其他分类使用
  `request_count`。
- 旧按次配置编译成与当前 `quality/size` 行为等价的规则。
- 每条 listing 选择所属模型的默认档案。
- 新快照字段为空的旧活动快照会在第一次请求时自动退役并重新发布。

转换后没有双读：售卖代码只认新档案；旧表只供独立成本同步保留。

## 变更记录

- 2026-08-18：根据 Issue #4 的确认，补充 APIPool 异步图片任务、New API 轮询、复用
  New API R2 签名 URL 交付和完成后结算设计；本期不验收按时长真实模型链路。
