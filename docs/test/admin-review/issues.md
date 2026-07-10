# 管理后台审查遗留清单

- 基线：main @ 03a3e76
- 来源：[report.md](report.md)（2026-07-09 管理后台三维度审查 + 实走）
- 规则：条目被解决/升级时勾掉并回链对应 feature 或提交。已在 `docs/test/pre-launch-review/issues.md` 挂账的项不重复列出。

## 本轮已修复（F 批已合入 `30e3b09`，文档 `ae9ec47`）

- [x] F-1（P0）`assignPermissionsToRole` 非事务 delete+insert 可清空角色权限锁死后台 —— 包事务
- [x] F-2（P0）编辑模型只重置一条 listing 的 drift，其他分组公开价与计费脱钩 —— 事务内全量打回 `needs_live_check`
- [x] F-3 语言切换独立图标按钮进站点头部（用户要求，参考 APIMart）
- [x] F-4 语言建议横幅在 admin 被 fixed 侧栏遮挡 —— `/admin` 不渲染横幅
- [x] F-5 「停用绑定」加不可逆警示确认框 + 操作后刷新（新增 `ConfirmActionButton`）
- [x] F-6 折扣输入拒绝小数折 + 空值挡死表单（seed listing 连 smokeTested 都改不了）—— `step:any` + 可选 number 空值跳过校验
- [x] F-7 admin 区无 loading/error 边界 —— 补骨架屏 + 双语 error.tsx
- [x] F-8 admin 登录跳转丢 callbackUrl，深链登录后落首页 —— `x-pathname` + safeInternalPath
- [x] F-9 settings/user/roles/permissions 保存 toast 硬编码英文 —— 词条化（en/zh）
- [x] F-10 auth 设置两个同名「Auth Enabled」开关 —— 改名 Email/Google/GitHub Auth Enabled
- [x] F-11 「AI」设置 tab 喂给零引用死服务、诱导存入真实密钥 —— 移除 tab
- [x] F-12 侧栏子菜单高亮进详情/编辑页丢失 —— endsWith→startsWith
- [x] F-13 第 2 页搜索必得空列表 —— 搜索重置 page 参数
- [x] F-14 侧栏设置组缺 通用/支付 入口 —— 补齐
- [x] F-15 侧栏页脚假「推特」链接 —— 删除
- [x] F-16 表单提交逐字段 console.log —— 删除

## 上线前建议完成

- [x] **R-1 管理员调额可双倍到账/双倍扣减** —— ⚠️ `5537976` 的首次修复**不完整**（标记写了但无人读），已于 2026-07-09 由 `9a9cd20` **真正闭合**。服务端新增未结清守卫（pending/processing/reconciliation_required 存在即拒绝新调额，错误原文含 ledger id 且已实测能穿过脱敏层）；「判定 + 插入」同事务防并发；只有陈旧且 `remoteAttemptAt`/`newapiChangeId` 皆为 null 的行可回收；负向路径新增 `onQuotaWriteDispatched`，PUT 发出后响应丢失一律升级 `reconciliation_required`。8 个新用例 + 起服务实走复验（守卫命中、清理后放行、无残留行）。复盘见 report.md「R-1 复盘」。**遗留**：卡住的 `reconciliation_required` 行目前只能人工改库解封，无 admin 界面（见 S-18 与 pre-launch 的告警项）。
- [x] **R-2 生产环境 admin 表单业务错误全部被脱敏成通用英文** —— 2026-07-09 已修复，回链提交 `2193a2d`。catalog 21 个 CRUD 页的业务错误全部改为 `return {status:'error', message}`（输入校验辅助函数改抛私有 `FormValidationError` 在 action 内捕获；未知错误继续上抛进 error 边界）；新增守卫测试 `catalog-admin-error-contract.test.ts` 禁止页面再出现 `throw new Error(`。pre-launch P1-8 的翻译提示自此在生产真正可见。
- [x] **R-3 停用绑定无恢复路径**，被停用户充值落终态 failed —— 2026-07-09 已修复，回链提交 `5537976`（恢复入口）+ `abe41ce`（守卫）+ `9a9cd20`（并发安全）。新增 `restoreNewapiUserBindingForAdmin`，详情页停用态只显示「恢复绑定」。**Codex 评审补修**：恢复改条件更新原子 claim（原为 check-then-act）；`ensurePortalUserBinding` 的成功与失败两条写回路径都加 `status != 'disabled'` 守卫，在途恢复不再静默撤销更晚的停用；停用确认文案「不可逆」已订正为「可撤销」。**遗留**：幂等接回同一远端用户依赖 `provisionUser` 的按名恢复语义，建议上线后在真实 New API 复验一次。
- [x] **CDX-1 catalog server action 信任客户端回传的 `passby` 快照**（Codex high）—— `passby` 是 server action 实参、非闭包，不加密不签名。伪造 `pricePolicy='listing_multiplier'` + 极低折扣即可让公开页按基准价 0.1% 展示而 New API 仍按分组倍率计费（绕过 P0-3/F-2 的 hide-until-confirmed 不变量，需 `CATALOG_WRITE`）；过期页面也会写回陈旧快照。已改为 action 内按路由参数重查 + 校验归属，`passby` 全部删除并加守卫测试；listing 编辑不再写 `pricePolicy`/`featured`/`sortOrder`，折扣在吃折扣的策略下变更时强制 `needs_live_check`。
- [ ] **R-4 用户编辑页头像上传必失败且清空原头像**（MVP 期移除字段，~5 行）
- [ ] **R-5 `/admin` 落点绑最高危权限**，低权限角色进后台即 no-permission；调额页面包屑自环（与 S-2 overview 一并做最合算）
- [ ] **R-6 调额页闭环断裂**：失败不给原因 / portalUserId 直达不回显身份 / 成功无详情页链接（≤50 行）
- [ ] **S-18 用户详情页账本看不到 recharge ledger**，「付了钱没到账」无法排查（并入 source='recharge' ~30 行，建议升入上线前批次）

## P2 建议（详情见 report.md 第三节）

- [ ] S-1 侧栏排序按使用频率重排 + 去「模型目录」双层同名嵌套（纯 JSON）
- [ ] S-2 后台 overview 首页（运维信号：reconciliation/同步失败/待同步计数）
- [ ] S-3 admin 区 `generateMetadata`（页面标题可区分多标签页）
- [ ] S-4 no-permission 页补 Header 与返回出口
- [ ] S-5 Tabs 组件挂载即 push 历史、tab 不可中键新开
- [ ] S-6 models 列表补 分组/折扣/价格同步状态 三列（数据已算好未上列）
- [ ] S-7 新建模型渲染分组下拉（groups prop 收了没用）
- [ ] S-8 admin 侧 `formatDiscountRate` 中文「X 折」词条化（EN 后台出现中文）
- [ ] S-9 能力清空/0 能力保存 = 模型静默下架，无警示
- [ ] S-10 「分组折扣」折扣字段对公开定价无效——加 tip 或产品决策
- [ ] S-11 字典/模型撞唯一索引未捕获；listings/new 缺隐藏提示；编辑模型抹划线价；models 列表 N+1 无分页
- [ ] S-12 邮箱搜索大小写敏感全等 → LIKE + lowercase
- [ ] S-13 重试/确认冲突无成功反馈；只读管理员应隐藏写按钮
- [ ] S-14 `translateStatus` 死防线：缺键渲染键路径
- [ ] S-15 checkbox required 不生效；管理员可自锁（编辑自己移除 admin 角色）
- [ ] S-16 筛选 pill 无激活态/清除入口；角色列 N+1
- [ ] S-17 「未初始化」与同步失败态混淆；usage 错误提示永不出现
- [ ] S-19 用户列表 ID 列占宽挤出右侧列；models 操作列在视口外（截断 UUID / 固定操作列）
- [ ] S-20 死代码清理：form-card 桩、brand.description、t.raw 就地突变、posts/categories 死权限、apikeys/grant_credits 死词条
- [ ] S-21 A11y：header button>a、main-header a>button 无效嵌套
- [ ] S-22 设置字段单语（既成立场，记录）；Initial Credits 死轨随双轨清理摘除；只读管理员的设置表单应禁用提交
