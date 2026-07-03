# New API 用户名与账本同步开发报告

> 日期：2026-07-03
> 范围：Phase A 开发结论
> 状态：开发完成，最终评审 GO

## 结论

本轮已完成 Phase A 开发：门户侧以规范化短邮箱同步 New API username，长邮箱 fail-closed 到 `username_sync_failed/newapi_username_too_long`，不再为新路径生成 `pu_<hash>` 技术用户名。New API quota 继续作为余额事实源，门户 ledger 作为充值、调额和补偿入口，usage snapshot 作为展示缓存。

## 执行与评审

| 阶段 | 执行 agent | 评审 agent | 结论 |
| --- | --- | --- | --- |
| Task 1 Schema / Migration | James | Ramanujan | GO |
| Task 2 New API Client | Ampere | Nash | GO |
| Task 3 Portal Binding / Signup / Preconditions | Cicero | Euler | GO |
| Task 4 Email Change / Admin Actions | Godel | Feynman | GO |
| Task 5 Admin List / Detail | Leibniz | Archimedes | GO after rework |
| Final Implementation Review | Avicenna for Task 6 execution | Zeno for final read-only review | GO |

Task 5 初审发现 TypeScript 阻断与后台筛选链接/测试覆盖缺口，已返工并复审 GO。最终评审无 Blocker / Major，仅提示合并或 PR 前必须提交所有未跟踪新增文件。

## 主要改动

- SQLite/libSQL `newapi_user_binding` 增加 username 同步目标、错误、动作、时间和冲突候选字段，并补 `0009_newapi_username_sync_status` 迁移与快照。
- New API client 新增 `getUserProfile()` / `updateUserProfile()`，更新用户时从远端回读 `role` 并原样提交，调用方不能传 `role`。
- Portal bridge 新增邮箱规范化、注册后 best-effort provision、历史 `pu_` active binding 迁移、长邮箱/空邮箱阻断、冲突待审、邮箱变更同步和审计。
- 后台新增 New API binding 列表筛选、用户详情状态卡片、retry / confirm conflict / disable 操作入口。
- API Key、usage、ledger 路径继续以 active binding 为前置，失败不向用户展示成功状态。
- 用户侧 DTO 和列表 DTO 保持去敏，不暴露 New API user id、key id、access token、password、内部 group 或冲突候选 ID。

## 剩余边界

- Phase A 只自动支持规范化邮箱长度 `<=20` 的用户。
- 长邮箱完整 username=email 需要 Phase B：自管或 patch New API 镜像，放宽 `Username` / `DisplayName` 长度后复做 Update User spike。
- 当前 worktree 仍未提交；合并前必须纳入新增迁移、快照、admin action、测试和阶段文档。
