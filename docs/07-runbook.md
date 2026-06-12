# 07 部署与运维手册

> 本手册是 MVP 上线的发布门禁，覆盖完整闭环：注册 → 充值 → 建 Key → 真实调用 → 用量可见 → 禁用 Key 被拒。

## 1. 必需环境变量

### 基础

- `DATABASE_PROVIDER` / `DATABASE_URL`
- `AUTH_SECRET` / `AUTH_URL`
- `NEXT_PUBLIC_APP_URL=https://apipool.dev`

### New API 桥接（见 04-newapi-contract.md）

- `NEWAPI_INTEGRATION_ENABLED=true`
- `NEWAPI_BASE_URL`（内部服务地址，不暴露给浏览器）
- `NEWAPI_ADMIN_TOKEN` / `NEWAPI_ADMIN_USER_ID`
- `NEWAPI_QUOTA_PER_UNIT`（与实例核对）
- `APIPOOL_KEY_CREATION_ENABLED=true`
- `NEXT_PUBLIC_APIPOOL_API_BASE_URL=https://api.apipool.dev/v1`
- 凭据加密密钥（M1 定名，AES-256-GCM）

### 支付（见 06-payments-ledger.md）

- Stripe：`STRIPE_*`（secret key、webhook secret）
- Creem：`CREEM_*`（同上）
- webhook 回调地址在渠道后台配置为 `https://apipool.dev/api/payment/notify/<provider>`

### 冒烟

- `APIPOOL_SMOKE_PORTAL_USER_ID` / `APIPOOL_SMOKE_OPERATOR_USER_ID`

## 2. New API 运营面安全

`newapi.apipool.dev` 仅运营访问：

- New API 运营登录之外，再加一层边界（Basic Auth 或 IP 白名单）。
- `X-Robots-Tag: noindex, nofollow`。
- 不出现在公开导航、文档、sitemap、客服文案中。
- 门户桥接流量走 `NEWAPI_BASE_URL` 内部地址。

## 3. 部署验收顺序（不可跳步，后步通过不能替代前步失败）

1. **New API 健康检查**：内部地址 `GET /api/status` 返回 `success=true`。
2. **bridge 冒烟**：门户服务端能以管理员上下文认证，且浏览器侧无内部标识泄漏。
3. **门户构建**：`pnpm install --frozen-lockfile && pnpm test && pnpm lint && pnpm build`。
4. **充值冒烟**：冒烟账号最小金额真实支付 → 订单 paid → credit 入账 → ledger applied → New API quota 增加 → 控制台余额一致。
5. **建 Key 冒烟**：创建真实 Key，确认明文只展示一次。
6. **调用冒烟**：用该 Key 通过 `https://api.apipool.dev/v1` 调用发布模型成功，用量页可见日志。
7. **禁用拒绝冒烟**：禁用同一 Key，再调用收到拒绝。
8. **webhook 重放检查**：渠道后台重发最近一条 webhook，确认不重复入账/加额。

GitHub `APIPool MVP Verify` workflow 在 push/PR 上跑本地验证；生产密钥配置后用 `workflow_dispatch` 跑真实冒烟门禁。

## 4. 告警最低配置

- webhook 处理失败（5xx 或入账异常）→ 告警。
- ledger 行停留 `pending` 超过 10 分钟 → 告警。
- bridge 连续 `unauthorized`/`timeout` → 告警。

## 5. 回滚顺序（保留用户资产与审计）

1. 置 `APIPOOL_KEY_CREATION_ENABLED=false`，停止新 Key 创建。
2. 在支付渠道后台暂停支付（或下架套餐），避免回滚窗口内新订单。
3. 门户回滚到上一个稳定部署。
4. 不删除已有 New API key、不删除 ledger、不删除订单。
5. 保留调额记录与 bridge 审计日志用于对账；窗口期内的 paid 订单按 06 文档对账流程补加额。

远端成功但本地绑定失败的 Key 保持 `remote_created_binding_failed`，从审计日志人工补偿；本地与远端一致前，不在用户界面显示成功。
