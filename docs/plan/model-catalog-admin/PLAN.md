# 管理后台模型目录优化实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 优化管理后台模型目录菜单、模型列表和模型表单，让管理员能从 New API 候选中选择模型并在同一表单维护默认分组、能力、价格和折扣。

**Architecture:** 保持 `catalog_model` + `catalog_model_listing` + `catalog_model_capability` 结构，新增 listing 图片价格与折扣字段；用 New API `/api/pricing` 作为候选和参考价格来源；模型新增/编辑页改成专用 client form。

**Tech Stack:** Next.js App Router、React client component、Drizzle SQLite schema/migration、node:test、New API bridge server-only client。

---

## 文件结构

- 修改 `src/config/locale/messages/{en,zh}/admin/sidebar.json`：调整分组/分类菜单顺序。
- 修改 `src/config/db/schema.sqlite.ts`：新增 listing 字段和 `catalog_model_category` 多分类关联表。
- 新增 `src/config/db/migrations_sqlite/0007_model_catalog_admin_prices.sql`：迁移 listing 字段、创建分类关联表并回填历史主分类。
- 修改 `src/features/api-catalog/lib/types.ts`：公开 listing row 增加图片价格字段。
- 修改 `src/features/api-catalog/lib/pricing.ts`：新增可选价格、折扣转换、New API pricing 价格推导。
- 修改 `src/features/api-catalog/server/catalog-service.ts`：新增 admin 聚合查询和组合 upsert。
- 修改 `src/features/newapi-bridge/server/client.ts`：新增 `/api/pricing` 解析方法。
- 新增 `src/app/api/apipool/admin/catalog/models/search/route.ts`：内部候选搜索 API。
- 新增 `src/app/[locale]/(admin)/admin/catalog/models/model-admin-form.tsx`：专用 client 表单。
- 修改 `src/app/[locale]/(admin)/admin/catalog/models/{page.tsx,new/page.tsx,[id]/edit/page.tsx}`：接入聚合列表和专用表单。
- 修改 `src/config/locale/messages/{en,zh}/admin/catalog.json`：新增字段和提示文案。
- 更新 `tests/api-catalog/*`、`tests/newapi-bridge/client.test.ts`、`tests/db/*`。

## 任务

### Task 1: 菜单顺序和页面静态约束

- [x] 写失败测试：更新 `tests/api-catalog/catalog-admin-pages.test.ts`，期望 sidebar 顺序为 vendors、groups、categories、capabilities、statuses、models；模型表单不再出现 `contextWindow`。
- [x] 运行 `pnpm test tests/api-catalog/catalog-admin-pages.test.ts`，确认失败。
- [x] 修改两个 sidebar JSON，把 groups 放到 categories 前。
- [x] 初步修改模型 new/edit 页面，移除 `contextWindow` 字段引用，为后续 `ModelAdminForm` 接入清理旧表单项。
- [x] 再跑定向测试确认通过。

### Task 2: 价格与折扣工具

- [x] 写失败测试：扩展 `tests/api-catalog/catalog-pricing.test.ts`，覆盖 `optionalDollarsToMicroUsd`、`discountFoldToBps`、`bpsToDiscountFold`、`formatDiscountRate`、`derivePricingFromNewApiPricing`。
- [x] 运行定向测试确认失败。
- [x] 在 `pricing.ts` 实现工具函数和 DTO 类型。
- [x] 运行定向测试确认通过。

### Task 3: schema 与 service 组合写入

- [x] 写失败测试：扩展 `tests/db/catalog-schema-singlesource.test.ts` 和 `tests/api-catalog/catalog-service.test.ts`，要求 listing schema 暴露图片价格和折扣字段，`upsertModelAdminConfig` 能创建/更新模型、默认 listing、能力。
- [x] 运行定向测试确认失败。
- [x] 修改 `schema.sqlite.ts`，新增 migration `0007_model_catalog_admin_prices.sql`。
- [x] 在 `catalog-service.ts` 增加 admin row 查询、默认 listing 查询和组合 upsert。
- [x] 更新公开 query/types，使新字段不破坏已有调用。
- [x] 运行定向测试确认通过。

### Task 4: New API pricing 候选能力

- [x] 写失败测试：扩展 `tests/newapi-bridge/client.test.ts`，模拟 `GET /api/pricing`，覆盖普通倍率、图片倍率、固定价格模型和 vendor 映射。
- [x] 写失败测试：新增或扩展 API route 测试，验证 `/api/apipool/admin/catalog/models/search` 要求 `CATALOG_WRITE` 并返回安全 DTO。
- [x] 运行定向测试确认失败。
- [x] 在 New API client 中实现 `listPricingModels`。
- [x] 新增内部 search route，复用 catalog vendor 查询和 New API client。
- [x] 运行定向测试确认通过。

### Task 5: 模型管理 UI

- [x] 写失败测试：更新 `catalog-admin-pages.test.ts`，验证模型列表展示供应商、分组、分类、能力、输入/输出价、图片输入/输出价、折扣；new/edit 页面引用 `ModelAdminForm`。
- [x] 运行定向测试确认失败。
- [x] 新增 `model-admin-form.tsx`，实现供应商单选、模型 ID 搜索候选、展示名称/价格自动填入、分组单选、分类/能力多选、折扣和价格输入。
- [x] 修改 new/edit/page 使用服务层 form data 和 server action。
- [x] 修改 list/page 使用 admin rows 聚合展示。
- [x] 更新中英文文案。
- [x] 运行定向测试确认通过。

### Task 6: 全量验证和收口

- [x] 运行 `pnpm test`。
- [x] 运行 `pnpm exec tsc --noEmit --pretty false`。
- [x] 运行 `pnpm run lint`。
- [x] 如测试或 lint 暴露问题，按最小范围修复并重跑失败命令。
- [x] 复核 `git diff`，确认没有无关改动。
- [x] 更新本计划勾选项和最终报告。
