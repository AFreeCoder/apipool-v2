# 上线前审查遗留清单

- 基线：main @ ede2dc4
- 来源：[report.md](report.md)（2026-07-08 首轮五维度审查 + 2026-07-09 Codex 二次评审 + 作者裁决）
- 口径：本清单与 report.md 的 P0/P1/P2 **完整同步**（非择要），可直接作为扫描升级 feature 的闭环入口。
- 规则：条目被解决/升级时勾掉并回链对应 feature 或提交。

## 上线门禁 · 资损与安全（最高优先）

- [x] **P0-7 checkout metadata 可覆盖 `order_no`/`user_id`，webhook 不校验 session 归属与金额** —— 2026-07-09 已修复，回链提交 `dbc4b25 fix(payment): reject client-supplied checkout metadata (P0-7)`。移除 `CheckoutRequestBody.metadata` 入参（metadata 全部服务端构造）+ 新增 `assertPaymentSessionMatchesOrder` 纵深防御（仅拒绝「实付+折扣 < 订单金额」，且仅校验支付成功的 session）。**遗留**：webhook 守卫未跑真实 Stripe 回调，须在测试模式充值时复验（见下人工检查项）；`themes/default/blocks/pricing.tsx` 仍在发送已被忽略的 affiliate metadata，若复活该 block 需重新接线。
- [ ] **P0-1 充值歧义失败标 pending 可重试，可能重复加额或产生对账缺口**——`recharge.ts` catch 漏 `isQuotaAdjustmentReconciliationError` 判定；topup 请求超时同样落 pending。修法：歧义失败一律置 `reconciliation_required` 并落 changeId；利用确定性兑换码名（`r`+sha256(reference)[0:18]）在建码前先查同名码——docs/06:47-48 本就如此要求，现码未遵守。
- [ ] **P1-1↑（升为门禁）ledger 卡 `processing` 无任何恢复路径**——claim 状态集不含 processing，崩溃/滚动部署后永久卡死，用户已付款且无自动或 API 恢复手段。三选一：TTL reclaim / admin 强制 reclaim / 监控告警 + 手工 SOP。（`recharge.ts:51`、`:111-115`）
- [ ] **P0-2 New API 管理后台公网可达**——`configure-caddy.sh:19-35` 两子域无 Basic Auth / IP 白名单，`api2` 未限 `/v1`。修复后需实测三子域可达面。

## 上线门禁 · 计费一致性

- [ ] **P0-3 分组重映射 `newapiGroup` 后公开价仍用旧倍率，与实际计费不一致**——`updateGroup` 不重置 ratio 缓存 / `pricingSyncStatus` / listing drift。

## 上线门禁 · 对外功能硬伤

- [ ] **P0-4 文档搜索指向不存在的 `/api/docs/search`**（静态推断，修复后需起服务 live 复验）
- [ ] **P0-6 英文 /models 页折扣标签硬编码中文「X 折」**（`pricing.ts:122` `formatDiscountRate`）

## 发布门禁 · 品牌资产

- [ ] **P0-5↓ 全站无 favicon**（静态推断 `/favicon.ico` 404，修复后 live 复验）——性质为品牌硬伤，非资损/安全/功能硬坏
- [ ] P1-17 无 OG / Twitter 分享图
- [ ] 正式 logo（当前仍缺品牌资源）

## P1 高性价比

### 支付

- [ ] P1-2 未知 webhook 事件返回 500——**三个 provider 均有此问题**（`stripe.ts:359-373`、`paypal.ts:782`、`creem.ts:317`）。统一策略：验签失败仍拒绝；验签通过但业务不处理的事件返回 200 skip。
- [ ] P1-3 PayPal sandbox 放行无签名 webhook——**条件升级**：若上线启用 PayPal 则升 P0；保持 `paypal_enabled=false` 则 P1 + 人工检查项充分。

### 模型目录与定价

- [ ] P1-4 未配置映射的分组进建 Key 下拉、提交必失败——修复不能只判 `newapiGroup != ''`，还须要求远端组存在且 pricing sync 状态可信
- [ ] P1-5 smokeTested 开关被 ede2dc4 移除，新模型进不了 smoke 候选
- [ ] P1-6 /models 低价模型 `toFixed(2)` 误差 ±7%
- [ ] P1-7 模型保存即把公开价打回隐藏且无提示
- [ ] P1-8 新增分组折扣撞唯一索引报原始 SQLite 错误

### 控制台体验

- [ ] P1-9 桥接失败余额显示 $0.00 并误弹"余额不足"（balanceUsd 应保持 undefined）
- [ ] P1-10 删除 API Key 无二次确认
- [ ] P1-11 dashboard 路由缺 `loading.tsx` / `error.tsx`——注：overview/billing 已用 `Promise.all`，问题是缺加载/错误边界，慢远端调用仍会白屏或落默认英文错误页
- [ ] P1-12 缺 `[locale]/not-found.tsx`，404 为无导航的裸英文页
- [ ] P1-13 未登录进控制台，登录后丢回首页（callbackUrl 不透传）
- [ ] P1-14 登录/注册/验证邮箱 toast 硬编码英文
- [ ] P1-15 桥接/业务错误英文覆盖 zh 词条（应错误码化，与 P1-14 一并改造）

### SEO 与安全加固

- [ ] P1-16 /models canonical 指向站点根、无页面级 metadata
- [ ] P1-18 `is-email-verified` 匿名可探测——泄漏面为"某邮箱是否为已验证用户"（不存在与未验证同返 false），非完整用户枚举；仍需限流 + 无差别响应
- [ ] P1-19 checkout 等敏感路由无速率限制（Caddy 边缘亦无兜底）

## P2 建议

### 资金链路防御纵深

- [ ] 管理员负向调额是 read-modify-write 覆盖，窗口期内用户消费会被抹回
- [ ] 负向调额 PUT 仅发 `{id, quota}`，与 docs/04:67 契约警告矛盾（待验证远端行为）
- [ ] 对账盲区：`creditsAmount<=0` 过滤会让漏配 credits 的订单静默消失
- [ ] 对账 LIMIT 100 会让老差异滑出窗口
- [ ] `resolveTopUpCheckout` 未拒绝非 one-time interval（订阅暗门：续费只发 ShipAny credits、quota 不加）
- [ ] ShipAny credits 双轨残留：每单仍写无人消费的 credit 表
- [ ] 支付取消/失败落地 `/pricing`（→ redirect /models），脱离上下文且无提示
- [ ] `adjust-quota` 金额未限整数、无上限（10.5 会破坏 amountUsd 整型约定）
- [ ] 管理员减额无二次确认
- [ ] 补偿三件套（retry/reconciliation）只有 API 无界面；admin 无订单列表可查 orderNo
- [ ] Creem webhook 签名用 `!==` 比较，应换 `crypto.timingSafeEqual`

### 控制台与交互

- [ ] dashboard SSR 无新鲜度短路，连续导航重复触发远端同步
- [ ] key 状态同步每次列表都写库（应仅在字段变化时写）
- [ ] Key 禁用后无法在门户重新启用（New API 契约支持 `status_only`）
- [ ] 复制掩码 Key 按钮易误导（掩码含 `****` 无实际用途）
- [ ] 掩码格式在首次状态同步后变化（本地 `sk-x****` → 远端格式）
- [ ] admin 用户详情页隐式触发 lazy provision，为未用过 API 的用户创建 New API 账号
- [ ] 忘记密码入口被注释，邮箱登录无自助找回路径
- [ ] 服务端 `toLocaleString()` 裸调，格式/时区跟随服务器而非用户

### 目录与 admin

- [ ] 模型无能力标签时在公开页/建 Key 候选中静默消失
- [ ] 分组列表不展示 ratio / pricingSyncStatus（加两列可降低 P0-3 误操作概率）
- [ ] 字典删除被阻止时不展示引用明细（service 已算好 label+count，delete 页吞掉）
- [ ] `setModelCapabilities` / `setModelCategories` 非事务 delete+insert，insert 失败会清空能力
- [ ] `deleteModel` 漏删 `catalog_model_price`，依赖 FK cascade 而 FK 运行时开关未验证
- [ ] 无折扣 listing 经模型编辑后 `discountRateBps` null→10000 脏写（`models/[id]/edit/page.tsx:215` 的 `|| '10'` 默认值）
- [ ] DB 驱动文案单语：模型描述、折扣备注直接透出录入语言
- [ ] smoke 脚本 `quotaSpendFromUsageLogs` 未防负数（仅影响对账误报）

### 站点结构 / 视觉 / SEO

- [ ] zh 法律术语不一致：页脚「服务条款」vs 正文/注册页「用户协议」
- [ ] hreflang alternate 恒指首页，不含当前路径
- [ ] `sitemap.xml` 静态且已过期（lastmod 全 2026-05-24，仅 6 URL）
- [ ] 法律页被 robots disallow（确认是否有意）
- [ ] 文档站顶部导航无回主站/控制台入口
- [ ] 签退状态首屏两个 primary 实心按钮，违反 docs/05 §5「每屏主按钮 ≤1」
- [ ] 规范外颜色：BalanceWarning 用 amber、首页 vignette 用 emerald/teal 渐变
- [ ] 死翻译资产与 `localeMessagesPaths` 漂移（landing / activity/* / ai/* 等永不加载）
- [ ] `getAllConfigs()`（含全部密钥）直接喂 root layout 的 ads/analytics 服务，属"改一行就出事"的脆弱面
- [ ] admin settings 的 `collectNonEmptyConfigs` 跳过空值，配置项无法从 UI 清空

## 上线前人工检查（非代码）

- [ ] Caddy 边界修复后三子域公网可达面实测
- [ ] `/opt/apipool-v2/.env.deploy` 权限 600、密钥真随机、GHCR 仓库 private
- [ ] New API root 密码强度、`payment_compliance` 已确认
- [ ] 支付配置：`paypal_enabled=false` 或 `paypal_environment=production`
- [ ] Stripe dashboard 只勾选代码已映射的 5 种事件（P1-2 修复前尤其重要）
- [ ] Stripe/Creem 密钥填 admin settings 并跑一笔测试模式全链路——同时复验 P0-7 新增的 webhook 守卫 `assertPaymentSessionMatchesOrder` 不误拒真实回调（含折扣码场景）
- [ ] 告警三条（webhook 失败 / ledger pending 超时 / bridge unauthorized）接监控或明确接受裸奔——P1-1 的 processing 卡死也依赖这里发现
- [ ] 备份 restore 演练（`backup.sh` 只备份未演练；`deploy.sh` 明确"数据库不自动回滚"）
- [ ] 域名规划确认（app/api2/newapi 子域 vs apipool.dev 上游站冲突）
- [ ] libsql 运行时 `PRAGMA foreign_keys` 实测一次
- [ ] ads/analytics/affiliate 若启用，grep 复核其只读公开配置键
- [ ] P0-4 / P0-5 修复后起服务 live 复验（`/api/docs/search` 与 `/favicon.ico`）

## 已知遗留复核

- [x] OQ-3 roles/users 4 个 edit handler 缺 requirePermission —— 2026-07-08 复核已修复，回链提交 `0696a79 fix(security): roles/users 写 handler 二次鉴权对齐页首门控（OQ-3）`
- [ ] `ensurePortalUserBinding` 凭据失效不自愈（维持 defer，建议与 P1-9 一并处理）
- [ ] OQ-1 libsql `PRAGMA foreign_keys` 未验证（见上人工检查项；`deleteModel` 依赖其 cascade）
