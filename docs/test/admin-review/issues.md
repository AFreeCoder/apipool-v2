# 管理后台审查遗留清单

- 基线：main @ 03a3e76 + 本轮工作区修复（未提交）
- 来源：[report.md](report.md)（2026-07-09 管理后台三维度审查 + 实走）
- 规则：条目被解决/升级时勾掉并回链对应 feature 或提交。已在 `docs/test/pre-launch-review/issues.md` 挂账的项不重复列出。

## 本轮已修复（工作区，待提交）

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

- [ ] **R-1 管理员正向调额未接 `onRedemptionCreated`/`remoteAttemptAt`，崩溃窗口可双倍到账**（资金链路，按 P0-1 批次 TDD 流程做，~20 行照抄 recharge.ts）
- [ ] **R-2 生产环境 admin 表单业务错误全部被脱敏成通用英文**（throw→return {status:'error'} 机械改造 ~12 文件；注意 pre-launch P1-8 的修复在生产实际无效）
- [ ] **R-3 停用绑定无恢复路径**，被停用户充值落终态 failed（需真实 New API 验证恢复语义）
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
