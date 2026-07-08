# 管理后台模型管理与分组折扣简化实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 简化管理后台模型管理和分组折扣页面表达，让模型页只维护官方基准模型信息，分组策略以“分组折扣”呈现。

**Architecture:** 不改 schema，不改公开价格算法。只调整 admin 页面字段、server action 写入边界、i18n 和测试约束。

**Tech Stack:** Next.js App Router、React client component、Drizzle service 层、node:test、next-intl。

---

## Task 1: 文档与评审冻结

- [x] 写需求文档到 `docs/requirements/model-admin-pricing-simplification/requirements.md`。
- [x] 写设计文档到 `docs/design/model-admin-pricing-simplification/DESIGN.md`。
- [x] 写实施计划到 `docs/plan/model-admin-pricing-simplification/implementation-plan.md`。
- [x] 让评审 agent 复核文档是否处理 smoke、pricePolicy、pricingStatus 风险。
- [x] 修复评审发现的 Blocker/Major。

## Task 2: 页面约束测试先行

- [x] 更新 `tests/api-catalog/catalog-admin-pages.test.ts`：
  - 模型列表不再断言 `groupName`、`discountRate`、`pricingStatus`。
  - 模型列表继续断言四类价格字段存在。
  - 模型列表继续断言价格同步/漂移操作入口存在。
  - listings 文案按“分组折扣”检查 i18n。
  - 分组折扣表单不再断言最终价格字段。
  - 分组折扣表单继续断言 `smokeTested` 存在并带说明。
- [x] 运行 `pnpm exec tsx --test tests/api-catalog/catalog-admin-pages.test.ts`，确认测试按预期失败。

## Task 3: 模型管理页与表单降噪

- [x] 修改 `src/app/[locale]/(admin)/admin/catalog/models/page.tsx`，只移除 `groupName`、`discountRate`、`pricingStatus` 列，不移除表格上方价格同步/漂移操作。
- [x] 修改 `src/app/[locale]/(admin)/admin/catalog/models/model-admin-form.tsx`，隐藏分组、折扣、折扣说明、说明字段。
- [x] 修改模型 new/edit page 的 props 传入，去掉不再使用的可见 labels。
- [x] 运行 `pnpm exec tsx --test tests/api-catalog/catalog-admin-pages.test.ts`。

## Task 4: 分组折扣页降噪

- [x] 修改 listings list page，表格只展示分组、状态、折扣、折扣说明、说明、创建时间。
- [x] 修改 listings new/edit page，表单只展示分组、状态、折扣、折扣说明、说明、运维烟测通过。
- [x] 新建 listing 时从模型基准价或默认 listing 派生底层兼容价格，不再手填最终价格。
- [x] 编辑 listing 时保留既有 `pricePolicy`、`featured`、`sortOrder`，只更新折扣/说明/状态/烟测。
- [x] 运行 `pnpm exec tsx --test tests/api-catalog/catalog-admin-pages.test.ts tests/api-catalog/catalog-service.test.ts`。

## Task 5: i18n 文案

- [x] 更新 `src/config/locale/messages/zh/admin/catalog.json`。
- [x] 更新 `src/config/locale/messages/en/admin/catalog.json`。
- [x] 确认两份 locale JSON key 一致。
- [x] 运行 `pnpm exec tsx --test tests/api-catalog/catalog-admin-pages.test.ts`。

## Task 6: 评审与修正

- [x] 让执行 worker 汇报变更文件与验证结果。
- [x] 让评审 agent 对 diff 做 spec/code review。
- [x] 修复评审 agent 的 Blocker/Major。
- [x] 复跑失败测试。

## Task 7: 最终验证与测试报告

- [x] 运行 `NODE_OPTIONS='--conditions react-server' pnpm exec tsx --test tests/api-catalog/catalog-admin-pages.test.ts tests/api-catalog/catalog-service.test.ts tests/api-catalog/queries.test.ts tests/smoke/mvp-smoke-script.test.ts`。
- [x] 运行 `pnpm exec tsc --noEmit --pretty false`。
- [x] 运行 `pnpm run lint`。
- [x] 写测试报告到 `docs/test/model-admin-pricing-simplification/report.md`。
