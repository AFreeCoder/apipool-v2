# APIPool v2 上线前全面审查报告

- 日期：2026-07-08
- 基线：main @ ede2dc4（工作区 clean）
- 方法：5 个维度并行静态代码审查（核心用户链路 / 支付与额度 / 模型目录与定价 / 前端 UI 与站点结构 / 安全与上线就绪），所有 P0 级发现均经二次读码核实；未起服务做 live 走查（2026-06-27 已做过一轮浏览器实测审查并修复）。
- 严重度定义：**P0**＝上线前必须修复（资损 / 安全边界 / 核心页面对外可见的硬伤）；**P1**＝性价比高的小改动（改动小、体验或风险收益明显）；**P2**＝建议项（结构 / 视觉 / 交互 / 债务）。

## 总体结论

核心资金链路（订单乐观锁、ledger 唯一索引幂等、webhook 验签、单位换算）与 i18n 基础（en/zh 46 对 JSON 键 100% 一致）质量高于一般 MVP 水准；`/api/apipool/**` 鉴权与 admin RBAC 全覆盖，占位路由、法律页、compose/entrypoint 防线均验证成立。**上线阻塞项共 6 个 P0**：2 个资损/安全类（充值重复加额窗口、New API 管理面公网裸奔）、1 个计费一致性（分组重映射后展示价与实际计费不符）、3 个对外品牌硬伤（文档搜索 404、favicon 全缺、英文站中文折扣标签）。P1 共 19 项，多数是一处小改动。

---

## P0：上线前必须修复

### P0-1 充值加额的歧义失败被标 pending 可重试，重试生成新兑换码导致双倍到账

- 位置：`src/features/newapi-bridge/server/recharge.ts:165-178`（catch 分流）；`src/features/newapi-bridge/server/client.ts:1485-1499`（adjustQuota）
- 问题：`adjustQuota` 在兑换码**已兑换成功**、确认查询失败时抛 `NewApiQuotaAdjustmentReconciliationError`（code=`remote_error`）。`executeRecharge` 的 catch 只看 `remoteAdjusted` 标志（抛错路径恒为 false）和终态错误码集合（`unauthorized/forbidden/malformed_response`），于是把这条**远端已实际加额**的 ledger 标回 `pending`。`isQuotaAdjustmentReconciliationError` 只在 `portal.ts:2396`（管理员调额路径）被正确处理，recharge.ts 漏掉了同款判定。同理，`POST /api/user/topup` 请求本身超时（远端可能已入账）也以 `timeout` 落 `pending`。
- 失败场景：用户充值 $100 → 兑换码已兑换、quota 已到账 → 确认查询网络抖动 → ledger=pending → 用户刷新支付回跳页（`/api/payment/callback` 对已 paid 订单会再走 `applyApipoolRecharge`）、或 Stripe 重放 webhook、或 admin retry → 重新 claim → **生成新兑换码再兑一次** → 到账 $200。用户自己刷新页面即可触发，无需管理员参与。
- 建议修法：catch 中先判 `isQuotaAdjustmentReconciliationError(error)` → 置 `reconciliation_required` 并落 `error.changeId`（与 portal.ts 同款）；topup 请求发出后的 `timeout`/网络类失败同样归入 `reconciliation_required` 人工核对，不自动重试。可选加固：重试前按确定性兑换码名查远端是否已存在已兑换的码。

### P0-2 New API 管理后台公网可达，"仅放行 /v1"的部署边界假设不成立

- 位置：`deploy/configure-caddy.sh:19-35`
- 问题：生成的 Caddyfile 对 `api2.apipool.dev` 和 `newapi.apipool.dev` 都是无路径限制的 `reverse_proxy 127.0.0.1:3001`，`newapi` 块只有 `X-Robots-Tag: noindex`，**无 Basic Auth、无 IP 白名单**。`docs/07-runbook.md` 第 2 节明确要求运营面"再加一层边界"，实际部署脚本未实现。
- 失败场景：任何公网访问者可直接打开 New API 完整管理后台登录页（root 爆破面 + New API 自身漏洞面），且 `api2` 子域也把 `/api/*` 管理接口一并转发。
- 建议修法：`newapi` 站点加 `basic_auth` +（可选）`remote_ip` 白名单；`api2` 站点用 `handle /v1*` 只放行数据面路径、其余 `respond 404`。修复后上线前实测三个子域的可达面。

### P0-3 分组重映射 newapiGroup 后，公开页继续按旧倍率展示价格，与实际计费不一致

- 位置：`src/app/[locale]/(admin)/admin/catalog/groups/[id]/edit/page.tsx:111-121`（patch 字段）；`src/features/api-catalog/lib/pricing.ts:265-282`（inherit_group 价格 = 基准价 × 缓存 `groupRatioBps`）；`src/features/api-catalog/server/pricing-sync.ts:465`（ratio 仅在手动价格同步时刷新）
- 问题：分组编辑允许改 `newapiGroup`，但 patch 不重置 `newapiGroupRatioBps`/`pricingSyncStatus`，也不把该组 listing 的 `priceDriftStatus` 打回 `needs_live_check`。建 Key/计费立即用新映射（`portal.ts:1367`），展示价却继续用旧倍率且 drift 仍是 `matched`。
- 失败场景：admin 把分组从 ratio 1.0 的 New API 组改映射到 ratio 2.0 的组 → 用户按 /models 页旧价估算，实际扣费翻倍。
- 建议修法：`updateGroup` 检测到 `newapiGroup` 变化时清空 ratio 缓存、置 `pricingSyncStatus='unknown'`、该组 listing drift 置 `needs_live_check`（价格自动变 "—"，符合现有 hide-until-confirmed 策略）。

### P0-4 文档站搜索指向不存在的路由，搜索功能整体 404

- 位置：`src/app/[locale]/(docs)/layout.tsx:47`（`api: '/api/docs/search'`）
- 问题：`src/app/api/` 下无 `docs/` 目录，全仓库无 `createFromSource`/`createSearchAPI` 调用。fumadocs 搜索框默认展示（zh 还译了"搜索内容"），每次查询都 404。
- 建议修法：新建 `src/app/api/docs/search/route.ts` 用 fumadocs `createFromSource(source)` 提供搜索；或在 RootProvider 关闭搜索入口。修复后起服务点一次搜索确认。

### P0-5 全站无任何 favicon，标签页无品牌图标

- 位置：`src/app/layout.tsx:103-105`（`app_favicon` 为空则不渲染 `<link rel="icon">`）；`src/config/index.ts:15`（默认 `''`）；`public/` 与 `src/app/` 下均无 icon 资源，各 env 文件无 `NEXT_PUBLIC_APP_FAVICON`
- 问题：旧模板 logo 已删但未补替代——现在不是"图标待换"，是**没有图标**，`/favicon.ico` 404。
- 建议修法：放一个 `src/app/icon.png`（App Router 约定自动生效），顺带补 `apple-icon`。

### P0-6 英文 /models 页折扣标签硬编码中文「X 折」

- 位置：`src/features/api-catalog/lib/pricing.ts:122`（`` `${…} 折 (${…}%)` ``）→ `pricePresentation.discountLabel` → `src/app/[locale]/(landing)/models/page.tsx:375-379`
- 问题：ede2dc4 引入的折扣标签不走 i18n，EN 页面显示"9 折 (90%)"。分组折扣正是刚上的功能，只要启用即触发，出现在核心营销页。
- 建议修法：`discountLabel` 改回传结构化数据（bps），页面按 locale 格式化（en 用 "10% off" 类表述）。

---

## P1：高性价比优化

### 资金与支付

1. **ledger 卡 `processing` 后无任何恢复路径**——`recharge.ts:51` 的 `CLAIMABLE_RECHARGE_STATUSES` 不含 `processing`；claim 后进程崩溃/滚动部署，该行永远卡死，webhook 重放与 admin retry 都只得到 `concurrent recharge in progress`，只能手改数据库。建议：claim 加时间戳 + TTL（如超 5 分钟可再 claim），或 admin retry 支持强制 reclaim。
2. **Stripe 未知 webhook 事件返回 500**——`src/extensions/payment/stripe.ts:359-374` 的 `mapStripeEventType` default 抛错 → notify 路由 500。Stripe dashboard 若多勾任一事件（如 `checkout.session.expired`）会持续重试数天，可能触发 endpoint 告警/禁用，届时真正的支付成功事件也收不到。建议：未知事件返回"跳过"（200 + not handled），验签失败仍非 200。
3. **PayPal sandbox 模式放行无签名 webhook**——`src/extensions/payment/paypal.ts:470-483`：`paypal_environment !== 'production'` 时缺签名头仅 warn 后继续处理。若上线启用 PayPal 且配置误留 sandbox，可伪造通知免费加额（Stripe/Creem 始终严格验签，无此问题）。建议：生产运行时（NODE_ENV=production）强制拒绝无签名事件，不以配置项为准。

### 模型目录与定价

4. **未配置 newapiGroup 映射的分组进入建 Key 下拉，提交必失败**——`src/features/api-catalog/server/queries.ts:446-453` 只过滤 `status='active'` + `allowCreateKey`；新建分组默认 `allowCreateKey=true`、`newapiGroup=''`，用户选中 100% 报 "group not available"。建议：查询加 `ne(newapiGroup, '')`，或表单在映射为空时强制 `allowCreateKey=false`。
5. **smokeTested 开关被 ede2dc4 移除，推翻 bc08397 冻结设计的 Blocker 决议**——`listings/new/page.tsx:177` 硬编码 `smokeTested: false`，admin 再无写 true 的入口；新模型永远进不了 smoke 候选，`smoke-mvp.ts:480-484` 不显式传 `APIPOOL_SMOKE_MODEL` 时直接抛错。建议：在 listing 编辑表单恢复该开关。
6. **/models 价格 `toFixed(2)` 展示，低价模型误差可达 ±7%**——`src/features/api-catalog/lib/catalog.ts:128-130`：$0.0375/1M 显示 "$0.04"（+6.7%）、$0.075 显示 "$0.07"（−6.7%），与账单口径对不上。建议：改最多 4 位有效小数，一行改动。
7. **模型表单每次保存都把公开价打回隐藏且无提示**——`catalog-service.ts:831` 无条件置 `priceDriftStatus='needs_live_check'`；只改 displayName 也会让 /models 价格变 "—" 直到手动跑价格同步。建议：保存成功提示附加"需运行价格同步以恢复公开价"，或价格字段未变时不重置 drift。
8. **新增分组折扣撞已有 listing 时报原始 UNIQUE 约束错误**——`listings/new/page.tsx:123`（默认选中 groups[0]，多半已有 listing）+ `:185`（`createListing` 未捕获冲突）。建议：下拉只列该模型尚无 listing 的分组，或 catch 后抛已翻译的提示。

### 控制台体验

9. **桥接失败时余额显示 $0.00 并误弹"余额不足"警告**——`portal.ts:462`/`:2132` 把失败/空视图的 `balanceUsd` 硬编码为 `0`，击穿了 `isLowBalance` 专门设计的"undefined 不告警"（`balance-warning-view.tsx:9-14`，测试有明确断言）。New API 抖动时用户被误导以为余额清零。建议：failed/无 snapshot 时保持 `undefined`（`formatBalanceUsdAmount` 已支持显示 "—"）。
10. **删除 API Key 无二次确认**——`api-key-manager.tsx:232-257`、按钮 `:411-428`：垃圾桶图标单击即调远端 DELETE，不可恢复（完整 key 无法找回），与相邻"禁用"按钮易误触。建议：套 shadcn AlertDialog，一处改动。
11. **dashboard 无 `loading.tsx`/`error.tsx`**——全仓仅有根 `not-found.tsx`；dashboard 各页是串行远端调用的同步 RSC（单个超时 15s），慢时整页白屏，未捕获异常落 Next 默认英文错误页。建议：给 `(landing)/dashboard/` 加一份 loading 骨架 + 双语 error.tsx，一次覆盖 4 个页面。
12. **缺 `[locale]/not-found.tsx`，404 是无导航的裸英文页**——`src/app/not-found.tsx:19-24` 硬编码英文，zh 用户走错链接看到断头页。建议：加 `[locale]/not-found.tsx` 套 SiteShell + 双语文案。
13. **未登录进控制台，登录后被丢回首页**——`dashboard/layout.tsx:15-18` 重定向 `/sign-in` 不带 callbackUrl（sign-in 默认回 `/`）；首页 hero/头部 Console 全指向 /dashboard，核心转化路径断在最后一步。建议：`redirect({ href: '/sign-in?callbackUrl=/dashboard…' })`，并让 sign-in↔sign-up 互跳透传该参数。
14. **登录/注册/验证邮箱的校验与错误 toast 全是硬编码英文**——`sign-in.tsx:76,123,129`、`sign-up.tsx:99,148,154`、`verify-email.tsx:226,245,251` 及 form 变体；better-auth 服务端英文报错直接透传。这是每个新用户必经页面。建议：校验文案换 `common.sign` 词条，服务端错误按 code 映射双语。
15. **桥接故障时控制台显示英文覆盖 zh 词条**——`public-errors.ts:1-2` 英文兜底 → `portal.ts:1918-1920` 写入 `errorMessage` → `status.ts` 的 stale/failed 分支优先展示它，压过 `dashboard/common.json` 成套的 zh `usageSync` 文案。同源问题：`portal.ts:129-130`（重名 Key）、`:1364-1370`（group not available）等业务错误恒英文。建议：服务端改回传错误码，前端按码取词条（一次改造覆盖两处）。

### SEO 与安全加固

16. **/models canonical 错误指向站点根、无页面级 metadata**——`seo.ts` 的 `getCanonicalUrl` 空值回退 `'/'` + models 页无 `generateMetadata`；唯一核心可索引营销页被搜索引擎归并到首页。建议：给 models 页加 `getMetadata({ metadataKey, canonicalUrl: '/models' })` 并补 en/zh metadata 词条。
17. **无 OG/Twitter 分享图**——`app_preview_image` 默认空且各 env 未配置；分享卡片无图。建议：加 `public/imgs/og.png` + 设 `NEXT_PUBLIC_APP_PREVIEW_IMAGE`。
18. **`/api/user/is-email-verified` 匿名可枚举注册/验证状态**——`route.ts:4-16` 无鉴权无限流，可批量探测某邮箱是否为本站用户。建议：加最小间隔限流 + 无差别响应（或仅登录态查自身）。
19. **checkout 等敏感路由无速率限制**——`enforceMinIntervalRateLimit` 仅覆盖 `/api/auth/get-session`；登录用户可无节制刷 `createOrder` + Stripe session，Caddy 边缘也无 `rate_limit`。建议：checkout / is-email-verified 复用现有限流 helper，Caddy 加兜底限流。

---

## P2：结构 / 视觉 / 交互与债务建议

### 资金链路防御纵深

- **管理员负向调额是"读-改-写"覆盖**（`client.ts:1428-1451`）：进程内锁挡不住窗口期内用户真实消费，PUT 绝对值会抹掉差额；且 PUT body 只发 `{id, quota}`，与 `docs/04-newapi-contract.md:67`"只传部分字段会触发校验问题"的警告矛盾（待验证远端行为）。建议减额改走负数兑换或先查 profile 全量 PUT + 调后校验。
- **对账接口盲区**（`payment.ts:129-131`、`reconciliation/route.ts:48-53`）：加额与对账用同一 `creditsAmount>0` 过滤，套餐漏配 `credits` 字段时付款既不加额也不出现在差异里；LIMIT 100 会让老差异滑出窗口。
- **ShipAny credits 双轨残留**：每单仍写无人消费的 credit 表（`payment.ts:249-289`）；更实际的暗门是 `top-up-products.ts:159-164` 未封死 subscription 类型——将来若配月度套餐，续费只发 ShipAny credits、quota 一分不加。建议 `resolveTopUpCheckout` 一行断言拒绝非 one-time。
- **支付取消/失败落地页**：cancelUrl 与 callback 异常都跳 `/pricing`（→ redirect /models），脱离充值上下文且无错误提示。建议改跳 `/dashboard/billing?checkout=canceled|failed`。
- **adjust-quota 输入未收敛**（`adjust-quota/route.ts:29-36`）：金额未限整数、无上限（10.5 会破坏 amountUsd 整型约定）；前端减额无二次确认。
- **补偿三件套只有 API 无界面**：retry/reconciliation 目前依赖 curl，admin 也无订单列表可查 orderNo。建议在 `/admin/apipool-adjustments` 旁加最小对账/重试页。
- **Creem 签名用 `!==` 比较**（`creem.ts:151`）：建议换 `crypto.timingSafeEqual`。

### 控制台与交互

- **dashboard 每次 SSR 全量远端同步**（`portal.ts:1939-1980`）：无"synced < N 秒直接用缓存"短路，连续导航串行阻塞在 3 个远端调用上（单个超时 15s）。建议 15-30s 新鲜度短路 + key 状态仅变化时写库。
- **Key 禁用后无法重新启用**（`status.ts:71-77`）：只能删除重建；New API 契约支持 `status_only` 启用，补一个 enable 动作改动很小。
- **复制掩码 Key 按钮易误导**（`api-key-manager.tsx:386-396`）：掩码含 `****` 无实际用途，可能被误当凭据；且首次状态同步后掩码格式变化（本地 `sk-x****` → 远端无前缀格式，`portal.ts:1581` 覆盖）。建议去掉该按钮、同步不覆盖 `keyMasked`。
- **admin 查看用户详情隐式创建 New API 账号**（`admin/users/[id]/detail/page.tsx:214`：`getPortalUsage` 触发 lazy provision）：管理端建议 binding 不存在时直接返回空视图。
- **忘记密码入口被注释**（`sign-in.tsx:171-176`）：若生产开启邮箱密码登录，无自助找回路径；MVP 至少放 mailto 提示。
- **服务端日期 `toLocaleString()` 裸调**（dashboard/usage/billing 多处）：格式与时区跟随服务器（多半 en-US/UTC），zh 页面显示美式日期。建议显式传 locale + timeZone 或用 next-intl `format.dateTime`。

### 目录与 admin

- 模型无能力标签时在公开页/建 Key 候选中**静默消失**（`queries.ts:115-119`；表单 capabilities 无 required）——表单要求至少一个能力，或列表加"未公开（缺能力）"提示。
- 分组列表不展示 ratio/pricingSyncStatus（`groups/page.tsx:40-52`）——加两列可显著降低 P0-3 的误操作概率。
- 字典删除被阻止时不展示引用明细（`catalog-service.ts:158-166` 算好了 label+count，delete 页吞掉换笼统文案）。
- `setModelCapabilities/Categories` 非事务 delete+insert（`catalog-service.ts:713-725`、`867-905`）：insert 失败会清空能力导致公开页消失。
- `deleteModel` 不清理 `catalog_model_price`（`catalog-service.ts:658-671`），仅靠 FK cascade——而 libsql 运行时 FK 开关未验证（见已知遗留），建议事务里补显式 delete。
- 无折扣 listing 经模型编辑后 `discountRateBps` null→10000 脏写（`models/[id]/edit/page.tsx:215` 的 `|| '10'` 默认）。
- DB 驱动文案单语：模型描述、折扣备注直接透出录入语言（en/zh 同串）。
- smoke 脚本 `quotaSpendFromUsageLogs` 未防负数（`smoke-mvp.ts:214-221`，仅影响对账误报）。

### 站点结构 / 视觉 / SEO

- **zh 法律术语不一致**：页脚「服务条款」vs 文档正文/注册页「用户协议」（`zh/site.json` footer.terms）——统一为「用户协议」，一处改动。
- **hreflang alternate 恒指首页**（`layout.tsx:108-120` 不含当前路径）：错误的 hreflang 比没有更糟；建议删手写 head 改用 metadata `alternates.languages`。
- **sitemap.xml 静态过期**（lastmod 全 2026-05-24，仅 6 URL）：换 `src/app/sitemap.ts` 动态生成；另注意 `indexing.ts` 把 `/privacy-policy`、`/terms-of-service` 也 disallow 了（若非有意，法律页放开收录更利于信任）。
- **文档站顶部导航无回主站入口**（`(docs)/layout.config.tsx:9` `links: []`）：文档读者是最接近转化的人群，补 Models 与 Console 两项。
- **签退状态首屏两个 primary 实心按钮**（header Sign In + hero CTA），违反 docs/05 §5"每屏主按钮 ≤1"——header 改 ghost/outline。
- **规范外颜色**：BalanceWarning 用 amber（docs/05 色板无此色，警示应使用 `--chart-3` 橙或语义 token）；首页 vignette 用 emerald/teal 渐变（建议 primary 透明度阶梯）。
- **死翻译资产漂移**：`localeMessagesPaths` 未含 `landing`、`activity/*`、`ai/*` 等，对应 JSON 与 themes/default 模板块是桩后死代码——现无风险，但复用即渲染裸 key；建议清理或标注"未接线"。
- `getAllConfigs()`（含全部密钥）直接喂 root layout 的 ads/analytics 服务（`layout.tsx:65`）：当前只读公开 id、风险低，但属"改一行就出事"的脆弱面，建议改传 `getPublicConfigs()`。
- admin settings 的 `collectNonEmptyConfigs` 跳过空值（`settings/[tab]/page.tsx:60-77`）：任何配置项无法从 UI 清空。

---

## 上线前人工检查清单（非代码 bug）

- [ ] **Caddy 边界（P0-2 修复后复验）**：`newapi` 子域 Basic Auth/IP 白名单生效；`api2` 只放行 `/v1`；三个子域公网实测可达面。
- [ ] `/opt/apipool-v2/.env.deploy` 权限 600；`AUTH_SECRET`/`APIPOOL_CREDENTIALS_SECRET` 为真随机（entrypoint fail-fast 与 compose allowlist 已验证成立）。
- [ ] GHCR 镜像仓库为 private。
- [ ] New API root 密码强度；`payment_compliance` 已按 runbook 确认。
- [ ] 支付配置：`paypal_enabled=false` 或 `paypal_environment=production`（P1-3 修复前尤其重要）；Stripe dashboard 只勾选代码已映射的 5 种事件（P1-2 修复前尤其重要）；Stripe/Creem 密钥填 admin settings 并跑一笔测试模式全链路。
- [ ] **告警未落地**：runbook 列的三条告警（webhook 失败 / ledger pending 超 10 分钟 / bridge 连续 unauthorized）代码与部署件中均无实现——上线前接监控或明确接受裸奔；P1-1 的 processing 卡死也依赖这里发现。
- [ ] 备份恢复演练：`deploy/backup.sh` 只备份未演练过 restore；`deploy.sh` 明确"数据库不自动回滚"。
- [ ] 域名规划确认：部署默认 `app/api2/newapi.apipool.dev` 三子域；历史待决的"上游站与 v2 品牌同用 apipool.dev"冲突是否已解决。
- [ ] 品牌资源：favicon（P0-5）与 OG 图（P1-17）用正式品牌资产，同时补正式 logo。
- [ ] ads/analytics/affiliate 若上线启用，grep 复核其只读公开配置键（见 P2 `getAllConfigs` 项）。

---

## 已知遗留项复核结果

| 遗留项 | 复核结果 |
| --- | --- |
| roles/users 4 个既有 edit handler 缺 requirePermission（OQ-3） | **已修复**：roles edit / edit-permissions / users edit 均有 `requirePermission`，users edit-roles 用 `requireAllPermissions`，可勾掉 |
| `ensurePortalUserBinding` 复用 active 凭据不校验有效性 | **仍未解决**（portal.ts:626-631 直接复用）：凭据失效时用量/建 Key 以 stale/failed 兜底但不自愈，维持 defer 或与 P1-9 一并处理 |
| libsql 未开 PRAGMA foreign_keys（OQ-1） | 运行时开关仍未验证；`deleteModel` 依赖 cascade（见 P2），连带风险，建议尽快实测一次 |
| /pricing、/blog、/settings/* 等占位路由 | 全部确认符合预期：不在导航/页脚出现，legal 双语可达，无 ShipAny 残留字符串 |
| 支付幂等设计（order 乐观锁 + ledger 唯一索引） | 基本成立，测试覆盖良好；唯一破口是 P0-1 的歧义失败分流 |

## 后续处理建议

1. 先修 P0-1 / P0-2（资损与安全），再修 P0-3（计费一致性），三者都有明确的单点修法。
2. P0-4/5/6 加上 P1 的 9-13（dashboard 三态 + not-found + callbackUrl + 删除确认）可打包成一个"上线体验补齐"分支，总改动量小。
3. P1 中 14/15（错误码化双语）是同一模式改造，建议一次做完。
4. 未修项与检查清单已同步到本目录 `issues.md`，作为后续闭环入口。

---

## Codex 二次评审补充（2026-07-09）

- 方法：Codex 主线程按 gstack `/review` 口径复核 P0/P1 关键代码，并启用 3 个只读子 agent 分别评审资金/安全、模型目录/定价、前端/i18n/SEO 与文档闭环。未修改业务代码，未起服务做 live 走查；以下结论基于静态代码与文档证据。

### 新增上线阻塞

#### P0-7 checkout metadata 可覆盖保留字段，webhook 信任被覆盖的 `order_no`

- 位置：`src/app/api/payment/checkout/checkout-handler.ts:17-24`、`:204-209`；`src/app/api/payment/notify/[provider]/route.ts:54-63`；`src/shared/services/payment.ts:186-205`、`:248-289`
- 问题：checkout API 接受客户端传入 `metadata`，构造支付订单时先写入 `order_no`/`user_id`，再展开 `...(metadata || {})`，因此客户端可覆盖保留字段。webhook 收到支付成功事件后只按 `session.metadata.order_no` 查询订单，没有校验该 payment session 是否属于该订单，也没有校验 session 金额/币种与本地订单一致；后续入账和 New API 加额按本地订单金额执行。
- 失败场景：攻击者先创建一个大额订单拿到 `orderNo`，再发起小额 checkout 时把 metadata 覆盖为该大额 `order_no`。小额支付成功后，webhook 可能把大额订单标 paid，并按大额订单 `creditsAmount`/`amount` 入账和加额。
- 建议修法：服务端完全忽略客户端传入的保留 metadata key（至少 `order_no`、`user_id`、`app_name`），或把客户端 metadata 放入命名空间；webhook 处理时同时校验 `paymentSessionId`/provider transaction id、金额、币种、用户身份与本地订单一致，不一致直接拒绝并告警。

### 优先级调整

- **P1-1 建议升级为上线门禁**：`CLAIMABLE_RECHARGE_STATUSES` 不含 `processing`（`recharge.ts:51`），claim 后进程崩溃或滚动部署会永久卡住，后续重放只返回 `concurrent recharge in progress`（`recharge.ts:111-115`）。上线前至少需要三选一：processing TTL reclaim、admin 强制 reclaim、或明确的监控告警 + 手工 SOP。
- **P0-5 建议降为 P1 或品牌发布门禁**：无 favicon 的证据成立（`layout.tsx:103-105`、`config/index.ts:15`），但它是公开品牌硬伤，不是资损、安全边界或核心功能硬坏。若产品策略要求品牌资产完整再开放，可作为发布门禁保留，但不建议与 P0-1/P0-2 同级。
- **PayPal P1-3 条件升级**：若生产启用 PayPal 且 `paypal_environment` 仍可误留 sandbox，则无签名 webhook 放行（`paypal.ts:470-483`）应升级为 P0；若 PayPal 上线前保持关闭，P1 + 人工检查项足够。

### 文案与修复口径修正

- **P0-1 文案需收窄**：远端已可能执行而本地回 `pending` 的风险成立；但兑换码名称由 `reference` 确定性生成（`client.ts:1463-1468`），是否必然"生成新兑换码并双倍到账"取决于 New API 对同名 redemption 的行为。建议把失败场景改为"可能重复加额，或进入无法自动判定的对账缺口"。同时补充：兑换码生成与 topup 是两步（`client.ts:1469-1489`），代码只有 `adjustQuota()` 完整返回后才写 `newapiChangeId`（`recharge.ts:143-149`），不满足 `docs/06-payments-ledger.md` 中"若兑换码已生成则只重试兑换"的补偿口径。
- **P1-2 应扩展为所有 provider 的未知 webhook 事件策略**：Stripe default throw 成立（`stripe.ts:359-373`），PayPal/Creem 也有类似 default throw（`paypal.ts:782-783`、`creem.ts:311-317`），最终都会让 notify route 500。建议统一为"验签失败仍拒绝；验签通过但业务不处理的事件返回 200 skip"。
- **P1-4 修复不能只判断 `newapiGroup != ''`**：未配置映射的分组进入建 Key 下拉成立，但只过滤空映射仍会放过 `pricingSyncStatus='missing_remote_group'` 或 ratio 缺失的组。Key 创建候选应同时要求 `newapiGroup` 非空、远端组存在、必要的 pricing sync 状态可信。
- **P1-11 描述需修正**：dashboard 缺 `loading.tsx`/`error.tsx` 成立；但"各页串行远端调用"表述过度，overview/billing 已使用 `Promise.all`。建议改为"dashboard 路由整体缺加载/错误边界，部分页面仍存在慢远端调用导致白屏或默认错误页风险"。
- **P1-18 文案需收窄**：`/api/user/is-email-verified` 匿名可查的是"邮箱是否存在且已验证"，不是完整枚举"是否为本站用户"；缺失用户与未验证用户都返回 false。优先级仍可保持 P1。
- **P0-4/P0-5 的 404 结论应标注为静态推断**：本轮报告明确未起服务 live 走查，因此 `/api/docs/search` 与 `/favicon.ico` 的 HTTP 404 应写为"按路由/资源缺失静态推断，修复后需起服务复验"。

### 文档闭环问题

- `issues.md` 目前不能完全承担闭环入口：报告最后写"未修项与检查清单已同步到 `issues.md`"，但 `issues.md` 的 P2 标题写的是"择要"。后续若用 `issues.md` 自动扫描升级 feature，可能漏掉只存在于 `report.md` 的建议项。
- `issues.md` 漏掉 `report.md` 中的 P2 条目"无折扣 listing 经模型编辑后 `discountRateBps` null→10000 脏写"（`models/[id]/edit/page.tsx:215`）。
- `issues.md` 的 P2 多个 checkbox 合并了多个独立问题，例如模型能力、分组列表、字典删除引用明细被塞进同一项。建议拆成原子条目，便于部分解决后准确勾选。
- 已勾选的 OQ-3 缺少 feature/提交回链；这与 `issues.md` 文件头"被解决/升级时回链对应 feature/提交"的规则不一致。

### 二次评审后的处理顺序建议

1. 先补 P0-7（metadata 覆盖）与 P0-1/P1-1（充值歧义失败、processing 卡死）这一组资金链路问题。
2. 再修 P0-2（Caddy/New API 暴露）与 P0-3（分组映射后展示价/计费不一致）。
3. P0-4/P0-6 与 P1-9 到 P1-15 可以作为"上线体验与 i18n 补齐"批次处理；P0-5 可随品牌资产批次处理。
4. 修复文档时同步更新 `issues.md`：补 P0-7、调整 P1-1/P0-5 优先级、补漏掉的 P2，并把 P2 拆成原子 checkbox。

---

## 对 Codex 二次评审的裁决（2026-07-09，原报告作者复核）

方法：对 Codex 每条结论独立读码验证，不以"评审说了"为准。结论：**全部接受，无驳回**；其中 P0-7 经独立复现推演确认成立，并在两处给出比 Codex 更强的修法。

### 一、P0-7 确认成立，且应排在 P0 之首

独立验证链路：
- `checkout-handler.ts:23` 从请求体取 `metadata`，`:204-208` 以 `{ app_name, order_no, user_id, ...(metadata || {}) }` 构造——客户端 metadata **在保留字段之后展开**，可覆盖 `order_no`/`user_id`。全文件对 metadata 无任何过滤（仅 23/90/204/208 四处出现）。
- `notify/[provider]/route.ts:56` 只用 `session.metadata.order_no` 查单；`payment.ts:187-205` 的 `handleCheckoutSuccess` 在 `paymentStatus === SUCCESS` 后直接把该本地订单置 PAID，**未校验 session 的金额/币种/归属用户/transaction 是否属于这张单**；`:250` 起按 `order.creditsAmount`（本地大额订单的值）发放，`applyApipoolRecharge` 同样按本地订单金额加额。

可复现攻击（登录用户即可自助完成，无需管理员、无需竞态）：建大额订单 A 拿 `orderNo_A` 不支付 → 再发起小额 checkout 并传 `metadata: { order_no: orderNo_A }` → 支付小额 → Stripe 回调携带被覆盖的 `order_no_A` → 订单 A 被标 PAID 并按 A 的金额加额。**付 $5 拿 $50，可重复。**

与 P0-1 的定级关系：P0-1 需要网络抖动触发、且是"可能"重复；P0-7 是确定性的、可重复的、攻击者主动发起的资损。**建议 P0-7 取代 P0-1 成为首要修复项。**

**比 Codex 更强的修法**：Codex 建议"忽略保留 key 或做命名空间"。实测调用方后可以更彻底——真实充值入口 `top-up-packages.tsx:68-72` 只传 `product_id/currency/locale`，**不传 metadata**；唯一传 metadata 的 `themes/default/blocks/pricing.tsx:279`（affiliate 追踪）经 grep 确认**无任何路由引用，是桩后死代码**。因此首选修法是**直接从 `CheckoutRequestBody` 删除 `metadata` 入参**；将来若需 affiliate 追踪，再以固定白名单键（`affonso_referral`/`promotekit_referral`）写入独立命名空间字段。webhook 侧的金额/币种/归属校验作为纵深防御同步补上。

### 二、Codex 对原报告的修正，逐条复核结果

| Codex 修正 | 复核 | 证据 |
| --- | --- | --- |
| P0-1"必然生成新码双倍到账"过强 | **成立，采纳** | `client.ts:1465-1468` 兑换码名 = `r`+sha256(reference)[0:18]，确定性；是否真生成第二张码取决于 New API 对同名 redemption 的行为（未 live 验证）。应改述为"**可能**重复加额，或进入无法自动判定的对账缺口" |
| P0-1 违反 docs/06 补偿口径 | **成立，采纳** | `docs/06-payments-ledger.md:47`"若兑换码已生成则只重试兑换"、`:48`"以兑换码 ID 反查"；现码每次重试都新建 redemption |
| P1-2 应扩展到所有 provider | **成立，采纳** | `stripe.ts:359-373`、`paypal.ts:782`、`creem.ts:317` 三处 default 均 `throw`，最终都落 notify 500 |
| P1-11"各页串行远端调用"表述过度 | **成立，采纳** | `dashboard/page.tsx:51`、`billing/page.tsx:86` 均用 `Promise.all`；仅 `usage/page.tsx:25` 是单次调用。应改述为"路由整体缺加载/错误边界，慢远端调用仍会白屏" |
| P1-18 枚举面被高估 | **成立，采纳** | `user.ts:183` 返回 `!!row?.emailVerified`——邮箱不存在与存在但未验证**同为 false**；泄漏面收窄为"确认某邮箱是已验证用户"，优先级仍 P1 |
| P1-4 只判 `newapiGroup != ''` 不够 | **成立，采纳** | 仍会放过 `pricingSyncStatus='missing_remote_group'`/ratio 缺失的组；候选条件应为映射非空 + 远端组存在 + pricing sync 状态可信 |
| P1-1 升级为上线门禁 | **采纳** | `recharge.ts:51` claim 状态集不含 `processing`，崩溃后无任何自动或人工 API 恢复路径（`:111-115` 恒返回 concurrent in progress）。虽非资损，但"用户已付款且无自动恢复"应视同门禁 |
| P0-5 favicon 降级 | **采纳** | 证据成立但性质是品牌硬伤，非资损/安全/功能硬坏。改归入"发布门禁（品牌资产）"，与 P0-1/P0-2/P0-7 区分定级，仍在上线前完成 |
| PayPal P1-3 条件升级 | **采纳** | 若上线启用 PayPal 则升 P0；保持 `paypal_enabled=false` 则 P1 + 检查项充分 |
| P0-4/P0-5 的 404 应标为静态推断 | **采纳** | 本轮全程未起服务；`/api/docs/search` 与 `/favicon.ico` 的 404 为路由/资源缺失的静态推断，修复后需 live 复验 |
| `issues.md` 四项闭环缺陷 | **全部成立，已修** | 见下 |

### 三、定级调整后的上线门禁（最终口径）

| 类别 | 条目 |
| --- | --- |
| 资损 / 安全（最高优先） | P0-7（metadata 覆盖，**首要**）、P0-1（充值歧义失败）、P1-1↑（processing 卡死）、P0-2（New API 管理面公网可达） |
| 计费一致性 | P0-3（分组重映射价差） |
| 对外功能硬伤 | P0-4（docs 搜索 404，静态推断）、P0-6（EN 页中文折扣标签） |
| 发布门禁（品牌资产） | P0-5↓（favicon 缺失，静态推断）、P1-17（OG 图） |

### 四、`issues.md` 闭环缺陷已修复（2026-07-09）

- 补入 P0-7；P1-1 标记为门禁、P0-5 移入品牌门禁分区。
- 补入原报告有、清单漏掉的 P2 条目"无折扣 listing 经模型编辑后 `discountRateBps` null→10000 脏写"。
- P2 分区标题由"择要"改为完整同步，并把原先合并的多问题 checkbox 拆成原子条目。
- 已勾选的 OQ-3 补上回链：提交 `0696a79 fix(security): roles/users 写 handler 二次鉴权对齐页首门控（OQ-3）`。

按本项目文档规范，过程文档冻结不回填，故上述修正以追加形式记录于此；`issues.md` 作为"半活"清单已就地更新为最新口径。

---

## 修复进展（2026-07-09，分支 `fix/pre-launch-p0`）

全部门禁项已修复，416 tests pass / tsc 0 error / eslint clean。逐项回链见 `issues.md`。

| 项 | 提交 | 关键说明 |
| --- | --- | --- |
| P0-7 | `dbc4b25` | 删除 `CheckoutRequestBody.metadata` 入参 + 新增 `payment-guards.ts` 纵深防御 |
| P0-1 + P1-1 | `a64d39e` | 兑换码落库先于兑换请求；带码值的 ledger 永不自动重试 |
| P0-2 | `0e4be8d` | api2 只放行 `/v1*`；newapi 加 Basic Auth / IP 白名单；脚本 fail-closed |
| P0-3 | `2ed9cc0` | 分组重映射时事务内失效倍率缓存与 listing drift |

### 实现与原建议的偏离（重要）

- **P0-7**：报告建议"忽略保留 key 或做命名空间"，实际**直接删除 `metadata` 入参**。依据：真实充值入口 `top-up-packages.tsx` 不传该字段，唯一传它的 `themes/default/blocks/pricing.tsx` 无任何路由引用（死代码）。副作用：若将来复活该 block，affiliate 追踪需重新接线。
- **P0-1**：报告建议"利用确定性兑换码名，建码前先查同名码"。**未采用**——`docs/04` 只实测过 `POST /api/redemption/`，New API 没有可用于按码名反查的验证过的端点，不臆造端点。改为在 `client.adjustQuota` 新增 `onRedemptionCreated` 回调，在**发出兑换请求之前**把码值交给调用方落库；此后任何失败（含进程被 SIGKILL）都转 `reconciliation_required`。并确立全局不变量：**ledger 一旦带 `newapiChangeId`，claim 谓词永不选中它**，四条自动路径（webhook 重放 / 支付回跳 / admin retry / processing 超时重夺）均无法再次加额。`docs/06` 第 5 节已按实际口径改写。
- **P1-1**：processing TTL（5 分钟）重夺**只对未带码值的行生效**；带码值的卡死行升级 `reconciliation_required`，仍在执行的新鲜行照旧 `pending_retry`。

### 修复过程中被 TDD 抓住的两个自引入缺陷

1. **P0-7 守卫位置错误**：`assertPaymentSessionMatchesOrder` 最初放在 `paymentStatus === SUCCESS` 判断之前。Stripe 的 `checkout.session.completed` 在异步支付未付款时也映射为 CHECKOUT_SUCCESS，金额为 0，会被判"少付"抛错，打断原本的 FAILED / PROCESSING 落库路径。**对策**：把前提条件放进守卫内部，调用点位置不再影响正确性。
2. **P1-1 TTL 重夺重新打开了 P0-1 的窗口**：初版只看 `updatedAt` 超时就重夺，但"崩溃发生在 topup 飞行途中、码已发出却未落库"的行没有 changeId，会被判为"安全重试"→ 再发一张码 → 双倍到账。**对策**：`onRedemptionCreated` 预落库，把该窗口消除。

教训：涉及资金的守卫，前提条件要内聚在守卫里；"看起来安全的重试"必须先证明远端未发生任何事。

### 已修项的遗留验证（全部转入 `issues.md` 人工检查清单）

- 所有验证均在单元层（真实代码 + 注入依赖 + 真 SQLite），**未跑真实 Stripe 回调、未跑真实 New API、本地无 caddy**。
- 上线前必须：① 测试模式跑一笔完整充值，复验 webhook 守卫不误拒（含折扣码场景）与兑换码窗口行为；② 按 runbook 第 2 节实测三子域可达面；③ **新增告警项**：`ledger.status = 'reconciliation_required'` 必须接监控——P0-1 修复后所有歧义失败都汇入该状态，需人工按 `newapiChangeId` 反查远端兑换状态后手工结清。这是本次修复引入的新运维负担。

### Codex 对抗式评审（2026-07-09，分支 diff）与裁决

Codex 判定 `needs-attention / no-ship`，1 条 critical：`recharge.ts` 的 reclaim 谓词把 `newapiChangeId IS NULL` 当作"远端什么都没发生"的证明，但进程可能死在 `POST /api/redemption/` 已成功、码值尚未落库之间。

**裁决：设计缺陷成立，严重度高估，其中一条路径描述有误。已按正确原语修复（`28d3c4e`）。**

| Codex 论点 | 复核 |
| --- | --- |
| reclaim 用 `changeId IS NULL` 作"远端无副作用"的证明不成立 | **成立**。这正是 P0-1 里批判过的"看起来安全的重试"，在 TTL 重夺上又犯了一次 |
| 后果可能是"重复到账" | **高估**。额度发放（`POST /api/user/topup`）严格晚于码值落库，故**额度已发放 ⇒ changeId 必已落库**；TTL 重夺只可能命中未发放的行，用户仍只到账一次。请求层对 POST 从不自动重试，窗口不会被放大 |
| "回调写库失败会留下 `processing + changeId=null`" | **不成立**。`redemptionDispatched = true` 置位在 `await db()` 之前，写库失败抛错后落 `reconciliation_required`（非可 claim 状态） |
| "唯一冲突导致无限 pending" | 未复现。New API 生成的是新码值，`newapiChangeId` 不冲突；若 New API 拒绝重名，则创建失败 → pending 循环，但**失败安全**（不发放） |
| 真实残留损害 | **孤儿兑换码**：远端多一张未兑换的码，码值已丢失、仅管理后台可见、需 New API 管理员才能兑换（而这种人本可直接改额度）。属会计漂移，非用户可触发的资损 |

**修复（`28d3c4e`）**：新增 `ledger.remoteAttemptAt`（迁移 0011），在**任何远端副作用之前**写入；claim 只重夺 `remoteAttemptAt` 与 `newapiChangeId` 均为 null 的陈旧 `processing` 行，否则升级 `reconciliation_required`。顺带堵住同源的洞——`POST /api/redemption/` **返回之后**才抛的 `malformed_response` 原先标成可重试的 `failed`，admin 重试会再造一张码；现改为"请求一旦返回，此后任何失败都结局未知"，一律升级人工核对（码值未解析出时留空 `changeId` 避免撞唯一索引，人工按确定性兑换码名反查）。`docs/06` 第 5 节改写为上述口径并记录孤儿码残留。

**教训**：两轮下来同一个错误犯了两次——"我没记下证据"被当成"事情没发生"。资金链路里，自动重试的前提必须是**先落一个可证明的前置标记**，而不是事后看某个字段是否为空。

### 下一批建议

P0-4（docs 搜索 404）、P0-6（EN 页中文折扣标签）+ P1-9~P1-13（dashboard 三态 / not-found / callbackUrl / 删除确认）可打包为"上线体验补齐"分支；P1-14/15 错误码化一次做完；P0-5/P1-17 随品牌资产批次。
