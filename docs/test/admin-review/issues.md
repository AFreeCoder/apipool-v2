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
- [x] **R-4 用户编辑页头像上传必失败且清空原头像** —— `a76b6c7` 移除该字段（上传端点 MVP 期恒 404，失败即置 '' 提交抹掉原头像）。
- [x] **R-5 `/admin` 落点绑最高危权限** —— `c55c351` 改为对全体 `admin.access` 开放的运维 overview（含 S-2），资金卡片按权限渲染；面包屑自环消除。
- [x] **R-6 调额页闭环断裂** —— `3a7644f` 回显用户身份 + 失败时回传审计里的真实原因 + 提交后给详情页链接。
- [x] **R-7（本轮新增，自造）fail-closed 守卫无解封出口** —— `3a7644f`。9a9cd20 的未结清守卫只堵不疏：一条 `reconciliation_required` 会永久挡住该用户的调额，而门户里没有任何入口能结清它，唯一出路是 SSH 改 SQLite。新增 `resolveQuotaAdjustment`（确认已到账/确认未到账，条件更新原子 claim，强制填写核对依据，全程审计），详情页账本行暴露「Reconcile」入口，overview 告警卡片 → 用户列表「待对账」筛选 → 详情页逐行结清，闭环打通。
- [x] **S-18 用户详情页账本看不到 recharge ledger** —— `3a7644f` 并入 `source='recharge'` 并补 source/orderNo 列。

## P2 建议（详情见 report.md 第三节）

> 2026-07-09 全部处置完毕。`[~]` 表示已加缓解但根因待产品决策。

- [x] S-1 侧栏排序按使用频率重排 + 去「模型目录」双层同名嵌套（纯 JSON）
- [x] S-2 后台 overview 首页（运维信号：reconciliation/同步失败/待同步计数）
- [x] S-3 admin 区 `generateMetadata`（页面标题可区分多标签页）
- [x] S-4 no-permission 页补 Header 与返回出口
- [x] S-5 Tabs 组件挂载即 push 历史、tab 不可中键新开
- [x] S-6 models 列表补 分组/折扣/价格同步状态 三列（数据已算好未上列）
- [x] S-7 新建模型渲染分组下拉（groups prop 收了没用）
- [x] S-8 admin 侧 `formatDiscountRate` 中文「X 折」词条化（EN 后台出现中文）
- [x] S-9 能力清空/0 能力保存 = 模型静默下架，无警示
- [~] S-10 「分组折扣」折扣字段对公开定价无效 —— `6452e30` 已加 tip 说明「仅作记录/预留」。**根因未动，待产品决策**：UI 只能产出 `inherit_group` 策略，而该分支不读 `discountRateBps`；`listing_multiplier` 又被价格同步无条件打回 `needs_live_check` 且无路径改回 `matched`。选项：删字段 / 接通计价链路 / 维持提示。
- [x] S-11 字典/模型撞唯一索引未捕获；listings/new 缺隐藏提示；编辑模型抹划线价；models 列表 N+1 无分页
- [x] S-12 邮箱搜索大小写敏感全等 → LIKE + lowercase
- [x] S-13 重试/确认冲突无成功反馈；只读管理员应隐藏写按钮
- [x] S-14 `translateStatus` 死防线：缺键渲染键路径
- [x] S-15 —— `a76b6c7`。**评审的修法是错的**：零角色是普通用户的常态（本地 13 用户仅 2 个有角色），补 `min(1)` 会让「把管理员降级回普通用户」与「保存普通用户的角色页」直接失败。红星本身才是谎言，已移除 `required` 标记；自锁风险由 edit-roles 的警告横幅承担。
- [x] S-16 筛选 pill 无激活态/清除入口；角色列 N+1
- [x] S-17 「未初始化」与同步失败态混淆；usage 错误提示永不出现
- [x] S-19 用户列表 ID 列占宽挤出右侧列；models 操作列在视口外（截断 UUID / 固定操作列）
- [x] S-20 死代码清理：form-card 桩、brand.description、t.raw 就地突变、posts/categories 死权限、apikeys/grant_credits 死词条
- [x] S-21 A11y：header button>a、main-header a>button 无效嵌套
- [x] S-22a 只读管理员的设置表单已禁用提交并给只读提示 —— `a76b6c7`。
- [ ] S-22b 设置字段标题/tip 单语（后台单语的既成立场，仅记录，不催修）。
- [ ] **S-22c Initial Credits 是死轨，界面许诺了不存在的功能（待产品决策）**：设置页「通用」tab 的 `initial_credits_*` 接在注册流程上（`core/auth/config.ts` → `grantCreditsForNewUser` → `models/credit.ts`），发的是 ShipAny 模板自带的 credits；而 APIPool 的真实余额是 New API quota。两本账完全独立，credit 表**无任何消费方**（grep 实证）。管理员打开它、填 10，用户余额仍是 0。选项：摘掉这组配置项 / 彻底清双轨（停写 credit 表 + 删死代码）/ 只在字段说明里写清对 API 余额无效。
