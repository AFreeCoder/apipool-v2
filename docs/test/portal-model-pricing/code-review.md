# 门户模型定价与调用计费代码评审报告

- 日期：2026-07-21
- 评审对象：分支 `codex/portal-model-pricing-implementation`（merge-base `2be5e92`，测试基线 `96b2add`）
- 关联：本目录 UAT 报告 [`report.md`](report.md)；闭环清单见 [`issues.md`](issues.md)；三轮对抗评审过程见 [`review-log.md`](review-log.md)
- 二次核验（2026-07-21）：本文的撤销与拆分结论已由第 3 轮逐条按 DESIGN/PLAN 原文核实成立；修复经逐项读码核验，门禁独立复跑通过（tsc ✅、tests 811 pass / 0 fail / 1 skip）

## 结论

评审基线**不建议发布**。主要阻断是后台定价配置无法正常保存、New API 运行凭证缺少与门户钱包解耦的内部运行池，以及若干会造成漏收或审计失真的计费边界问题。后续修复状态以 [`retest-report.md`](retest-report.md) 为准。

本报告已按源码、既定设计和定向测试重新校准：删除与设计一致的误报，拆开此前被错误归为同一根因的图片解析、成本参照和 token 对账问题。本文只记录现象、失败场景与结论；修复过程归 dev 阶段。

## 一、发布阻断与资金风险

### 1. 后台模型与分组折扣保存触发 Server Action 序列化错误

- 现象：模型编辑与 listing 编辑提交均报 `Functions cannot be passed directly to Client Components`，运营无法通过正常界面保存基准价、折扣与发布配置。
- 静态状态：传入的函数均声明为 server action，未发现显式普通函数跨边界；inline action 闭包和 `submit.handler` 嵌套结构只是候选原因，不能作为已确认根因。
- 状态：CONFIRMED（浏览器运行时复现；根因待定位）。

### 2. 运行凭证缺少与门户钱包解耦的内部运行池

- 现象：门户本地钱包有余额的新注册用户，首次真实请求仍被 New API 以用户额度不足拒绝。
- 边界：APIPool 调额按既定架构只写本地钱包，**不得**恢复为同步 New API quota；当前运行 token 已设置 `unlimited_quota=true`，但该设置不能绕过 New API 对用户 quota 的独立检查。
- 正确问题定义：New API 本身会检查用户 quota，既定阶段二需求要求用“大额内部运行池 + 定期人工补充”承接该门禁，而不是宣称运行配置完全不依赖 quota。修复必须保持门户钱包为唯一余额事实源。
- 状态：CONFIRMED（UAT 复现；方案已由既定需求唯一确定，后续实现见复测报告）。

### 3. per_call 图片的长 URL 可能导致张数解析失败并免单

- `scanImageDataItems` 用默认 `maxBytes=128` 读取 `data[].url`；真实签名 URL 可能超过该上限，使 `unitCount` 缺失，图片已交付但进入 `unit_count_missing` 不扣费。
- `b64_json` **不受此缺陷影响**：图片提取器会在进入结构扫描前跳过 b64 正文；现有测试覆盖 10,000 字节 b64 且可结算。
- 状态：CONFIRMED（仅长 URL 路径）。

### 4. 0 价 tier 在应用、数据库、发布门禁和结算间不一致

- `catalog-service` 与 `publish-readiness` 允许 0；数据库 `CHECK(price_micro_usd > 0)` 和 settlement 要求正数。
- 小额价格乘低折扣经 round-half-up 也可能变成 0。结果可能是保存 500，或发布后结算失败并最终免单。
- 状态：CONFIRMED。

## 二、已确认的功能与审计缺陷

### 5. token 成本参照未固化到不可变价格版本

- `catalog-route-snapshot` 不再写 `modelPriceVersion.newapiRef*` 五列，而 token 对账仍读取这些列；相应 meter 非零时外部金额比较退化为 `ref_missing:*`。
- 不能恢复旧实现中“把门户售价写成成本参照”的错误语义；应从目录 `source*` 成本参照按分组成本口径固化，或在缺少可信成本证据时明确标记不可比较。
- 状态：CONFIRMED（token 可比子集）。

### 6. per_call 尚无自动成本对账契约

- `referenceExpectedCharge` 对所有 `per_call` 固定返回 `ref_missing:per_call`。这与五个 token `newapiRef*` 列是否写入无关。
- 需要单独定义 default SKU 的自动参照和非 default SKU 的人工/结构化核价策略；在此之前不应把所有成功图片请求制造为无效审核任务。
- 状态：CONFIRMED（设计已有 default 可比方向，但实现未闭环）。

### 7. 图片 `token_mismatch` 与 `ref_missing:per_call` 被错误归因

- reconcile 状态 `token_mismatch` 只由 New API 日志 input/output token 与门户 meter 汇总不一致触发；`ref_missing:per_call` 只是并列 note。
- UAT 两条图片请求应继续核对 token 口径，不能把恢复 token 成本参照列当作修复。
- 状态：CONFIRMED（需按真实日志 fixture 补回归）。

### 8. Embedding 只有输入价时被公共目录隐藏

- `resolveEffectiveCatalogPrice` 同时要求 input/output 非空；Embedding 合法地只有输入价格，因此被整体隐藏。
- 状态：CONFIRMED。

### 9. tier 编辑行 key 包含受控输入值

- `key={`${index}-${tier.skuKey}`}` 会在编辑 SKU 时改变 key、卸载并重建整行，造成输入丢焦点。
- 状态：CONFIRMED。

### 10. reconcile 免单后的第二次更新缺少状态守卫

- `markFailedUnbilled` 后的 telemetry update 只按 id 更新；与响应结算竞态时，可能把已经 settled 的行标为 `waived_by_missing_usage`。
- 金额不会重复扣，但审计和报表口径会被污染。
- 状态：CONFIRMED。

### 11. 用户用量页和账单页仍映射旧数据模型

- 用量页把按模型 token 数写死为 0、Key 写死为 `—`，且表头与数据列错位。
- 账单页把全部钱包流水映射成充值记录，使用扣费列表为空；极小金额显示为 `$-0.00`。
- 文件不在本定价分支原始 diff 内，但属于本次整体 UAT 范围并阻塞完整用户闭环。
- 状态：CONFIRMED。

## 三、需要先补契约或触发证据

### 12. 小数 token 可使 BigInt 转换失败

`num()` 接受非负有限小数，而计费阶段会执行 `BigInt(quantity)`。标准 token 字段应为整数，但网关边界仍应拒绝/标记非法小数，不能让结算异常。状态：PLAUSIBLE，建议防御性修复并补测试。

### 13. OpenAI 端点的 `server_tool_use` 可能产生假 unmapped flag

归一化末尾会读取 `server_tool_use.web_search_requests`，但该字段未列入 chat/responses 的映射集合。需用真实上游 fixture 确认字段出现的端点后修正。状态：PLAUSIBLE。

### 14. Images 请求未显式拒绝流式响应

Images endpoint 声明 JSON 响应，但请求体中的 `stream` 未做显式契约校验。若上游返回 SSE，当前图片张数提取器不会启用。应在转发前拒绝 images `stream:true`，不依赖上游当前是否支持。状态：PLAUSIBLE，建议 fail-closed。

### 15. 公共目录缺少 per_call 分档价格

当前公开 DTO 只承载 token 价格，无法展示已开放图片 SKU。现有 PLAN 的 UI 任务只明确管理端价目表，因此这是 UAT 发现的产品验收缺口，不应伪装成已违反的实现契约；纳入本轮前需把公开 DTO/展示要求明确为下游调整。状态：PRODUCT GAP。

## 四、已撤销的原评审结论

以下行为与 DESIGN/PLAN 明确一致，不再作为缺陷：

- SKU 参数缺省或任一为 `auto` 时走 `default`；首发配置要求 default 按最贵档。
- 售价折算使用 round-half-up。
- `priceMatches` 只比较不可变计费版本字段；`admissionLongContextThreshold` 从当前 publish 判定结果传入请求上下文。
- `discountRateBps` 为空时按 10000（不打折）处理。
- `LONG_METER_MAP` 不把 Anthropic TTL 桶映射到长档；首发模型中 Claude 无长上下文溢价，未来同时具备 TTL 与长档的模型需另行扩展设计。

## 五、UAT 证据边界

- UAT worktree、测试 SHA、手工介入与清理边界可复核。
- 图片短 URL 和 b64 路径通过是真实结果，但未覆盖长签名 URL，属于覆盖不完整，不称“假通过”。
- 发布复测需要附脱敏的请求/账本关联标识、复现命令及关键日志或截图；不得保留或提交凭据、用户身份、订单或原始敏感日志。
