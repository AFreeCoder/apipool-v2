# 管理后台上线前审查报告（admin-review）

- 日期：2026-07-09
- 基线：main @ 03a3e76（工作区含本轮修复，未提交）
- 范围：`/admin` 全部约 50 个页面 —— 壳层（布局/侧栏/顶栏）、目录 CRUD（vendors/capabilities/statuses/categories/groups/models/listings）、用户/角色/权限、调额、设置各 tab、后台 API（`/api/apipool/admin/*`）
- 方法：3 个并行只读代码审查 agent（目录 CRUD / 用户与运营 / 壳层与设置）+ 本地起站 Playwright 实走（登录 demo 管理员，桌面 1440 / 移动 375，en+zh，30+ 页截图与 console 采集，证据在 `shots/`）
- 口径：与 `docs/test/pre-launch-review/` 相同 —— P0=上线阻塞（资损/数据破坏/计费口径/鉴权），P1=高性价比修复，P2=结构/视觉/交互建议。已知遗留（pre-launch issues.md 未勾选项）不重复上报，只做复核。
- 闭环入口：[issues.md](issues.md)

另含用户直接要求的一项前台改动：**语言切换按钮独立出来放进站点头部**（参考 APIMart 头部的独立翻译图标），与本次后台修复同批落地。

---

## 一、本轮已修复（16 项，tsc / eslint / 487 tests 全绿，关键项浏览器复验）

### P0（2 项）

**F-1（USR-1）`assignPermissionsToRole` 非事务 delete+insert，可清空角色全部权限**
`src/shared/services/rbac.ts` —— 原实现先 `delete` 后 `insert` 且无事务；任一权限 id 非法（FK 拒绝）或进程中途被杀 → 角色权限归零。若中招的是 admin/super_admin 角色，`requireAdminAccess` 会把**所有管理员**弹出后台，只能 DB 手术恢复。同类缺陷（`setModelCapabilities`）此前已修过一次，RBAC 的爆炸半径更大。修复：与 `assignRolesToUser` 对齐包进 `db().transaction`（页面层本就校验了权限 id 子集，事务补齐后闭环）。

**F-2（CAT-1）编辑模型只把「第一条 listing」打回待核验，其他分组公开价立即按新基准价变动 —— 展示价与实际计费脱钩（P0-3 孪生缺口）**
`src/features/api-catalog/server/catalog-service.ts` `upsertModelAdminConfig` —— 基准价是所有 listing 的共同输入，但保存模型时只有目标 listing 被置 `needs_live_check`；同模型其他分组的 listing 仍是 `matched`，公开页立即展示「新基准价 × 该组倍率」，而 New API 实际计费的 model_ratio 未变。页面注释宣称「会把该模型所有 listing 打回」，与实现不符。修复：事务内先把该模型**全部** listing 置 `needs_live_check` 并清空生效公式，再应用目标 listing 的 patch（hide-until-confirmed 契约与 `updateGroup`/P0-3 修复一致）。

### 用户要求 + 视觉硬伤（2 项）

**F-3 语言切换独立图标按钮进站点头部**（用户要求，参考 APIMart）
`src/features/apipool-ui/site-shell.tsx` + `locale-selector.tsx` —— 上一轮 P0-1 头部重组把语言/主题收进了头像菜单（登录态）和页脚（登出态），语言切换可发现性差。现在头部右侧（lg+）常驻一个独立翻译图标（`Languages` icon，带 aria-label），登出/登录态都可见；<lg 仍走移动抽屉里的语言入口。`LocaleSelector` 增加 `className`/`label` 入参。已截图复验（`shots/v1-home-header.png`）。

**F-4 语言建议横幅在 admin 被 fixed 侧栏遮住只剩半句**
`src/shared/blocks/common/locale-detector.tsx` —— 横幅是文档流内条（为 auth 页修过一次），但 admin 的 shadcn 侧栏 `position: fixed` 从视口顶端铺下来，桌面端把横幅左半段盖住（`shots/03-adjustments.png` 顶部可见「…。是否切换?」残句）。修复：横幅在 `/admin` 路径不渲染——后台顶栏本就有显式语言按钮，建议横幅在运营面属于噪音。复验后台无横幅（`shots/v2-admin-no-banner.png`）。

### P1（12 项）

| # | 来源 | 修复 | 文件 |
|---|------|------|------|
| F-5 | USR-2① | 「停用绑定」加确认对话框（说明当前版本停用**不可逆**、会导致该用户后续充值失败），确认后 `router.refresh()` 刷新页面状态；新增通用 `ConfirmActionButton` 组件 | `users/[id]/detail/page.tsx`、`shared/blocks/common/confirm-action-button.tsx`、`admin/users.json` en/zh |
| F-6 | CAT-3 | 折扣输入双重陷阱：`step:any` 允许 9.5 之类小数折；可选 number 字段留空不再触发 min/max 校验（原来 `Number('')=0 < 0.01` 挡死整个表单，seed 无折扣 listing 连 smokeTested 开关都改不了） | `listings/new`、`listings/[listingId]/edit`、`shared/blocks/form/index.tsx` |
| F-7 | SHL-1 | admin 区补 `loading.tsx`（表格骨架屏）+ 双语 `error.tsx`（保住侧栏壳层，重试/回用户列表出口），对齐 dashboard 已有边界 | `(admin)/admin/{loading,error}.tsx` |
| F-8 | SHL-3 | admin 未登录跳 `/sign-in` 现在带 `callbackUrl`（`x-pathname` + `safeInternalPath` 净化，只回跳 `/admin` 内部），深链登录后不再丢回首页 | `core/rbac/permission.ts` |
| F-9 | SET-1/UI-1 | 5 个硬编码英文成功 toast 词条化：settings/user/roles/permissions 保存（渲染期捕获翻译串，server action 闭包只带可序列化值） | 4 个 admin 页面 + settings 页 + 4 个 json |
| F-10 | SET-2a | auth 设置 tab 两个一模一样的「Auth Enabled」开关改名为 Email/Google/GitHub Auth Enabled + Google One Tap Enabled，消除误开风险 | `shared/services/settings.ts` |
| F-11 | SET-3 | 移除「AI」设置 tab —— 其 9 个密钥字段喂给全仓零引用的死服务 `shared/services/ai.ts`，在卖 AI API 的产品后台里是高危误导（管理员会把真实密钥存进永不生效的配置） | `shared/services/settings.ts` |
| F-12 | NAV-1 | 侧栏子菜单高亮 `endsWith` → `startsWith`：进详情/编辑页不再丢失激活态 | `shared/blocks/dashboard/nav.tsx` |
| F-13 | USR-4①/MISC-1 | 列表搜索重置 `page` 参数（原来第 2 页搜索必得空列表，像搜索坏了） | `shared/blocks/dashboard/search.tsx` |
| F-14 | IA-2 | 侧栏「设置」组补 通用/支付 两个入口（Stripe 密钥是已确认线上在用的最高频设置，原来只能从 认证/邮箱 进去再横切 tab） | `en,zh/admin/sidebar.json` |
| F-15 | FOOT-1 | 删掉侧栏页脚指向 `apipool.dev` 的假「推特」链接 | `en,zh/admin/sidebar.json` |
| F-16 | CLEAN-1 部分 | 删除表单提交时逐字段打印的 `console.log` | `shared/blocks/form/index.tsx` |

---

## 一·五、Codex 对抗式评审复盘（2026-07-09，`--base 03a3e76`）

R-1/R-2/R-3 提交后跑了一轮 Codex 对抗式评审，判 `needs-attention`，三条 high 经逐条读码**全部成立，无一驳回**。其中两条直接推翻了本文档此前的结论，已修复并补测试。

### R-1 复盘：写了证据，却没有人读它

`5537976` 声称闭合了调额的双倍到账窗口，**这是过度声称**。它确实在远端副作用前落了 `remoteAttemptAt`、在兑换请求发出前预落了码值，但**全代码库没有任何一处读取这两个标记**：

- `manual_adjustment` 行没有 claim、没有 TTL、没有重夺（`recharge.ts` 的 claim 谓词按 orderNo 走另一条路）；
- 没有「该用户存在未决调额则拒绝新建」的服务端守卫；
- `quota-adjustment-form.tsx` 的幂等键只活在内存 ref 里，**一收到响应就 `requestDraftRef.current = null`**，页面刷新更是直接丢失。

于是根本不需要进程崩溃：任何返回了响应的失败之后，管理员再次提交就是新键 → 新 ledger 行 → 第二次远端写。负向调额更直接——`PUT /api/user/` 已生效但响应超时时，`remoteAdjusted=false`、无兑换回调、不满足 `isQuotaAdjustmentReconciliationError`，落终态 `failed`，重试重新读到已扣减余额后**再扣一次**。

**真正的修法（`9a9cd20`）**：把不变量搬到服务端。① 新增未结清守卫（pending/processing/reconciliation_required 存在即拒绝新调额，抛 `UnresolvedQuotaAdjustmentError`）；② 「判定 + 插入 pending 行」放进同一事务，并发提交不会双双通过；③ 只有陈旧且 `remoteAttemptAt`/`newapiChangeId` 皆为 null 的行可回收为 `failed`；④ 负向路径新增 `onQuotaWriteDispatched`，PUT 发出前置标记，响应丢失一律升级 `reconciliation_required`。

**教训（同一个错误的第三次变体）**：`docs/test/pre-launch-review/issues.md` 已经记过「把『我没记下证据』当成『事情没发生』」。这次进了一步又退了一步——证据记下了，**却没有任何消费者**。**落一个持久化标记只是修复的一半，另一半是让某条判定路径真的去读它**；修复完成的判据不是「标记写了」，而是「存在一条会因这个标记而改变行为的代码路径，且有测试覆盖」。

另一个连带教训：守卫的错误消息里写了 "New API"，命中 `INTERNAL_ERROR_PATTERNS` 被 `getPublicPortalErrorMessage` 整条替换成「稍后重试」——管理员根本看不到阻塞原因。**面向管理员的错误必须实测它能穿过脱敏层**，已加测试锁死。

### Finding 1 复盘：server action 的实参不是可信输入

`shared/blocks/form/index.tsx` 是客户端组件，`submit.handler(formData, passby)` 把 `passby` 作为 server action 的**实参**回传。它不是闭包变量，Next.js 不加密不签名，因此完全由客户端控制。catalog 后台 13 个页面把 passby 里的记录快照直接当作写入目标与写入值。最锋利的一处是 listing 编辑：伪造 `pricePolicy='listing_multiplier'` + `discountFold=0.01`，而 `updateListing` 从不重置 `priceDriftStatus`，公开页立刻按基准价 0.1% 展示，New API 仍按分组倍率计费——正是 P0-3 与 F-2 视为上线门禁的同一条不变量。需要 `CATALOG_WRITE` 权限，故非越权，而是**特权管理员绕过安全阀**；无恶意的过期页面同样会写回陈旧快照。

**修法**：catalog mutation 一律在 action 内按路由参数重查记录并校验归属，`passby` 全部删除（守卫测试禁止其再出现）；listing 编辑只写表单拥有的字段，`pricePolicy`/`featured`/`sortOrder` 不进 patch；折扣在 `listing_multiplier` 策略下变更时强制 `needs_live_check`。

### Finding 3 复盘：check-then-act 与「谁的决定更晚」

`restoreNewapiUserBindingForAdmin` 先读到 `disabled` 再按 id 无条件写 `provisioning`，无 CAS；`ensurePortalUserBinding` 的成功/失败写回也都按 id 无条件覆盖状态。并发停用会被在途恢复静默撤销。已改为条件更新原子 claim，并在成功与失败两条写回路径都加 `status != 'disabled'` 守卫。**踩坑**：只给成功路径加守卫时，我抛出的 forbidden 落进了 provision 的 catch，那个 catch 同样无条件写状态，把 `disabled` 改写成了 `username_sync_failed`——测试当场抓住。**状态机的每一条写回路径都要守同一个不变量，只堵 happy path 等于没堵。**

### 第 4 条（lodash 4.18.0 override）
来自另一条工作线的提交 `11809e9`（已确认无问题并推送），不在本轮范围，未复核。

### 本文档同步修正
- F-5 的停用确认文案曾写「停用不可逆、没有恢复入口」，R-3 加了恢复按钮后该文案即成假话（Codex 未报，自查发现），已订正为「可撤销」。
- 上一版把 R-1 记为「已修复」是错误的，`issues.md` 已撤回该勾选。

## 二、遗留必修（上线前建议完成，按优先级）

### R-1（P1↑，资金链路）管理员正向调额未接 P0-1 同款防线，崩溃窗口可致双倍到账
`portal.ts:2372-2378` 调 `client.adjustQuota` 没传 `onRedemptionCreated`、也不写 `remoteAttemptAt`（对比充值路径 `recharge.ts:190-208` 两个持久化证据齐全）。「兑换码已创建 → ledger 落库前」进程被杀（滚动部署/OOM）→ 行卡 `pending` 无码值；表单幂等键只在内存（`quota-adjustment-form.tsx:37-50`），管理员刷新重试 = 新 ledger 行 = 第二张码，若第一次实际成功即双倍到账。`manual_adjustment` 行不在充值补偿三件套覆盖内，无 TTL 重夺、无 reconciliation 升级。
**修法**：照抄 recharge.ts 把 `onRedemptionCreated`（码值预落库）+ `remoteAttemptAt`（远端副作用前落标记）接进 `adjustPortalQuota`，约 20 行。**资金链路，建议按 P0-1 批次的 TDD 流程做**，故本轮未顺手改。

### R-2（P1，系统性）生产环境所有 admin 表单的已翻译业务错误会被 Next.js 脱敏成通用英文
全部约 15 个 catalog handler（另含部分 users/settings 路径）用 `throw new Error(已翻译文案)` 传业务错误，客户端 `toast.error(err.message)` 展示。production 下 server action 抛错一律被替换为 "An error occurred in the Server Components render..."——删除保护、重复售卖项、无效价格的精心翻译**在线上全部不可见**；这也意味着 pre-launch **P1-8 的修复在生产实际无效**（dev 验收会误判）。
**修法**：Form 块已支持 `{status:'error', message}` 渲染（`blocks/form/index.tsx:304-310`），把 handler 的 `throw` 改为 `return {status:'error', message}`（鉴权异常仍 throw）。约 12 个文件的机械改造，动作统一但面广，建议单独一批做完并配守卫测试。

### R-3（P1）「停用绑定」仍无恢复路径（F-5 只挡住了误触）
全代码库没有把 `disabled` 翻回 `active` 的入口：详情页「重试」走 `ensurePortalUserBinding` 对 disabled 直接抛错（`portal.ts:602-607`）。被停用户此后充值 → `forbidden` → ledger 落**终态 failed**（钱收了额度加不上）。
**修法**：给 disabled 增加管理员显式恢复动作（`status` 翻回 `provisioning` 再走 retry），改动集中在 `admin-user-binding-actions.ts` + 详情页一个按钮；涉及远端语义，建议配真实 New API 验证。

### R-4（P1）admin 用户编辑页头像上传必失败，失败后提交还会清空既有头像
上传端点已被 MVP 禁用（`api/storage/upload-image/route.ts` 恒 404），`ImageUploader` 失败时把表单值置 `''`，提交即 `updateUser({image:''})` 抹掉原头像。**修法**：MVP 期从编辑表单移除该字段（约 5 行）。

### R-5（P1）`/admin` 落点与面包屑硬绑最高危权限
`admin/page.tsx` 无条件 redirect 到调额页（要求 `APIPOOL_QUOTA_ADJUST`）；39 处面包屑「管理后台」与侧栏品牌链接都指向 `/admin`。seed 的 viewer/editor 角色有 `admin.access` 但无调额权限——进后台第一屏就是 no-permission，点面包屑也被弹走；且调额页面包屑「管理后台」→ `/admin` → 又跳回本页（自环）。
**修法**：`/admin` 改为按权限探测跳第一个可达页（或做轻量 overview，见 S-2）；上线初期若只有 super_admin 一个角色在用，可暂缓。

### R-6（P1）调额页闭环断裂
失败只显示英文 `failed` 不给原因（真实原因如「扣减会使余额为负」只进了审计表）；从用户列表带 `?portalUserId=` 直达时不回显用户姓名/邮箱（只有裸 UUID，管理员无法确认调的是谁）；成功后无指向用户详情页（调额历史所在地）的链接。合计 ≤50 行。

---

## 三、遗留建议（P2，不阻塞上线）

**信息架构 / 导航**
- S-1 侧栏排序与双层同名嵌套：高频（调额/用户/模型）排在低频（角色/权限）之后；「模型目录」组下又套同名可折叠项。建议顺序：运营（调额/用户）→ 模型目录（模型/分组/字典折叠）→ 系统（设置/权限）。纯 sidebar.json 改动。
- S-2 后台无 overview 首页：无处一眼看到 `reconciliation_required` 笔数 / 同步失败用户数 / 待同步 listing 数（查询能力都已存在）。与 R-5 一并做最合算。
- S-3 全后台共用站点默认 `<title>`，多标签页工作无法区分；admin layout 加一个 `generateMetadata` 即有低成本改善。
- S-4 no-permission 页是死胡同：无返回链接，admin 版无 Header，移动端连侧栏都打不开。
- S-5 Tabs 组件挂载即 `router.push` 当前 URL（back 要按两次），tab 不是链接不能中键新开（`shared/blocks/common/tabs.tsx:23-37`）。

**目录 CRUD**
- S-6（CAT-5）models 列表算好了「分组/折扣/价格同步状态」三列数据却没注册进表格——运营看不到某模型正处于 `needs_live_check`（公开页显示「—」）。补 3 列约 15 行，**建议随 R-2 批次一起做，性价比最高**。
- S-7（CAT-6）新建模型无法选分组：表单收了 `groups` prop 但从不渲染，listing 固定落 sortOrder 最小的分组；想去别的分组要「新建→listings/new→删默认」三步。
- S-8（CAT-4）admin 侧 `formatDiscountRate` 硬编码中文「X 折」，EN 后台 Group Discounts 列表出现中文。照抄 P0-6 方案：服务层回传 `discountBps`，页面按 locale 词条渲染。
- S-9（CAT-8）能力清空即静默下架：0 能力保存成功无警示，模型从公开页与建 Key 候选消失。最便宜修法：成功文案追加警示或要求 ≥1。
- S-10（CAT-9）「分组折扣」的折扣字段对公开定价完全无效（`inherit_group` 不读 `discountRateBps`，`listing_multiplier` 又永远过不了核验）——界面许诺了不存在的功能。短期给字段加 tip 说明「仅作记录」，中期产品决策删字段或接通核验链路。
- S-11（CAT-7）字典 slug/模型 modelId 撞唯一索引未捕获（随 R-2 一并加 UNIQUE 捕获）；（P2-1）listings/new 缺「价格同步前隐藏」提示；（P2-4）编辑模型会静默抹掉划线价字段（当前无写入口，影响≈0）；（P2-5）models 列表 N+1 且无分页/搜索，模型到三位数前需处理。

**用户 / 运营**
- S-12（USR-4②）邮箱搜索是大小写敏感全等匹配（`eq(user.email)`），输 `User@Example.com` 一律「未找到」；建议 LIKE 模糊 + lowercase（调额页 lookup 同源）。
- S-13（USR-5 余量）「重试/确认冲突」两个绑定操作仍无成功反馈、失败落 error 边界（F-7 兜底后不再是裸英文页，但体验仍糙）；只读管理员看得到按钮点了才报错——无 `USERS_WRITE` 时应隐藏。
- S-14（UI-2）`translateStatus` 的 try/catch 是死防线：next-intl 缺键不抛错而是渲染完整键路径；当前枚举恰好齐全，新增状态即踩雷。
- S-15（UI-3）checkbox `required` 校验不生效（恒 `z.array` 无 `min(1)`），edit-roles/edit-permissions 可提交空数组清空角色/权限；管理员编辑自己并取消 admin 角色即自锁。
- S-16（UI-5）用户列表筛选 pill 无激活态、无清除入口；角色列 N+1（30 行=30 查询）。
- S-17（UI-6）详情页「余额未初始化」与同步失败态混淆；`getPortalUsage` 吞掉一切异常导致 usage 错误提示永不出现。
- S-18 用户详情页账本只查 `manual_adjustment`——用户投诉「付了钱没到账」时管理员在详情页看不到 recharge ledger（pending/reconciliation_required 均不可见）。低成本过渡：并入 `source='recharge'` 行（约 30 行），**建议升入上线前批次**（来自已知项「补偿三件套无界面」的复核补充）。
- S-19 实走观察：用户列表 ID 列全宽 UUID+复制按钮占约 300px，SYNC 等右侧列被挤出首屏（`shots/02-users-recheck.png`）；models 表在 1440px 下操作列在视口外要横滚才能摸到（`shots/21-zh-catalog-models.png`）。建议 ID 列截断显示（保留复制）、操作列固定或前移。

**杂项清理**
- S-20 死代码/杂音：`dashboard/form-card.tsx` 桩组件；`(admin)/layout.tsx` 给从不渲染的 `brand.description` 赋值、且就地突变 `t.raw()` 返回的共享消息对象（应浅拷贝）；`nav.tsx` `key={item?.title || item?.title}`；posts/categories 死权限仍在权限矩阵展示；`admin/apikeys.json` 与 `grant_credits` 死词条。
- S-21 A11y：`dashboard/header.tsx` button>a、`main-header.tsx` a>button 两处无效嵌套（照抄 table-card 的 asChild 写法）。
- S-22 设置页字段标题/tip 全英文硬编码（后台单语的既成立场，仅记录）；General tab 的 Initial Credits/Role 仍接在注册流程上写 ShipAny credits 死轨，建议清双轨时一并摘除；SEC-1：只读管理员看到可编辑设置表单，保存时才报被脱敏的错。

---

## 四、已知项复核（pre-launch issues.md 口径修正）

- **P1-8「撞唯一索引抛已翻译提示」修复在生产无效**（R-2 实证：masked 文案存在于产物中）——issues.md 已勾选项需要加注。
- **P1-5「smokeTested 开关恢复」被折扣空值陷阱废掉一半**——本轮 F-6 已修，恢复完整可用。
- **「模型无能力静默消失已修复」只修了半条**：事务化解决了 insert 失败误清空；UI 主动清空路径仍在（S-9）。
- **P0-3 修复本身有效**，但同一契约在「编辑模型基准价」路径存在孪生缺口——本轮 F-2 已修。
- 维持原 defer：负向调额 read-modify-write（阻塞于真实 New API 验证）、用户详情页隐式 lazy provision（补充：调额本身也会为无绑定用户建号，属合理前置；详情页只读场景仍建议改空视图）、`ensurePortalUserBinding` 不自愈、对账 `creditsAmount<=0` 过滤与 LIMIT 100。
- **OQ-3 覆盖面复核（好消息）**：users/roles 4 handler、catalog 全部 20 个 mutation 页（每页 3 处 `requirePermission`）、settings handler、调额/绑定 actions、6 个 `/api/apipool/admin/*` route 全部完成「登录→权限」两段校验，**未发现新的漏鉴权入口**。

## 五、确认无问题的方面

- 鉴权：`requireAdminAccess` + 每页 `requirePermission` + server action 内二次鉴权 + API route 双检，全覆盖无缺口。
- 秘密不出服务端：settings 密钥字段 `type='password'` 渲染空白+「已配置」占位（空=不修改的保护机制确认在位）；`publicSettingNames` 白名单；layout 传给客户端的 sidebar 仅品牌字段。
- i18n 基础设施：`localeMessagesPaths` 覆盖 admin 实际引用的全部命名空间；en/zh 16 对 admin JSON 逐 key 零漂移（历史「整区显示 key」无复发）。
- 删除保护：字典按引用计数阻断、group 检查 key binding、model 事务内显式删净五表、全部有确认页。
- 价格输入安全：定点整数换算拒绝负数/非法字符/溢出，无浮点误差。
- 双额度体系混淆已收敛：`grant-credits`/`apikeys` 桩已重定向到调额页，管理员无误入 ShipAny credits 的路径。
- 遗留模板页（posts/categories）均为 redirect 桩且未挂侧栏，与前台策略一致。
- 移动端基础可用：侧栏走 Sheet、表格 `overflow-x-auto`、面包屑窄屏隐藏（`shots/30-mobile-admin-home.png`）。

## 附：证据截图（shots/）

| 文件 | 说明 |
|------|------|
| `03-adjustments.png` | 修复前：桌面端语言横幅被侧栏遮住只剩半句；调额页全貌 |
| `v2-admin-no-banner.png` | 修复后：admin 无横幅，侧栏含 通用/支付 |
| `v1-home-header.png` | 站点头部独立语言图标（参考 APIMart） |
| `v3-disable-confirm.png` | 停用绑定确认对话框 |
| `02-users-recheck.png` | 用户列表：右侧列被挤出首屏、红色徽标密度（S-19） |
| `16-settings-general.png` | 设置页 10 tab 全貌（修复前含 AI 死 tab） |
| `21-zh-catalog-models.png` | zh 模型列表：表格超宽、操作列在视口外（S-19） |
| `17-user-detail.png` | 用户详情页信息架构（评价良好） |
| `30-mobile-admin-home.png` | 375px 移动端后台表现 |
