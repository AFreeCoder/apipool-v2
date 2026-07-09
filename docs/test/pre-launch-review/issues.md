# 上线前审查遗留清单

- 基线：main @ ede2dc4
- 来源：[report.md](report.md)（2026-07-08 首轮五维度审查 + 2026-07-09 Codex 二次评审 + 作者裁决）
- 口径：本清单与 report.md 的 P0/P1/P2 **完整同步**（非择要），可直接作为扫描升级 feature 的闭环入口。
- 规则：条目被解决/升级时勾掉并回链对应 feature 或提交。

## 上线门禁 · 资损与安全（最高优先）

- [x] **P0-7 checkout metadata 可覆盖 `order_no`/`user_id`，webhook 不校验 session 归属与金额** —— 2026-07-09 已修复，回链提交 `dbc4b25 fix(payment): reject client-supplied checkout metadata (P0-7)`。移除 `CheckoutRequestBody.metadata` 入参（metadata 全部服务端构造）+ 新增 `assertPaymentSessionMatchesOrder` 纵深防御（仅拒绝「实付+折扣 < 订单金额」，且仅校验支付成功的 session）。**遗留**：webhook 守卫未跑真实 Stripe 回调，须在测试模式充值时复验（见下人工检查项）；`themes/default/blocks/pricing.tsx` 仍在发送已被忽略的 affiliate metadata，若复活该 block 需重新接线。
- [x] **P0-1 充值歧义失败标 pending 可重试，可能重复加额或产生对账缺口** —— 2026-07-09 已修复，回链提交 `a64d39e fix(recharge): never auto-retry once a redemption code exists (P0-1, P1-1)`。**未采用**原设想的「建码前先查同名码」——New API 无实测过的兑换码检索端点（docs/04 只验证过 `POST /api/redemption/`），不臆造端点。改为：码值在发出兑换请求前经 `onRedemptionCreated` 回调落库，此后任何失败（含进程被杀）一律转 `reconciliation_required`；claim 谓词加 `newapiChangeId IS NULL` 作为全局不变量。docs/06 §5 已同步改写。
- [x] **P1-1↑（升为门禁）ledger 卡 `processing` 无任何恢复路径** —— 2026-07-09 已修复，同提交 `a64d39e`。processing 超时 5 分钟且**未带码值**的行可安全重夺重试（远端未发生任何事）；**带码值**的升级 `reconciliation_required` 人工核对；仍在执行的新鲜 processing 行照旧返回 `pending_retry`。
- [x] **P0-2 New API 管理后台公网可达** —— 2026-07-09 已修复，回链提交 `0e4be8d fix(deploy): stop exposing the New API operator surface publicly (P0-2)`。api2 只放行 `/v1*` 其余 404；newapi 加 IP 白名单 + Basic Auth（可叠加）；`configure-caddy.sh` fail-closed（两种保护都没配则退出 78）；新增 `--print-config` 干跑模式使配置生成逻辑可被测试真实执行；`server-bootstrap.sh` 调用前载入 `.env.deploy`。**遗留**：本地无 caddy，Caddyfile 语法由部署时 `caddy validate` 把关；**上线后必须按 runbook 第 2 节实测三子域可达面**（见下人工检查项）。

## 已知残留（P0-1 修复后的边界，非阻塞）

- [ ] **孤儿兑换码**：`POST /api/redemption/` 超时且远端实际已创建时，重试会在 New API 留下一张未兑换的兑换码（面值 = 充值额，码值已丢失，仅管理后台可见，需管理员才能兑换）。不影响用户余额。New API 无兑换码检索接口，无法自动清理——上线后按确定性名称 `r + sha256("recharge:" + orderNo)[0:18]` 人工巡检。详见 `docs/06-payments-ledger.md` 第 5 节。

## 上线门禁 · 计费一致性

- [x] **P0-3 分组重映射 `newapiGroup` 后公开价仍用旧倍率，与实际计费不一致** —— 2026-07-09 已修复，回链提交 `2ed9cc0 fix(catalog): invalidate cached group pricing on New API remap (P0-3)`。`updateGroup` 检测到映射变化时，在同一事务里清空倍率三字段 + 置 `pricingSyncStatus='unknown'` + 该组 listing drift 打回 `needs_live_check`，公开价隐藏为「—」直到重跑价格同步。只改名称/排序不触发失效。

## 上线门禁 · 对外功能硬伤

- [x] **P0-4 文档搜索指向不存在的 `/api/docs/search`** —— 2026-07-09 已修复，回链提交 `75e675e feat(docs): serve the docs search API the layout already points at (P0-4)`。新增 `src/app/api/docs/search/route.ts`（`createFromSource(docsSource)`）+ 引入 `@orama/tokenizers` 给 zh 挂 mandarin 分词器（orama 内置分词器不支持中文，否则整句成一个 token = 搜不到）。**已 live 复验**：接口 200；en 查 "API key" 命中高亮；zh 查「模型」9 条、「快速接入」1 条。
- [x] **P0-6 英文 /models 页折扣标签硬编码中文「X 折」** —— 2026-07-09 已修复，回链提交 `ca16f71 fix(catalog): localize the discount label on the public models page (P0-6)`。`pricePresentation` 改为只回传结构化 `discountBps`，页面按 locale 渲染。**已 live 复验**（五折夹具）：EN 显示 `50% off`，ZH 显示 `5 折 (50%)`。**遗留**：admin 侧仍用 `formatDiscountRate`（后台单语，非本次范围）。

## 发布门禁 · 品牌资产

- [x] **P0-5↓ 全站无 favicon** —— 2026-07-09 已修复，回链提交 `d4daa72 feat(brand): ship a favicon so the browser tab carries the brand (P0-5)`。用 App Router 文件约定补 `src/app/icon.svg`（品牌绿 #216d51 终端提示符）+ `apple-icon.png`。**已 live 复验**：head 注入 `rel="icon"` 与 `rel="apple-touch-icon"`，两个资源均 200。**遗留**：这是占位品牌资源，正式设计到位后替换。
- [x] P1-17 无 OG / Twitter 分享图 —— 已修复（`36ca198`）：public/og.png + seo.ts DEFAULT_PREVIEW_IMAGE。**不能用 opengraph-image 文件约定**——[locale]/layout 的 generateMetadata 定义了 openGraph 会整体覆盖它（实测证实）
- [ ] 正式 logo（当前仍缺品牌资源）

## P1 高性价比

### 支付

- [x] P1-2 未知 webhook 事件返回 500——**三个 provider 均有此问题**（`stripe.ts:359-373`、`paypal.ts:782`、`creem.ts:317`）。统一策略：验签失败仍拒绝；验签通过但业务不处理的事件返回 200 skip。 —— 已修复（`532f507`）：三个 provider 统一用 UnhandledPaymentEventError 哨兵，验签通过但不处理的事件回 200 skip；验签失败仍 500
- [x] P1-3 PayPal sandbox 放行无签名 webhook——**条件升级**：若上线启用 PayPal 则升 P0；保持 `paypal_enabled=false` 则 P1 + 人工检查项充分。 —— 已修复（`532f507`）：改为运行时环境（isProductionRuntime）一票否决，配置项只能收紧不能放松

### 模型目录与定价

- [x] P1-4 未配置映射的分组进建 Key 下拉、提交必失败——修复不能只判 `newapiGroup != ''`，还须要求远端组存在且 pricing sync 状态可信 —— 已修复（`29f29a7`）：加 `newapiGroup != ''` + 排除 `missing_remote_group`；`unknown` 必须放行，否则上线当天没人能建 Key
- [x] P1-5 smokeTested 开关被 ede2dc4 移除，新模型进不了 smoke 候选 —— 已修复（`29f29a7`）：新建/编辑两个 listing 表单恢复开关；两条固化该缺陷的测试已改写
- [x] P1-6 /models 低价模型 `toFixed(2)` 误差 ±7% —— 已修复（`29f29a7`）：改最少两位、最多四位有效小数
- [x] P1-7 模型保存即把公开价打回隐藏且无提示 —— 已修复（`29f29a7`）：成功消息附加「需运行价格同步」
- [x] P1-8 新增分组折扣撞唯一索引报原始 SQLite 错误 —— 已修复（`29f29a7`）：捕获 uniq_listing_model_group，抛已翻译提示

### 控制台体验

- [x] P1-9 桥接失败余额显示 $0.00 并误弹"余额不足"（balanceUsd 应保持 undefined） —— 已修复（`8cecd4b`）：按 status 区分：failed/stale → undefined（显示「—」不告警）；empty 是新用户，$0 + 提示充值是正确的
- [x] P1-10 删除 API Key 无二次确认 —— 已修复（`8cecd4b`）：用既有 Radix Dialog，清理态与删除态文案分开
- [x] P1-11 dashboard 路由缺 `loading.tsx` / `error.tsx`——注：overview/billing 已用 `Promise.all`，问题是缺加载/错误边界，慢远端调用仍会白屏或落默认英文错误页 —— 已修复（`8cecd4b`）：骨架屏 + 双语 error.tsx
- [x] P1-12 缺 `[locale]/not-found.tsx`，404 为无导航的裸英文页 —— 已修复（`8cecd4b`）：SiteShell + 双语 404
- [x] P1-13 未登录进控制台，登录后丢回首页（callbackUrl 不透传） —— 已修复（`8cecd4b`）：用中间件的 x-pathname 透传实际子路径；**顺带修复开放重定向**（`//evil.com` 通过旧 safeInternalPath）
- [x] P1-14 登录/注册/验证邮箱 toast 硬编码英文 —— 已修复（`1b5e8b5`）：五个组件接入 common.sign，加守卫测试禁止再出现
- [x] P1-15 桥接/业务错误英文覆盖 zh 词条（应错误码化，与 P1-14 一并改造） —— 已修复（`1b5e8b5`）：getPublicUsageSyncErrorMessage 内部错误返回 undefined，展示权交回 i18n；四条固化英文兜底的测试已改写

### SEO 与安全加固

- [x] P1-16 /models canonical 指向站点根、无页面级 metadata —— 已修复（`36ca198`）：generateMetadata + en/zh metadata 词条
- [ ] P1-18 `is-email-verified` 匿名可探测 —— **已撤销修复，维持原状（2026-07-09）**。曾加过按 IP 限流（`36ca198`），复查发现得不偿失：该端点由 verify-email 页的「继续」按钮触发（用户点击，非轮询），而 429 响应体没有 `data` 字段，客户端读 `json.data.emailVerified` 得到 undefined → 向**已验证**的用户提示「邮箱尚未验证」。另外限流键依赖 `x-forwarded-for`，该头缺失时所有匿名请求共用同一个每秒一次的桶。泄漏面本就很窄（不存在与未验证同返 false），不值得为此换一条误导真实用户的假消息。**若要防枚举**：在 Caddy 边缘按 IP 限流（不进业务逻辑），或先让客户端正确处理 429。**注**：这条发现来自本次审查自身的安全 agent，并非产品需求或外部安全要求。
- [x] P1-19 checkout 等敏感路由无速率限制（Caddy 边缘亦无兜底） —— 已修复（`36ca198`）：checkout 加 2s 最小间隔

## P2 建议

### 资金链路防御纵深

- [ ] 管理员负向调额是 read-modify-write 覆盖，窗口期内用户消费会被抹回 —— **未做**：改为「负数兑换」或全量字段 PUT 都需要真实 New API 验证（docs/04 警告只传部分字段会触发校验问题）。本地无实例，盲改会打断现有可用的调额功能。**阻塞于线上验证**。
- [ ] 负向调额 PUT 仅发 `{id, quota}`，与 docs/04:67 契约警告矛盾（待验证远端行为） —— **未做**：同上，需真实 New API 验证远端行为后再动。
- [ ] 对账盲区：`creditsAmount<=0` 过滤会让漏配 credits 的订单静默消失 —— **未做**：当前 6 个套餐 + custom 均配置正确，属埋雷而非现行故障。
- [ ] 对账 LIMIT 100 会让老差异滑出窗口 —— **未做**：同上，与对账界面一并处理更合适。
- [x] `resolveTopUpCheckout` 未拒绝非 one-time interval（订阅暗门：续费只发 ShipAny credits、quota 不加） —— 已修复（`532f507`）：显式断言拒绝
- [ ] ShipAny credits 双轨残留：每单仍写无人消费的 credit 表 —— **未做**：credit 表每单仍写入但无人消费。停写需确认 ShipAny 模板其余路径不依赖它；订阅暗门（真正的风险）已在 532f507 封死。
- [x] 支付取消/失败落地 `/pricing`（→ redirect /models），脱离上下文且无提示 —— 已修复（`532f507`）：改跳 /dashboard/billing?checkout=canceled|failed，账单页双语提示
- [x] `adjust-quota` 金额未限整数、无上限（10.5 会破坏 amountUsd 整型约定） —— 已修复（`532f507`）：整数美元 + 单笔 10 万上限
- [ ] 管理员减额无二次确认
- [ ] 补偿三件套（retry/reconciliation）只有 API 无界面；admin 无订单列表可查 orderNo —— **未做**：需新建 admin 页面，属功能开发。**上线前的替代方案**：`reconciliation_required` 接告警 + curl 调用现有 API。
- [x] Creem webhook 签名用 `!==` 比较，应换 `crypto.timingSafeEqual` —— 已修复（`532f507`）：改 timingSafeEqual

### 控制台与交互

- [ ] dashboard SSR 无新鲜度短路，连续导航重复触发远端同步 —— **未做**：需要缓存策略设计（多久算新鲜、与 revalidate 如何配合），改动面比看起来大。
- [ ] key 状态同步每次列表都写库（应仅在字段变化时写） —— **未做**：与上一条同属 dashboard 同步策略，一并处理。
- [ ] Key 禁用后无法在门户重新启用（New API 契约支持 `status_only`） —— **未做**：需真实 New API 验证 `PUT /api/token/?status_only=true` 的行为（docs/04 有记载但未实测）。
- [ ] 复制掩码 Key 按钮易误导（掩码含 `****` 无实际用途） —— **未做**：需产品决策——去掉按钮，还是改成「复制 Key ID」。
- [ ] 掩码格式在首次状态同步后变化（本地 `sk-x****` → 远端格式） —— **未做**：与上一条一并处理。
- [ ] admin 用户详情页隐式触发 lazy provision，为未用过 API 的用户创建 New API 账号 —— **未做**：改动本身简单（binding 不存在时返回空视图），但会改变 admin 查看用户详情的既有行为，建议与 admin 页面批次一起做并人工走查。
- [ ] 忘记密码入口被注释，邮箱登录无自助找回路径 —— **未做**：接 better-auth reset-password 需要 Resend 密钥与邮件模板，属外部依赖。
- [x] 服务端 `toLocaleString()` 裸调，格式/时区跟随服务器而非用户 —— 已修复（`29d121b`）：按页面 locale 格式化并固定 UTC，账单/用量/日志口径一致

### 目录与 admin

- [x] 模型无能力标签时在公开页/建 Key 候选中静默消失 —— 已修复（`29f29a7`）：setModelCapabilities 事务化，insert 失败不再清空能力
- [ ] 分组列表不展示 ratio / pricingSyncStatus（加两列可降低 P0-3 误操作概率） —— **未做**：admin 列表加两列，纯增强。
- [ ] 字典删除被阻止时不展示引用明细（service 已算好 label+count，delete 页吞掉） —— **未做**：service 已算好 label+count，delete 页透传即可，纯增强。
- [x] `setModelCapabilities` / `setModelCategories` 非事务 delete+insert，insert 失败会清空能力 —— 已修复（`29f29a7`）：包进 db().transaction
- [x] `deleteModel` 漏删 `catalog_model_price`，依赖 FK cascade 而 FK 运行时开关未验证 —— 已修复（`29f29a7`）：事务内显式删除；**并实证 OQ-1**：libsql 默认 PRAGMA foreign_keys=1，cascade 本就生效
- [x] 无折扣 listing 经模型编辑后 `discountRateBps` null→10000 脏写（`models/[id]/edit/page.tsx:215` 的 `|| '10'` 默认值） —— 已修复（`29f29a7`）：去掉 `|| '10'` 默认值
- [ ] DB 驱动文案单语：模型描述、折扣备注直接透出录入语言 —— **未做**：模型描述与折扣备注需要双语字段 + 迁移 + admin 表单改造，属功能而非缺陷修复。
- [ ] smoke 脚本 `quotaSpendFromUsageLogs` 未防负数（仅影响对账误报） —— **未做**：仅影响 smoke 对账误报，不影响计费。

### 站点结构 / 视觉 / SEO

- [x] zh 法律术语不一致：页脚「服务条款」vs 正文/注册页「用户协议」 —— 已修复（`29d121b`）：页脚统一为「用户协议」
- [x] hreflang alternate 恒指首页，不含当前路径 —— 已修复（`36ca198`）：删手写 head，改 metadata alternates.languages
- [x] `sitemap.xml` 静态且已过期（lastmod 全 2026-05-24，仅 6 URL） —— 已修复（`36ca198`）：改 src/app/sitemap.ts 动态生成（静态文件会遮蔽该路由）
- [ ] 法律页被 robots disallow（确认是否有意） —— **未做（需产品决策）**：`getRobotsDisallowRules` 里是显式硬编码，随 MVP 大提交进来、无任何理由记录。允许收录更利于信任，但这是 SEO/法务取舍，不是缺陷。
- [x] 文档站顶部导航无回主站/控制台入口 —— 已修复（`29d121b`）：补 Models / Console
- [x] 签退状态首屏两个 primary 实心按钮，违反 docs/05 §5「每屏主按钮 ≤1」 —— 已修复（`29d121b`）：header Sign In 降为 outline
- [x] 规范外颜色：BalanceWarning 用 amber、首页 vignette 用 emerald/teal 渐变 —— 已修复（`29d121b`）：amber → --chart-3；首页渐变 → primary 透明度阶梯
- [ ] 死翻译资产与 `localeMessagesPaths` 漂移（landing / activity/* / ai/* 等永不加载） —— **未做**：清理死 JSON 与模板块有回归风险（themes/default 里多个 block 引用它们），建议单独一批做并跑 build。
- [x] `getAllConfigs()`（含全部密钥）直接喂 root layout 的 ads/analytics 服务，属"改一行就出事"的脆弱面 —— 已修复（`29d121b`）：改 getScriptInjectionConfigs() 白名单
- [x] admin settings 的 `collectNonEmptyConfigs` 跳过空值，配置项无法从 UI 清空 —— 已修复（`29d121b`）：非密钥字段空值 = 清空；**密钥字段仍跳过**——它们渲染为空白，否则每次保存都抹掉已存密钥

## 上线前人工检查（非代码）

- [x] **Caddy 边界：New API 管理面暴露** —— 2026-07-09 owner 决策：**不在 Caddy 层保护 newapi 子域**。New API 在 Cloudflare 后面，IP 白名单不可用（`remote_ip` 是 CF 边缘 IP）；owner 判断该管理后台不需要额外门禁。`configure-caddy.sh` 保留默认 fail-closed，通过显式开关 `APIPOOL_NEWAPI_ALLOW_UNPROTECTED=true` 退出（`d160558` 之后新增）。**残留风险（已知情接受）**：管理后台公网可达，管理接口仅由 New API 自身 root 登录保护；如需加固可在 Cloudflare 层（WAF/Access）做。api2 仍只放行 `/v1*`，此项不受影响。
- [ ] `/opt/apipool-v2/.env.deploy` 权限 600、密钥真随机、GHCR 仓库 private
- [ ] New API root 密码强度、`payment_compliance` 已确认
- [ ] 支付配置：`paypal_enabled=false` 或 `paypal_environment=production` —— P1-3 修复后生产运行时会强制验签，此项降为建议。
- [ ] Stripe dashboard 事件订阅 —— P1-2 修复后**不再是硬性要求**（未知事件回 200 skip），但仍建议只勾选需要的事件以减少噪音。
- [x] Stripe 密钥填 admin settings 并跑一笔测试模式全链路 —— **用户确认线上已配置并跑通（2026-07-09）**。
- [x] **Stripe 测试模式全链路（部署后，含改动的支付路径）** —— **用户 2026-07-09 在已部署的 `e9e3e73` 上人工测试 Stripe 支付成功**。覆盖：checkout（已不收客户端 metadata）→ Stripe 回调 → `assertPaymentSessionMatchesOrder` 金额守卫不误拒全价支付 → recharge 入账 → 余额更新。**折扣码子项标为 N/A**：当前无折扣码，Stripe 侧也未启用折扣逻辑，「实付 < 订单、靠 discountAmount 补差」这一特例不存在，无需覆盖。
- [x] **生产 live smoke 充值到调用闭环** —— 2026-07-09 在 `e9e3e73` 上 `deploy/live-smoke.sh` **12/12 全过**：管理员调额到账（走改动过的 `client.adjustQuota`，真实 New API v1.0.0-rc.20）→ 建 Key（分组 `discount-1`）→ 真实 `/v1` 调用 HTTP 200 → 用量可见 → **价格对账 `result=matched`**（expectedQuota=actualQuota=2405，含缓存 token 场景，验证 P0-6/P1-6 未引入计费偏差）→ 禁用 Key → 调用被拒 401。**未覆盖**：支付 webhook → `recharge.ts` 那条（live smoke 走管理员调额，非 Stripe webhook），该路径由上一条用户人工 Stripe 测试覆盖。
- [ ] 告警三条（webhook 失败 / ledger pending 超时 / bridge unauthorized）接监控或明确接受裸奔——**新增第四条**：`ledger.status = 'reconciliation_required'` 必须告警，P0-1 修复后所有歧义失败都汇入该状态，需人工按 `newapiChangeId` 反查远端兑换状态后手工结清
- [ ] 真实 New API 上复验兑换码**失败窗口**（P0-1）：正常路径已在 live smoke 验过（调额成功入账）；但**兑换请求超时 / 确认查询失败**这条异常路径无法在冒烟里主动触发，仍未实测——届时 ledger 应落 `reconciliation_required` 且带码值、重放不再加额。属难以主动构造的边界，建议接告警后靠真实发生时观测。
- [ ] 备份 restore 演练（`backup.sh` 只备份未演练；`deploy.sh` 明确"数据库不自动回滚"）
- [ ] 域名规划确认（app/api2/newapi 子域 vs apipool.dev 上游站冲突）
- [x] libsql 运行时 `PRAGMA foreign_keys` 实测一次 —— 2026-07-09 实证：`PRAGMA foreign_keys = 1`，插入孤儿行被 `SQLITE_CONSTRAINT_FOREIGNKEY` 拒绝。**OQ-1 关闭**：FK cascade 确实生效。
- [x] ads/analytics/affiliate 若启用，grep 复核其只读公开配置键 —— 已复核（全部为公开分析 ID），并在 `29d121b` 收敛为 `getScriptInjectionConfigs()` 白名单，密钥不再进入调用面。
- [x] P0-4 / P0-5 / P0-6 已起服务 live 复验（2026-07-09）

## 修复过程中新发现并已修复

- [x] **verify-email 开放重定向**（`e14358f`，Codex 第二轮评审 high）：`safeDecodeCallbackUrl` 只判 `decodeURIComponent` 后 `startsWith('/')`，`//evil.com` 与 `%2F%2Fevil.com` 通过后经 `location.assign` 离站（默认 locale 下 `base` 为空串）。上一轮抽出 `safe-path.ts` 时漏了这个副本。新增 `safeDecodedInternalPath` + 守卫测试（禁止任何 auth 界面私藏回跳校验）。
- [x] **`source .env.deploy` 破坏 Caddy 保护配置**（`e14358f`，Codex 第二轮评审 high）：实测 bcrypt 哈希 `$2a$14$...` 被 shell 展开成 `a4`（basic_auth 静默失效），多 IP 白名单第二个 IP 被当命令执行（`set -e` 下中断部署）。改为 `configure-caddy.sh` 按字面量读取；`live-smoke.sh` 仍 source 同一文件，故 env 示例与 runbook 强制单引号并加测试。

- [x] **登录回跳开放重定向**（`8cecd4b`）：`sign-in`/`sign-up` 各自复制的 `safeInternalPath` 只判 `raw.startsWith('/')`，`//evil.com` 是协议相对 URL 会通过；传给客户端组件的 `callbackUrl` 更是完全未净化。已抽出 `src/shared/lib/safe-path.ts` 统一收敛（拒绝 `//host`、`/\host`、控制字符）。审查报告未发现此项。
- [x] **五条固化缺陷的测试**：`without Caddy auth`（P0-2）、checkout metadata 透传断言（P0-7）、`returns zero balance instead of a dash`（P1-9）、`without smoke toggle` + `fields.smokeTested === undefined`（P1-5）、usage sync 英文兜底断言（P1-15）。均已按修复后的正确行为改写。

## 已知遗留复核

- [x] OQ-3 roles/users 4 个 edit handler 缺 requirePermission —— 2026-07-08 复核已修复，回链提交 `0696a79 fix(security): roles/users 写 handler 二次鉴权对齐页首门控（OQ-3）`
- [ ] `ensurePortalUserBinding` 凭据失效不自愈 —— **仍未做**。P1-9 只修了 UI 展示（失败时显示「—」而非 $0.00），自愈（检测 401 自动 reprovision）需真实 New API 验证，维持 defer。
- [x] OQ-1 libsql `PRAGMA foreign_keys` —— 2026-07-09 实证已开启（=1），孤儿行被拒。`deleteModel` 另在 `29f29a7` 补了显式删除，事务自包含。
