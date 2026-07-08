# 管理后台模型管理与分组折扣简化设计

日期：2026-07-08

## 状态

已冻结候选。设计评审发现的 1 个 Blocker 和 2 个 Major 已在本设计中处理。

## 设计原则

本次是管理后台表达与表单边界收敛，不是价格体系重构。保留现有数据模型：

- `catalog_model` 继续表示模型主数据。
- `catalog_model_price` 继续表示模型官方/基准价格。
- `catalog_model_listing` 继续作为底层分组策略表，后台文案改为“分组折扣”。
- 公开 `/models` 继续通过 `resolveEffectiveCatalogPrice()` 判断哪些价格可公开确认。

## 模型管理页

`/admin/catalog/models` 的表格只展示模型清单和官方基准价格字段：

- `modelId`
- `displayName`
- `vendorName`
- `categoryNames`
- `capabilityNames`
- `inputPrice`
- `outputPrice`
- `imageInputPrice`
- `imageOutputPrice`

移除：

- `groupName`
- `discountRate`
- `pricingStatus`

价格同步和漂移按钮继续保留在表格上方。`pricingStatus` 不再作为每行列展示，因为它是内部状态拼接，不适合管理员快速判断。

## 模型表单

`ModelAdminForm` 继续由新增/编辑模型页复用，但可见字段收敛为：

- 供应商
- 模型 ID
- 模型名称
- 分类
- 能力
- 输入价格
- 输出价格
- 图片输入价格
- 图片输出价格

表单仍提交隐藏的 `groupId`、`statusId`、`discountFold`、`discountNote`、`description`，用于兼容 `upsertModelAdminConfig()` 当前“模型 + 默认 listing”事务写入边界。隐藏默认值来自现有编辑数据或官方/可用默认项，不改变运行时数据模型。

## 分组折扣页

保留 `/admin/catalog/models/[id]/listings` 路由，页面标题、面包屑、按钮和操作文案改为“分组折扣”。

列表展示：

- 分组
- 状态
- 折扣
- 折扣说明
- 说明
- 创建时间

列表不展示：

- 输入价格
- 输出价格
- 划线输入价
- 划线输出价
- `smokeTested`
- 排序

新增/编辑表单展示：

- 分组（编辑时继续不可变）
- 状态
- 折扣
- 折扣说明
- 说明
- 运维烟测通过

`smokeTested` 保留，但改为“运维烟测通过”，并用说明文案解释它只影响发布 smoke 候选，不代表折扣或公开售卖状态。

## 价格写入策略

分组折扣新增/编辑不再要求管理员手填 listing 的最终输入/输出价。提交时：

- 从 `getModelAdminConfig()` 获取 `catalog_model_price` 的基准价。
- 若基准价缺失，则回退到该模型默认 listing 的现有价格。
- 新建分组折扣时把底层 listing 的 `inputMicroUsd/outputMicroUsd/image*` 写成基准价以满足兼容字段。
- `discountRateBps` 仍保存管理员输入的折扣值，但不把 `pricePolicy` 强行改成 `listing_multiplier`。
- `pricePolicy` 继续使用数据库默认或既有值，避免未验证折扣被公开页面当成确认价。

这保证后台表达更清楚，同时不破坏价格同步、漂移检测和公开价格确认逻辑。

## 评审处理

- Blocker：完全移除 `smokeTested` 会破坏 smoke 候选。处理：不在列表展示，不从底层删除；表单保留为“运维烟测通过”并补说明。
- Major：把折扣直接落成 `listing_multiplier` 会导致公开价格进入 `needs_live_check`。处理：本次不改变 `pricePolicy`，继续由现有同步策略确认公开价格。
- Major：移除 `pricingStatus` 会降低 drift 可见性。处理：移除表格列，但保留价格同步和漂移按钮，后续如需更可读摘要可单独做运维报告页。

## 验证计划

- 静态页面测试覆盖模型列表列集合、模型表单字段、分组折扣文案和表单字段。
- 服务层测试覆盖分组折扣保存不需要手填最终价。
- 运行相关 `catalog-admin-pages`、`catalog-service`、`queries`、`smoke` 测试，确认公开查询和 smoke 候选依赖不被删除。
- 运行 `tsc` 和 lint，确保类型与格式不回归。
