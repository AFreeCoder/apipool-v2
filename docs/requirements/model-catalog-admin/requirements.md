# 管理后台模型目录优化需求

日期：2026-07-01

## 背景

现有管理后台的模型目录已经具备供应商、分类、能力、状态、分组、模型、售卖项等 CRUD。模型自身只维护模型 ID、展示名称、供应商、分类和上下文窗口；分组、价格、折扣说明等位于模型下的售卖项子页面；能力位于独立的“模型能力”页面。当前录入一个可售模型需要在多个页面间切换，且不能从 New API 自动带出模型 ID 和价格。

## 目标

本次优化聚焦管理后台的模型菜单和模型管理录入体验，让管理员在“新增/编辑模型”时完成核心销售配置：

- 菜单中“分组”和“分类”的顺序对调，分组在分类前。
- 模型管理列表展示模型 ID、展示名称、供应商、分组、分类、能力、价格、折扣等信息。
- 新增/编辑模型时支持：供应商、模型 ID、展示名称、分组、分类、能力、输入 token 价格、输出 token 价格、图片输入 token 价格、图片输出 token 价格、折扣。
- 去掉模型表单中的“上下文窗口”表单项。
- 先选供应商，再输入关键词选择模型 ID；选中模型 ID 后自动填入展示名称和价格。
- 模型 ID 候选和价格来源于 New API 内部服务，由 APIPool server-side API 代理，浏览器不直接调用 New API。
- 分组为单选，分类和能力为多选。
- 折扣设置支持小于 1 折的折扣，并能清楚展示。

## 范围

包含：

- 管理后台 sidebar locale JSON 的菜单顺序调整。
- 管理后台模型列表、模型新增页、模型编辑页。
- APIPool 内部管理 API，用于按供应商和关键词查询 New API 模型候选。
- Catalog 数据结构扩展，以保存图片输入/输出价格和折扣倍率。
- 必要测试、迁移、i18n 文案和文档。

不包含：

- 用户前台 `/models` 展示全面改版。
- 发布、生产数据导入、线上 New API 配置变更。
- New API 上游模型元数据维护功能。
- 多分组售卖策略重构。模型表单只管理一个默认分组对应的 listing；多分组仍可继续使用现有售卖项子页面扩展。

## New API 价格字段调研结论

基于 QuantumNous/new-api 当前源码：

- `GET /api/pricing` 返回模型定价列表、供应商列表、可用分组、分组倍率、支持端点等数据。
- `Pricing` 结构包含 `model_name`、`vendor_id`、`quota_type`、`model_ratio`、`model_price`、`completion_ratio`、`image_ratio`、`audio_ratio`、`enable_groups`、`supported_endpoint_types` 等字段。
- 当 `quota_type = 1` 时，模型使用固定价格 `model_price`，不适合自动拆成输入/输出 token 价。
- 当 `quota_type = 0` 时，`model_ratio` 表示普通输入 token 倍率，`completion_ratio` 表示普通输出 token 倍率。New API 当前前端价格页按 `model_ratio * 2` 换算为美元 / 1M token 基准价，输出价再乘 `completion_ratio`。
- `image_ratio` 是图片输入 token 的独立倍率字段，服务端应用到 `input_tokens_details.image_tokens`。New API 没有独立“图片输出 token”倍率；图片生成 API 返回的 `output_tokens` 走普通 `completion_ratio`，因此本项目首版自动填入的图片输出 token 价格沿用普通输出 token 价格。

参考源码：

- https://github.com/QuantumNous/new-api/blob/main/controller/pricing.go
- https://github.com/QuantumNous/new-api/blob/main/model/pricing.go
- https://github.com/QuantumNous/new-api/blob/main/setting/ratio_setting/model_ratio.go

## 验收标准

- sidebar 中模型目录子菜单顺序为：供应商、分组、分类、能力、状态、模型。
- 新增模型表单顺序为：供应商、模型 ID、展示名称、分组、折扣、分类、能力、价格。
- 模型 ID 支持关键词候选，候选来自 APIPool server-side API 转发的 New API `/api/pricing` 数据。
- 选中候选后展示名称和可推导价格自动填入。
- 分类、能力支持多选；分组为单选。
- 上下文窗口不再出现在新增/编辑模型表单。
- 折扣可输入 0.01 至 10 的折扣倍率，其中 1 表示 1 折，0.5 表示 0.5 折，10 表示原价；列表展示为“0.5 折”这类中文语义和等价百分比。
- 普通输入/输出价格、图片输入/输出价格均可保存；没有图片价格的模型允许对应字段为空。
- 现有公开模型查询和 API Key 创建流程不回归。
