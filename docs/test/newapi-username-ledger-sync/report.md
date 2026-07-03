# New API 用户名与账本同步测试报告

> 日期：2026-07-03
> 范围：Phase A 测试结论
> 状态：测试通过，最终评审 GO

## 结论

Task 6 已完成 usage、ledger、API Key 和充值路径回归补测。全量 `pnpm test`、`pnpm lint`、`pnpm build` 均通过；lint 和 build 仅保留仓库既有 warning。

## 覆盖点

- 公共 usage / key DTO 不暴露 New API binding 内部字段或凭据。
- 长邮箱 quota adjustment 被 Phase A limit 阻断，不产生 `applied` ledger，并记录 username sync failed audit。
- 首次短邮箱 create key 使用规范化邮箱作为 New API username，明确不生成 `pu_`。
- 充值成功和幂等路径使用短邮箱 active binding，断言 New API user id 与 email username 对齐，不再依赖 `remote_pu_`。
- New API bridge client、portal binding、key lifecycle、ledger、usage snapshot 和 admin actions 组合回归通过。

## 验证命令

```bash
NODE_OPTIONS='--conditions react-server' pnpm exec tsx --test tests/newapi-bridge/portal.test.ts --test-name-pattern 'public usage and key DTOs|long-email quota adjustment'
NODE_OPTIONS='--conditions react-server' pnpm exec tsx --test tests/newapi-bridge/create-portal-key.test.ts --test-name-pattern 'normalized email username|blocks Phase A long emails'
NODE_OPTIONS='--conditions react-server' pnpm exec tsx --test tests/newapi-bridge/client.test.ts tests/newapi-bridge/portal.test.ts tests/newapi-bridge/create-portal-key.test.ts tests/newapi-bridge/admin-user-binding-actions.test.ts
NODE_OPTIONS='--conditions react-server' pnpm exec tsx --test tests/payments/recharge.test.ts
pnpm test
pnpm lint
pnpm build
git diff --check
```

## 结果

- Focused portal tests：46/46 pass。
- Focused create key tests：8/8 pass。
- New API bridge suite：96/96 pass。
- Recharge tests：11/11 pass。
- Full test suite：353/353 pass。
- `pnpm lint`：exit 0，保留既有 196 warnings，无 error。
- `pnpm build`：exit 0。
- `git diff --check`：pass。

## 剩余风险

- 未做真实浏览器后台操作走查；本轮后台 UI 由静态测试、typecheck、lint、build 和最终只读评审覆盖。
- 未连接真实 New API 实例做端到端更新；设计阶段已用 `calciumion/new-api:latest` 容器 spike 验证 Admin Update User 行为，开发测试使用 fake client 固定边界。
