# Model Catalog Dictionary Guards Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让模型目录五类字典项的标识不可变，并只允许删除零引用字典项。

**Architecture:** 页面层禁用 edit slug 并增加删除确认入口；服务层统一拒绝 slug patch，并在硬删除前做应用层引用计数。沿用现有 `status=disabled` 作为业务下架机制，不新增软删除 schema。

**Tech Stack:** Next.js App Router、Server Actions、Drizzle ORM、SQLite/libsql、node:test、next-intl。

---

## File Structure

- Modify: `src/features/api-catalog/server/catalog-service.ts`
  - Add immutable slug guard.
  - Add reference-count guards for five dictionary delete functions.
- Modify: `src/app/[locale]/(admin)/admin/catalog/{vendors,groups,categories,capabilities,statuses}/page.tsx`
  - Add delete dropdown action.
- Modify: `src/app/[locale]/(admin)/admin/catalog/{vendors,groups,categories,capabilities,statuses}/[id]/edit/page.tsx`
  - Disable `slug` and keep existing slug in patch.
- Create: `src/app/[locale]/(admin)/admin/catalog/{vendors,groups,categories,capabilities,statuses}/[id]/delete/page.tsx`
  - Confirmation pages following model delete pattern.
- Modify: `src/config/locale/messages/{zh,en}/admin/catalog.json`
  - Add delete copy for five dictionary entities.
- Modify: `tests/api-catalog/catalog-admin-pages.test.ts`
  - Update static page assertions.
- Modify: `tests/api-catalog/catalog-service.test.ts`
  - Add service behavior tests.
- Create: `docs/test/model-catalog-dictionary-guards/test-report.md`
  - Record verification commands and results.

## Tasks

### Task 1: Tests for service guards

- [x] Add `createModelListing()` helper in `tests/api-catalog/catalog-service.test.ts` if existing helpers are insufficient.
- [x] Add a test that `updateVendor/updateGroup/updateCategory/updateCapability/updateStatus` reject slug changes and preserve stored slug.
- [x] Add tests that unreferenced vendor/group/category/capability/status records can be deleted.
- [x] Add tests that referenced vendor/group/capability/status records cannot be deleted.
- [x] Add category deletion tests for both blockers: `catalog_model_category.category_id` and `catalog_model.category == category.slug`.
- [x] Add group-specific test: `newApiKeyBinding.status = 'active'` blocks group deletion, while `status = 'deleted'` does not block deletion.
- [x] Run `pnpm test tests/api-catalog/catalog-service.test.ts`; expected result before implementation is failing tests for missing guards.

### Task 2: Implement service guards

- [x] In `catalog-service.ts`, import `count` and `ne` from `drizzle-orm`, and import `newApiKeyBinding`.
- [x] Add `CatalogDeleteBlockedError`, `CatalogReference` type, and helper functions for counting references and building delete-block errors.
- [x] Update five `update*()` functions to load current row and call immutable slug guard before `.update()`.
- [x] Update five `delete*()` functions to load current row, count dependencies, throw if any reference exists, then hard delete.
- [x] Run `pnpm test tests/api-catalog/catalog-service.test.ts`; expected result is pass.

### Task 3: Tests for admin pages

- [x] Update `tests/api-catalog/catalog-admin-pages.test.ts` so every dictionary entity includes a delete route expectation.
- [x] Assert every edit page has disabled `slug`.
- [x] Assert every list page contains edit and delete actions.
- [x] Assert every delete page exists, requires `PERMISSIONS.CATALOG_WRITE`, calls the right `delete*()` function, uses destructive variant, calls `revalidateCatalog()`, and redirects to the list page.
- [x] Run `pnpm test tests/api-catalog/catalog-admin-pages.test.ts`; expected result before page implementation is failing tests for missing delete pages and disabled fields.

### Task 4: Implement admin pages and i18n

- [x] Disable `slug` on vendor/category/capability/status edit pages and submit original slug instead of form value; keep group behavior aligned.
- [x] Add delete action to five list pages.
- [x] Add five delete confirmation pages by following `models/[id]/delete/page.tsx` pattern.
- [x] Add zh/en delete copy for vendors/groups/categories/capabilities/statuses, including `delete.blocked`.
- [x] In delete page handlers, return `delete.blocked` for `CatalogDeleteBlockedError` and `errors.deleteFailed` for unknown errors.
- [x] Run `pnpm test tests/api-catalog/catalog-admin-pages.test.ts`; expected result is pass.

### Task 5: Review and verification

- [x] Run `pnpm test tests/api-catalog/catalog-service.test.ts tests/api-catalog/catalog-admin-pages.test.ts`.
- [x] Run `pnpm exec tsc --noEmit --pretty false`.
- [x] Run `pnpm run lint`.
- [x] Run `git diff --check`.
- [x] Write `docs/test/model-catalog-dictionary-guards/test-report.md` with command results and residual risks.
- [x] Run a final diff review focused on SQL/data safety, destructive actions, and i18n coverage.
