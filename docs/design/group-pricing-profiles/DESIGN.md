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

- `POST /v1/images/generations`：完成准入、锁定路由与价格快照并提交 New API，返回
  `202 Accepted`、APIPool 任务 ID 和 `Location: /v1/tasks/{task_id}`。
- `GET /v1/tasks/{task_id}`：校验原用户和原 API Key 的所有权后，返回 APIPool 数据库中
  的最新状态。该请求不直接查询 New API，避免用户轮询频率放大到上游。
- 后台 worker 按有界退避轮询 New API 任务接口；用户不轮询时，任务仍会推进、搬运、结算
  并收敛到终态。
- `completed` 响应使用 OpenAI 图片结果习惯的 `data[].url`，但 URL 必须属于 APIPool
  对象存储域名；官方组可以同时返回规范化 `usage`，EXT 组不伪造 token usage。

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
      "url": "https://assets.apipool.dev/generated/images/imgtask_01.../0.png"
    }
  ]
}
```

APIPool 只暴露自己的任务 ID；New API task ID 和 APIMart task ID 作为内部关联证据，不进入
面向用户的主键空间。

### 状态机

```text
submitted -> processing -> materializing -> completed
    |             |              |
    +-------------+--------------+-> failed_unbilled
                  +---------------> meter_pending
```

- `submitted`：New API 已确认接收并返回任务 ID。
- `processing`：上游仍在处理。
- `materializing`：上游成功，APIPool 正在校验并搬运图片。
- `meter_pending`：图片已经搬运，但 Token usage 缺失或矛盾，等待补偿或人工处置；不向用户
  暴露最终图片、不结算。
- `completed`：全部图片已可从对象存储读取，且客户账本已经按提交时快照完成唯一结算。
- `failed_unbilled`：上游失败、终态无图片或对象存储经过补偿仍失败；用户不扣费。

提交超时且没有可信 task ID 时保持未知状态，不盲目重提；价格、listing 或渠道的后续变化
不得改变在途任务保存的路由和价格快照。

### 持久化

新增 `gateway_task`，本期只允许 `task_type = image_generation`：

- `id`：对外暴露的高熵 APIPool task ID。
- `request_ledger_id`：唯一关联原请求账本；路由、分组和价格继续以账本快照为准。
- `user_id`、`portal_key_id`：任务查询所有权。
- `status`、`newapi_task_id`、`provider_task_id`、`next_poll_at`、`poll_attempts`、
  `last_error` 和各状态时间戳。
- `terminal_evidence_json`：脱敏后的终态状态、usage 和结果摘要，不保存上游凭据。

新增 `gateway_task_output`：

- `(task_id, output_index)` 唯一，保证重复搬运幂等。
- 保存对象存储 provider、bucket、object key、content type、字节数、搬运状态和错误。
- object key 固定为 `generated/images/{task_id}/{output_index}.{ext}`；重试先查对象是否已存在，
  不重复创建不同对象。

`request_ledger` 增加任务关联和异步状态所需索引；已有
`uniq_wallet_ledger_request_charge` 继续作为最多扣一次的最终约束。

### New API 与上游查询

New API 复用已有 `RelayTask / RelayTaskFetch` 框架增加 APIMart 图片适配：

1. 提交时完成 `gpt-image-2` 到分组对应 provider model 的映射并保存渠道。
2. 查询时始终使用提交时渠道，不重新分配。
3. 把 APIMart `submitted / processing / completed / failed` 和终态 `usage / result.images`
   归一成稳定任务结果。
4. New API 校验自己的 token / 用户所有权；APIPool 再校验门户用户和 API Key，形成两层
   任务隔离。

APIPool worker 是 New API 查询接口的唯一常规调用方。worker 使用串行调度、任务 claim
租约和有界退避，多个实例或重复调度不能并发推进同一个任务终态。

## 对象存储交付

### 搬运顺序

上游 `completed` 后按以下顺序处理：

1. 校验终态、usage 和图片列表，拒绝空结果、重复索引和超出请求上限的结果。
2. 从受信任的 HTTPS 来源流式读取图片，校验每次跳转、Content-Type 和最大字节数。
3. 以确定性 object key 写入 R2，并逐个确认对象可读取。
4. 全部对象就绪后，按实际可交付对象数生成 `output_count`。
5. 在一个数据库事务内写入最终 meter、钱包扣费和 `completed` 状态。

外部对象写入无法与数据库事务原子提交，因此允许出现未被账本引用的孤儿对象，但不能
出现“账本已扣费、对象尚不可读”。确定性 key 和存在性检查保证补偿重试不会重复上传；
孤儿对象后续按独立清理策略处理。

### URL 与安全边界

- 本期使用 Cloudflare R2，要求配置 HTTPS `r2_domain` 作为公开交付域名。R2 S3 API endpoint
  不是用户 URL，未配置公开域名时 listing 不得进入 ready。
- 返回直接对象 URL，object key 含高熵 task ID；不返回 APIMart 的临时 URL。
- 当前 `R2Provider.downloadAndUpload()` 会把整个响应读入内存，不能直接用于 4K 多图任务；
  实现时必须增加有单图和进程级上限的流式搬运路径。
- 远程下载不能接受任意 URL：APIMart 适配首版只允许预期图片域名，并拒绝私网、回环、
  link-local、云元数据地址和越权重定向，防止 SSRF。
- 搬运失败保持 `materializing` 并重试；超过补偿边界进入 `failed_unbilled`，不回退为上游
  临时链接，也不做部分交付或部分计费。

## 图片结算时点

- 官方组：对象全部就绪且终态 usage 合法后，按提交时 Token 价格快照结算。
- Codex 特惠组：对象全部就绪后，按对象数和提交时 resolution SKU 结算；请求 `n` 只用于
  准入上限，不是最终数量。
- APIMart official 仅返回未按文本/图片拆分的缓存总数，本期公共零售价不提供缓存 token
  优惠；文本和图片输入都按各自普通输入价结算，不猜测缓存模态分摊。
- New API / APIMart 金额只作为成本参照；APIPool 钱包账本是客户账单唯一事实源。
- 任务 `completed`、输出 manifest 和钱包扣费在同一数据库事务中落定；重复 worker、重复
  查询或迟到终态不能产生第二笔扣费。

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

- 2026-08-18：根据 Issue #4 的确认，补充 APIPool 异步图片任务、New API 轮询、R2
  搬运、对象存储 URL 交付和完成后结算设计；本期不验收按时长真实模型链路。
