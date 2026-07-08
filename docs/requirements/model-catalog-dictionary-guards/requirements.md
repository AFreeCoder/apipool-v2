# 模型目录字典项标识与删除保护需求

日期：2026-07-08

## 背景

管理后台的模型目录下，供应商、分组、分类、能力、状态都是模型售卖链路的基础字典项。当前现状是：

- 供应商、分类、能力、状态编辑页允许修改 `slug` 标识；分组编辑页已禁用 `slug`，但服务层仍允许通过 `updateGroup()` patch 修改。
- 五类字典项列表页没有删除入口。
- 服务层已有 `deleteVendor()`、`deleteGroup()`、`deleteCategory()`、`deleteCapability()`、`deleteStatus()`，但都是直接硬删除，没有应用层依赖检查。
- `catalog_model_listing.group_id` schema 上是 cascade，但本项目不能依赖 SQLite/libsql 外键执行；已有 `deleteModel()` 也显式删除模型关系。

这些行为会带来两类风险：标识修改破坏公开筛选、候选匹配或 `catalog_model.category` 的 slug join；删除被引用字典项可能级联删售卖项或留下孤儿关系。

## 目标

- 管理后台编辑供应商、分组、分类、能力、状态时，现有记录的 `slug` 标识不可修改。
- 服务层拒绝所有五类字典项的 `slug` patch，防止绕过页面限制。
- 五类字典项列表页增加删除入口，并提供确认删除页。
- 删除只允许“零引用”的字典项硬删除。
- 有引用的字典项删除必须被阻断，并提示管理员使用禁用/下架字段代替删除。
- 被引用阻断时，后台必须展示本地化的可操作提示，不只显示通用“删除失败”。

## 范围

包含：

- 五类字典项编辑页的 `slug` 字段禁用。
- 五类字典项列表页新增删除动作。
- 五类字典项删除确认页。
- 服务层引用计数、安全删除和 `slug` 不可变校验。
- 中英文后台文案。
- 单元/静态页面测试。
- 过程测试报告。

不包含：

- 新增 `deleted_at` 或软删除迁移。
- 改造公开 `/models` 页面展示。
- 改造 API Key 创建流程。
- 删除被引用数据时自动迁移模型、售卖项或 key 绑定。
- 生产数据清理。

## 依赖规则

删除前必须按应用层检查以下依赖：

- 供应商：`catalog_model.vendor_id`
- 分类：`catalog_model_category.category_id` 和 `catalog_model.category == catalog_category.slug`
- 能力：`catalog_model_capability.capability_id`
- 状态：`catalog_model_listing.status_id`
- 分组：`catalog_model_listing.group_id` 和 `newapi_key_binding.group_id where status != 'deleted'`

## 删除策略

- 没有依赖：允许硬删除。
- 有依赖：禁止删除，返回可读错误信息。
- 业务下架：使用现有字段完成，例如 `status=disabled`、状态的 `isCallable=false` / `isPublicVisible=false`、分组的 `allowCreateKey=false`。

## 验收标准

- 供应商、分组、分类、能力、状态五个编辑页都禁用 `slug` 字段。
- 对五类字典项调用 `update*()` 时，即使 patch 中传入不同 `slug`，也会抛出错误且不写入。
- 五类列表页 actions 同时包含“编辑”和“删除”。
- 五类删除页要求 `CATALOG_WRITE` 权限，使用 destructive 按钮，并成功后回到对应列表。
- 被模型、分类关联、能力关联、售卖项或未删除 API key 绑定引用时，删除会失败。
- 删除失败如果是引用阻断，页面提示应指导管理员改用禁用/下架字段。
- 未引用字典项可以删除。
- 修改后 `catalog-admin-pages.test.ts` 和 `catalog-service.test.ts` 覆盖上述行为。
