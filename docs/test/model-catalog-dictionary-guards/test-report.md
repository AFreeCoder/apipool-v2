# 模型目录字典项标识与删除保护测试报告

日期：2026-07-08

## 范围

- 服务层五类字典项 `slug` 不可变校验。
- 服务层五类字典项删除引用保护。
- 管理后台五类字典项编辑、列表、删除页静态断言。
- 中英文后台文案 key 对齐。

## 命令与结果

| 命令 | 结果 |
| --- | --- |
| `pnpm test tests/api-catalog/catalog-service.test.ts` | 先失败后通过；最终 `386 passed` |
| `pnpm test tests/api-catalog/catalog-admin-pages.test.ts` | 先失败后通过；最终 `386 passed` |
| `pnpm test tests/api-catalog/catalog-service.test.ts tests/api-catalog/catalog-admin-pages.test.ts` | 通过，`386 passed` |
| `pnpm exec tsc --noEmit --pretty false` | 通过，无输出 |
| `pnpm run lint` | 通过；保留仓库既有 warning，0 error |
| `git diff --check` | 通过，无输出 |

## 覆盖结论

- 五类 `update*()` 均覆盖拒绝修改 `slug`，并验证原 `slug` 保持不变。
- 五类 `update*()` 均覆盖提交原 `slug` 时仍可正常更新非 `slug` 字段。
- 五类未引用字典项均覆盖可硬删除。
- 供应商、分组、能力、状态被引用删除阻断已覆盖。
- 分类删除分别覆盖 `catalog_model_category.category_id` 和 `catalog_model.category == category.slug` 两条阻断路径。
- 分组删除覆盖未删除 API Key 绑定阻断，以及 `status = 'deleted'` 绑定不阻断。
- 五类后台编辑页均断言 `slug` disabled，列表页均断言 delete URL，删除页均断言写权限、删除服务调用、阻断错误文案、destructive 按钮、cancel action/文案/返回列表 URL、`revalidateCatalog()` 和成功 redirect。

## 剩余风险

- 删除页仍显示通用阻断文案，不展示具体引用数量；当前按设计保持最小实现。
- 未增加浏览器交互测试；本次页面验证为静态源码断言。
