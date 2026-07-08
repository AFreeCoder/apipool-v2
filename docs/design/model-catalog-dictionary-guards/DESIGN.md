# 模型目录字典项标识与删除保护设计

日期：2026-07-08

## 总体方案

沿用现有 catalog schema，不新增软删除字段。`status=disabled` 继续作为业务下架机制，删除只用于清理未被引用的草稿字典项。

实现分两层：

- 页面层：编辑页禁用 `slug`，列表页增加删除动作，删除页展示确认表单。
- 服务层：所有五类 `update*()` 在收到不同 `slug` 时拒绝写入；所有五类 `delete*()` 在硬删前执行依赖计数，发现引用即抛出业务错误。

服务层是最终保护边界，页面禁用只改善管理员体验，不能作为唯一约束。

## 标识不可变

`slug` 已经进入公开查询、筛选维度、候选匹配、API key 创建和分类 join：

- 公开查询使用 vendor/group/category/status/capability slug 作为过滤值。
- `catalog_model.category` 存主分类 slug，并与 `catalog_category.slug` inner join。
- API key 创建按 group slug 查分组。

因此五类字典项一旦创建，编辑页都禁用 `slug`。服务层统一做不可变校验，避免直接调用 server action 或服务函数绕过页面。

## 删除保护

新增服务层内部工具：

- `assertImmutableSlug(currentSlug, patchSlug, label)`
- `ensureNoCatalogReferences(label, references)`
- `getCatalogReferenceCount(...)`

每个 `delete*()` 按自己的引用表检查：

- `deleteVendor(id)`：先查 vendor，再数 `catalog_model.vendor_id`。
- `deleteCategory(id)`：先查 category，再数 `catalog_model_category.category_id` 和 `catalog_model.category == category.slug`。
- `deleteCapability(id)`：数 `catalog_model_capability.capability_id`。
- `deleteStatus(id)`：数 `catalog_model_listing.status_id`。
- `deleteGroup(id)`：数 `catalog_model_listing.group_id` 和 `newapi_key_binding.group_id` 且 `newapi_key_binding.status != 'deleted'`。

发现任一引用数大于 0 时抛出带固定 code 的业务错误，页面捕获后显示本地化阻断文案：

- zh：`该记录仍被模型目录使用，不能删除。请改为禁用或下架相关入口。`
- en：`This record is still used by the catalog and cannot be deleted. Disable or unpublish the related entry instead.`

通用 `errors.deleteFailed` 只用于未知异常。后续如需展示具体引用数量，可复用同一引用计数结果扩展文案；本次保持最小实现。

## 页面结构

五类列表页在 actions 中新增 destructive delete action：

- `/admin/catalog/vendors/{id}/delete`
- `/admin/catalog/groups/{id}/delete`
- `/admin/catalog/categories/{id}/delete`
- `/admin/catalog/capabilities/{id}/delete`
- `/admin/catalog/statuses/{id}/delete`

五类删除页沿用模型删除页模式：

- `requirePermission(PERMISSIONS.CATALOG_WRITE)`
- 记录不存在时显示 `Empty`
- `FormCard` 无字段确认
- destructive submit button
- cancel 返回列表
- 成功后 `revalidateCatalog()` 并重定向回列表

## 文案

在 `src/config/locale/messages/{zh,en}/admin/catalog.json` 为五类字典项新增 `delete` 节点：

- `title`
- `crumb`
- `notFound`
- `description`
- `success`
- `blocked`
- `buttons.submit`
- `buttons.cancel`

删除页 server action 捕获引用阻断错误时返回 `delete.blocked`；其他异常返回 `errors.deleteFailed`。

## 测试设计

- `tests/api-catalog/catalog-admin-pages.test.ts`
  - 五类 edit page 的 `slug` 字段都 `disabled: true`。
  - 五类 list page actions 同时包含 edit/delete URL。
  - 五类 delete page 存在、要求写权限、调用对应 delete service、使用 destructive 按钮、成功后回列表。

- `tests/api-catalog/catalog-service.test.ts`
  - 五类 `update*()` 拒绝修改 slug。
  - 五类未引用记录可以硬删。
  - vendor/category/capability/status/group 被引用时删除失败。
  - category 删除阻断需要分别覆盖 `catalog_model_category.category_id` 和 `catalog_model.category == category.slug` 两条路径。
  - group 对 `newApiKeyBinding.status != 'deleted'` 的绑定删除失败，对 `deleted` 绑定不阻断。

## 风险与边界

- 不新增软删除字段，避免迁移和唯一 slug 语义扩大。
- 不自动迁移引用，避免误改模型售卖关系。
- 页面错误信息保持通用，详细引用数量先由服务测试保证；若运营需要更细提示，再扩展错误类型和文案。
