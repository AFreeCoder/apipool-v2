# 管理后台模型目录优化设计

日期：2026-07-01

## 总体方案

保持现有 catalog 分层：`catalog_model` 存模型主数据，`catalog_model_listing` 存分组、状态、价格、折扣、展示说明等销售数据，`catalog_model_capability` 存多能力关联。本次新增轻量的 `catalog_model_category` 多分类关联表，避免分类多选只保存第一个值。管理后台模型表单改为“模型主数据 + 默认 listing + 分类关联 + 能力关联”的组合表单。

这样可以满足单页录入，同时保留现有公开查询、分组映射、API Key 创建和多分组售卖项页面的结构。

## 数据模型

在 `catalog_model_listing` 增加字段：

- `image_input_micro_usd integer null`
- `image_output_micro_usd integer null`
- `discount_rate_bps integer null`

`discount_rate_bps` 使用 basis points 存折扣倍率：`10000 = 原价 / 10 折`，`1000 = 1 折`，`50 = 0.05 折`。表单允许管理员输入“折扣折数”，如 `1` 表示 1 折，`0.5` 表示 0.5 折，保存时换算为 `discount_rate_bps = 折数 / 10 * 10000`。这样能支持 1 折以下且避免浮点误差。

保留现有 `list_input_micro_usd` / `list_output_micro_usd` 和 `discount_note`。列表可同时展示：

- 现价：输入/输出、图片输入/输出。
- 折扣：折数 + 百分比。
- 划线价：沿用已有 list price 字段，用于展示原价或官方价。

`catalog_model.context_window` 字段暂不删除，只从管理后台模型表单移除，避免影响已有公开页面或历史数据。

新增 `catalog_model_category`：

- `id text primary key`
- `model_id text not null references catalog_model(id)`
- `category_id text not null references catalog_category(id)`
- 唯一约束：`model_id + category_id`

`catalog_model.category` 保留为主分类兼容字段，保存时写入所选分类的第一个 slug；完整多分类以 `catalog_model_category` 为准。迁移会按历史 `catalog_model.category` 回填关联表。

## New API 候选接口

新增 server-only 能力：

- `createNewApiClient().listPricingModels()`

它调用 New API `GET /api/pricing`，解析响应：

- `data[]`：模型定价。
- `vendors[]`：供应商 ID 到供应商名称。
- `group_ratio` / `usable_group`：暂只用于候选元信息，不在首版自动写 APIPool 分组。

新增 APIPool 管理 API：

- `GET /api/apipool/admin/catalog/models/search?vendorId=<catalogVendorId>&keyword=<q>`

这个 API 做三件事：

1. 要求 `admin.catalog.write` 权限。
2. 将 APIPool `catalog_vendor.id` 映射为本地 `catalog_vendor.slug`，再按 New API `vendor_id` 过滤候选。
3. 返回浏览器可见的安全 DTO，不暴露 New API base URL、admin token、用户 ID 或内部分组配置。

DTO 字段：

- `modelId`
- `displayName`
- `vendorId`
- `vendorSlug`
- `vendorName`
- `inputMicroUsd`
- `outputMicroUsd`
- `imageInputMicroUsd`
- `imageOutputMicroUsd`
- `source`
- `supportedEndpointTypes`

价格换算沿用现有每 1M token 美元价口径。New API 的倍率字段不是直接美元价；按上游 `web/default/src/features/pricing/lib/price.ts`，默认展示价公式为 `model_ratio * 2 * groupRatio`。本项目不把 New API 分组倍率直接写入 APIPool 售卖分组，自动填入时使用 `groupRatio=1` 的基础价格，管理员可修改。

## 价格推导

从 New API `Pricing` 自动推导：

- `quota_type = 0`
  - 普通输入 token 价：`model_ratio * 2`
  - 普通输出 token 价：`model_ratio * 2 * completion_ratio`
  - 图片输入 token 价：若存在 `image_ratio`，`model_ratio * 2 * image_ratio`
  - 图片输出 token 价：沿用普通输出 token 价，因为 New API 服务端将 `output_tokens` 按 `completion_ratio` 计费
- `quota_type = 1`
  - 固定价格模型无法可靠拆成输入/输出 token，返回空价格并标记 `source = fixed-price`

所有自动价格最终通过 `dollarsToMicroUsd` 转为 micro-USD。

## 管理后台交互

新增/编辑模型页改用专用 client 组件，不继续使用通用 `FormCard`：

- 供应商：select 单选。
- 模型 ID：输入框 + 候选列表，关键词变化后请求内部 API。
- 展示名称：文本输入，选中候选后默认填入。
- 分组：select 单选，保存到默认 listing。
- 折扣：数字输入，单位为“折”，允许 `0.01` 到 `10`。
- 分类：select 多选，写入 `catalog_model_category`；同时把第一个分类 slug 写入 `catalog_model.category` 作为兼容主分类。
- 能力：select 多选，写入 `catalog_model_capability`。
- 普通输入/输出价：数字输入，美元 / 1M token。
- 图片输入/输出价：数字输入，美元 / 1M token，可为空。

编辑模型时加载模型的第一个 listing 作为默认 listing。如果没有 listing，编辑提交时创建一个 listing；如果已有 listing，则更新第一个 listing。多 listing 仍保留现有售卖项页面管理。

## 后端写入边界

新增服务函数：

- `getModelAdminRows()`：模型列表聚合供应商、默认 listing、能力。
- `getModelAdminConfig(id)`：编辑页加载模型、默认 listing、已选分类和能力。
- `upsertModelAdminConfig(input)`：在事务内创建/更新模型、默认 listing、分类关联和能力关联。

提交时服务层校验：

- 模型 ID、展示名称、供应商、分组、至少一个分类、至少一个能力必填。
- 价格字段必须是非负有限数；图片价格可为空。
- 折扣折数如果填写，范围为 `0.01 <= value <= 10`。

## 测试策略

- 更新 `catalog-admin-pages.test.ts`：验证菜单顺序、模型列表字段、上下文窗口已移除、模型表单使用专用组件和新字段。
- 扩展 `catalog-pricing.test.ts`：验证折扣 bps 转换、图片价格可选转换、New API pricing DTO 价格推导。
- 扩展 `catalog-service.test.ts`：验证组合 upsert 创建/更新模型、listing 和能力。
- 扩展 `newapi-bridge/client.test.ts`：验证 `/api/pricing` 解析、固定价格模型处理、图片价格推导。
- 新增/扩展 route 测试：验证内部 search API 权限和 DTO 不泄露内部凭据。
- 最终运行 `pnpm test`、`pnpm exec tsc --noEmit --pretty false`、`pnpm run lint`，如前端交互变更多则补浏览器 QA。
