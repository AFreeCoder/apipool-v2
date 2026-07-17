# OpenAI 计价维度调整记录

## 背景

2026-07-16 重新只读核对生产 New API `GET /api/pricing`、对应生产提交的结算源码和 OpenAI 官方模型页。该核对推翻了原实现“所有模型发布时统一要求五维正价格”和“路由发布依赖 `contextWindow/maxOutputTokens` 计算最坏成本”的假设。

本记录属于开发阶段对冻结设计/计划基线的调整，不回写上游 `DESIGN.md` 或 `PLAN.md`。此前请求失败的 S2 调研记录继续保留原样，作为当时现场证据。

## 已确认事实

- 生产 `/api/pricing` 对 `gpt-5.5` 返回 `model_ratio=2.5`、`completion_ratio=6`、`cache_ratio=0.1`，对应基础文本价格 `$5 / $0.50 / $30`。
- New API token-ratio 主公式按 `modelRatio × groupRatio` 统一缩放，cached input 再乘 `cacheRatio`，output 再乘 `completionRatio`。
- `gpt-5.5` 没有 cache write 价格；Anthropic 的 5m/1h cache write 不能作为 OpenAI 模型的必填维度。
- OpenAI GPT-5.6 使用单一 cache write 价格，不采用 5m/1h 两档。当前生产 `/api/pricing` 尚未返回 `create_cache_ratio`，因此本阶段不从缺省值猜测或自动发布该维度。
- `contextWindow` 是模型能力信息，`max_output_tokens` 等请求参数由调用方按 OpenAI 协议提供；两者都不是路由发布前置输入。

## 本次实现调整

- token-ratio 模型固定要求 input、cached input、output 三维；cache write 仅在同步基准价明确存在时才成为适用维度。
- 不适用的 cache write 价格以 `0` 写入不可空的历史价格版本字段，对应 New API 参照快照写 `NULL`，明确区分“免费”与“不适用”。
- `/api/pricing` 同步解析 `cache_ratio` 和 `create_cache_ratio`；cache read 基准价按 New API 倍率公式生成，两个倍率都进入内容指纹。
- 现有内部 `cacheWrite5m` 桶继续承载非 Anthropic 的单一 cache write usage，避免本次额外数据库迁移；Anthropic 仍保留独立 5m/1h 桶。
- Chat Completions、Responses 和 OpenAI 日志回填都从输入总量中扣除 cached/cache write 子集；Chat 同时识别 OpenAI 原生 `prompt_tokens_details.cache_write_tokens`，与兼容字段取较大值，避免重复计费。Anthropic 日志按 `usage_semantic=anthropic` 保持纯文本输入直映，不执行该扣减。
- 删除路由发布的 `contextWindow/maxOutputTokens` 完整性校验、最坏成本计算及后台展示；不新增这两个后台录入项。

## 未闭环边界

- OpenAI 官方对 GPT-5.5/GPT-5.6 的超长输入存在阶梯倍率，当前生产 `/api/pricing` 未暴露 `billing_mode/billing_expr`。本阶段继续以 New API 当前实际倍率为门户成本参照，不静默发明门户独有阶梯。
- GPT-5.6 在生产 `/api/pricing` 补齐 `create_cache_ratio` 前，不应把三维快照误认为其完整价格。该模型正式发布前必须再次核对接口和一次带 `cache_write_tokens` 的真实 usage/log。
