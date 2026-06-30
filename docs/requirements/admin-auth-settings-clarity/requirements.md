# 后台认证设置页可读性优化需求

创建时间：2026-06-30

## 背景

在配置 Google OAuth 线上登录时，管理员在 `/admin/settings/auth` 页面看到多个含义相近的开关：

- `Enabled`
- `Auth Enabled`
- `OneTap Enabled`
- `Auth Enabled`

这些字段实际分别对应邮箱密码登录、Google 登录、Google One Tap、GitHub 登录，但页面当前没有清晰展示字段所属分组，导致管理员容易误以为存在重复配置或不知道应该打开哪一个开关。

## 问题

1. `Enabled` 缺少上下文，无法直接看出是邮箱密码登录开关。
2. Google 和 GitHub 都显示为 `Auth Enabled`，字段名重复，容易误操作。
3. `OneTap Enabled` 未说明含义，管理员可能把它误认为普通 Google 登录开关。
4. 分组标题在当前表单展示中不够明显，无法有效区分邮箱认证、Google 认证、GitHub 认证。

## 目标

让管理员在不阅读代码、不依赖外部说明的情况下，能明确判断每个认证配置项的用途，并正确完成 Google OAuth 线上配置。

## 需求

1. 将邮箱登录开关展示为清晰文案，例如 `邮箱密码登录启用` / `Email Password Login Enabled`。
2. 将 Google 登录开关展示为清晰文案，例如 `Google 登录启用` / `Google Sign-in Enabled`。
3. 将 GitHub 登录开关展示为清晰文案，例如 `GitHub 登录启用` / `GitHub Sign-in Enabled`。
4. 为 Google One Tap 提供简短说明，表达它是 Google 自动提示登录浮层，不是普通 Google 登录按钮。
5. 在认证设置页明确展示或强化分组标题：邮箱认证、Google 认证、GitHub 认证。
6. 保存逻辑、配置字段名和现有数据库值保持兼容，不因文案优化改变配置语义。

## 验收标准

1. 管理员打开 `/admin/settings/auth` 后，可以明确区分邮箱、Google、GitHub 三组配置。
2. 页面不再出现两个无法区分的 `Auth Enabled`。
3. Google OAuth 只需开启 `Google 登录启用`、填写 Client ID 和 Client Secret；One Tap 默认可保持关闭。
4. 中文和英文界面均具备清晰字段文案。
5. 原有配置项 `email_auth_enabled`、`google_auth_enabled`、`google_one_tap_enabled`、`github_auth_enabled` 不迁移、不重命名。

## 非目标

- 不调整 Better Auth 登录流程。
- 不改 Google OAuth 回调地址生成逻辑。
- 不改变 GitHub 登录能力。
- 不在本需求中实现 One Tap 行为改造。
