# 管理后台模型管理与分组折扣简化测试报告

日期：2026-07-08

## 范围

- 模型管理列表和表单只暴露官方基准模型信息，隐藏分组折扣相关兼容字段。
- 模型下的 listings 页面以“分组折扣”呈现，新增/编辑表单只展示分组、状态、折扣、折扣说明、说明、运维烟测通过。
- 不改 schema、公开查询、API Key 逻辑和 smoke 脚本。

## 评审闭环

- 需求与设计执行 agent 完成现状分析后，设计评审 agent 指出 `smokeTested` 不能删除、`pricingStatus` 列可移除但同步/漂移入口必须保留、分组折扣不能破坏现有价格策略语义。
- 实现 worker 完成首版后，代码评审 agent 指出新建分组折扣在缺少基准价时可能用 `0` 兜底写入。已修复为 `requiredBasePrice(...)`，缺少输入/输出基准价时抛 `errors.missingBasePrice`。
- 复评 agent 对当前 diff 返回 `APPROVED`，未发现 Blocker/Major。

## 验证结果

- `pnpm exec tsx --test tests/api-catalog/catalog-admin-pages.test.ts tests/api-catalog/catalog-service.test.ts`：20/20 pass。
- `NODE_OPTIONS='--conditions react-server' pnpm exec tsx --test tests/api-catalog/catalog-admin-pages.test.ts tests/api-catalog/catalog-service.test.ts tests/api-catalog/queries.test.ts tests/smoke/mvp-smoke-script.test.ts`：50/50 pass。
- `pnpm exec tsc --noEmit --pretty false`：pass。
- `pnpm run lint`：0 errors，194 warnings。warnings 为仓库既有 lint warning；当前改动范围内新增的两个 unused catch 参数 warning 已修复。
- `git diff --check`：pass。

## 未执行项

- 未做真实后台登录浏览器走查；本次验证覆盖静态页面约束、服务层回归、公开查询回归、smoke 脚本回归、类型检查和 lint。
