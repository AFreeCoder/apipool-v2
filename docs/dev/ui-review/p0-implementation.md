# UI 优化 P0 实施记录（2026-07-09）

> 依据：`docs/test/ui-review/ui-audit-2026-07-08.md`（第 4 轮 UI 审查）的 P0 路线图。
> 分支：`worktree-ui-polish-p0`（基于 `fix/pre-launch-p0` @ b988d0b）。
> 验证：tsc 0 错、lint 0 错（201 条既有 warning 未新增）、node:test 473/473 通过、
> Playwright 起站截图逐项对照（证据见 `shots/`）。

## 提交清单

| 提交 | 内容 |
|---|---|
| b01ca8f | P0-1 头部控件重组：顶栏右侧只剩 CTA+头像；主题/语言进头像子菜单（登录态）与页脚（登出态）；控制台路由下隐藏控制台按钮；登出态改 登录(ghost)+开始使用(outline)；移动抽屉加控制台 CTA 与带标签的主题/语言行；头像菜单补 API 密钥/余额/用量；删除 ThemeToggler 无 onClick 的 button 死分支 |
| 524fdbf | P0-2 语言横幅改为文档流内 `bg-muted` 窄条，删除 fixed + `header.style.top` DOM hack；认证页不再被盖 |
| b7cce0f | P0-3 docs 壳统一：`--color-fd-*` 全量映射站点 token；shiki 双模式统一 `github-dark-default` + `keepBackground`，浅色模式下代码块也是深底终端风 |
| 3401643 | P0-4 /models 五行筛选压缩为一行下拉（URL 驱动不变）+ 清除筛选链接；dimensions 词条补全（embedding/image/audio/rerank/video/coming_soon/retired/sub2api），中英双向不再漏翻 |
| 542815a | 修复：HeaderAuthCluster 因 `isCheckSign` 初值依赖服务端独有的 `envConfigs.auth_secret` 造成 hydration mismatch（加 mounted 门）；认证页 absolute 页头改流内 flex 行，与流内横幅不再叠压 |

## 与审查报告建议的偏差（有意为之）

1. **登录态控制台按钮用 outline 而非报告建议的 primary**——docs/05 §5 规定每屏至多一个
   `bg-primary` 主按钮，营销页首屏已有 hero CTA，头部让位。
2. **fumadocs 自带的主题/语言控件保留**——docs 壳没有站点页脚和头像菜单，隐藏后文档
   读者将无处切换；token 统一后其观感已与主站一致。

## 实现要点（后来者须知）

- 语言切换逻辑收敛到 `src/shared/blocks/common/use-locale-switcher.ts`，
  头部选择器与头像菜单共用；`tests/public-content/i18n-coverage.test.ts` 的
  源码模式断言已指向该 hook。
- `isCheckSign` 的初值在服务端为 true、客户端为 false（`!!envConfigs.auth_secret`），
  任何以它做首屏渲染分支的客户端组件都必须加 mounted 门，否则 hydration 必炸。
- worktree 起站验证时 dev server 必须跑在 3000 端口：better-auth 的 trustedOrigins
  跟随 APP_URL（localhost:3000），其他端口的浏览器请求注册/登录会 403。

## 遗留

见 `issues.md`（P1/P2 待办，来自审查报告路线图）。
