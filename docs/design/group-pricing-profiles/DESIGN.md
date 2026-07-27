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
