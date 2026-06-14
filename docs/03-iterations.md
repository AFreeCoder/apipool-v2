# 03 迭代计划

迭代按**可上线闭环**切分，不按功能模块切分。每个阶段结束时，系统处于一个可演示、可验收的状态；M1 起每个阶段都有真实联调验收。

## MVP 阶段（M0–M4）

### M0 基座准备与文档重建（1–2 天）

- 合并 `codex/apipool-mvp` 到 `main`，测试与构建确认基线绿。
- 恢复支付接线：拷回模板支付 API 路由（checkout/callback/notify），恢复 `publicSettingNames` 支付开关，反转守护测试。
- 砍页面：模型详情页转 redirect，清理导航/页脚死链，路由收敛为 5 页 + auth + admin + payment API。
- 重建 docs/01–07。

验收：构建与测试全绿；路由收敛；7 份文档完成。

### M1 bridge 按真实 New API 重写（3–5 天）— 内测闭环（不含支付）

- Spike（首日）：测试环境实测用户供给链路（admin 建用户 → 取用户 access token），结果固化进 04-newapi-contract.md。
- 重写 `src/features/newapi-bridge/server/client.ts` 端点层（9 个方法签名不变）。
- 适配 `portal.ts`：binding 表加密存储用户凭据（schema 迁移）、写操作门户侧幂等查重。
- 重写 bridge 单元测试。

验收：注册自动绑定 New API 用户 → admin 调额 $1 → 控制台显示余额 → 创建 Key → `curl api.apipool.dev/v1` 真实返回 → 用量页可见日志 → 禁用 Key 后调用 401。

### M2 支付打通（3–5 天）— 商业闭环

- 充值套餐（$5/$10/$50 一次性 credits）走模板 checkout。
- 加额执行器：webhook 入账后通过兑换码模式给 New API 加额（设计见 06-payments-ledger.md）。
- 账本幂等（order_no 唯一索引）、失败补偿、三方对账查询。
- Stripe 与 Creem 测试模式各跑通全流程。

验收：测试卡支付 $5 → 订单 paid → credit +$5 → ledger applied → New API quota 增加 → 控制台余额 +$5 一次过；webhook 重放 3 次只加额 1 次；模拟 New API 宕机后恢复重试不重不漏。

### M3 视觉规范落地与 5 页重做（5–8 天）— 门面闭环

- 按 05-design-system.md 重写 `src/config/style/theme.css` 全部 token。
- 重做首页、/models、/docs、控制台三 tab、登录注册换肤（后端契约不动）。
- 重写展示组件：site-shell、dashboard-shell、stat-card、api-key-manager。

验收：逐页对照 design-system checklist；375px 移动端可用；产品负责人对首页与控制台视觉验收通过（硬性关卡）。

### M4 端到端冒烟与上线（2–3 天）

- 生产部署（New API 实例 + 支付 live key），冒烟手册（07-runbook.md）逐步执行。
- webhook 失败与 bridge 审计最低告警。

> **进度（2026-06）**：部署工具已就绪并本地实跑闭环通过——`docker-compose.yml`（门户 + New API）、门户 `Dockerfile`（迁移并进启动 + 密钥 fail-fast）、`deploy/bootstrap.md`、env allowlist。非支付闭环（注册→绑定→调额→建 Key→调用→禁用 401）本地验证全过。**待用户备好 VPS 后**：在真实 Linux 容器复验（libsql 原生绑定、bind-mount 权限、构建内存、fail-fast/allowlist 端到端），并接 Stripe live。详见 `docs/superpowers/{specs,plans}/2026-06-13-minimal-deployment*`。

验收：生产环境全新账号完整跑通"注册 → 最小金额真实充值 → 建 Key → 真实调用 → 用量可见"，无人工介入；回滚演练一次。

## MVP 后迭代方向（粗粒度，每个迭代仍按闭环交付）

### 迭代 1：自助与可观测闭环

用量明细筛选与导出、简版账单页、Key 高级配置 UI（模型白名单/额度上限/IP 白名单，portal 字段已预留）、低余额邮件提醒（模板 Resend 现成）、失败请求排查视图。

### 迭代 2：增长闭环

模型目录从 New API 自动同步（替换 catalog.ts 手工 seed）、注册赠额、affiliate 推荐返佣（模板 extension 现成）、恢复博客做 SEO 内容、模型详情页按需恢复。

### 迭代 3：规模化闭环

团队/组织账户与成员 Key、订阅套餐制（模板 subscription 现成）、运营后台增强（对账报表、异常 watchdog、用户分层）、状态页。
