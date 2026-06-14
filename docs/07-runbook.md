# 07 部署与运维手册

> 本手册是 MVP 上线的发布门禁，覆盖完整闭环：注册 → 充值 → 建 Key → 真实调用 → 用量可见 → 禁用 Key 被拒。

> **容器化部署件（2026-06）**：仓库已提供本地/服务器两用的 `docker-compose.yml`（门户 `apipool-v2` + `new-api` 两服务）、门户 `Dockerfile`（构建期注入 `NEXT_PUBLIC_*`、esbuild 打包迁移、entrypoint 启动时自动建表并 fail-fast 校验密钥）、`.env.deploy.example` 与一次性引导手册 [`deploy/bootstrap.md`](../deploy/bootstrap.md)。具体起服务步骤以 `deploy/bootstrap.md` 为准；本手册聚焦发布门禁、安全与回滚。已本地实跑闭环验证（详见 `docs/superpowers/plans/2026-06-13-minimal-deployment.md` 的「验证记录」与「待 Linux 容器复验」清单）。

## 1. 必需环境变量

### 基础

- `DATABASE_PROVIDER` / `DATABASE_URL`
- `AUTH_SECRET` / `AUTH_URL` —— **容器 entrypoint fail-fast：`AUTH_SECRET` 必须非空且 ≥16 字符**（空值会让 Better Auth 回退已知默认签名密钥），否则拒绝启动。用 `openssl rand -base64 32` 生成。
- `NEXT_PUBLIC_APP_URL=https://apipool.dev`（`NEXT_PUBLIC_*` 为构建期注入，容器需在 build 时经 build arg 传入，运行期改值不生效）

### New API 桥接（见 04-newapi-contract.md）

- `NEWAPI_INTEGRATION_ENABLED=true`
- `NEWAPI_BASE_URL`（内部服务地址，不暴露给浏览器）
- `NEWAPI_ADMIN_TOKEN` / `NEWAPI_ADMIN_USER_ID`
- `NEWAPI_QUOTA_PER_UNIT`（与实例核对）
- `APIPOOL_KEY_CREATION_ENABLED=true`
- `NEXT_PUBLIC_APIPOOL_API_BASE_URL=https://api.apipool.dev/v1`
- `APIPOOL_CREDENTIALS_SECRET`（AES-256-GCM 凭据加密密钥；与 `AUTH_SECRET` 同样被 entrypoint fail-fast 校验非空 ≥16 字符）
- 集成开启时（默认开），`NEWAPI_ADMIN_TOKEN` / `NEWAPI_ADMIN_USER_ID` 必填，否则 entrypoint 拒绝启动（避免绑定/建 Key 拖到用户操作时才失败）
- **凭据隔离**：仅引导脚本用的 `NEWAPI_ROOT_USER` / `NEWAPI_ROOT_PASS` 不进门户容器（compose 用 `environment:` allowlist 而非 `env_file:`）

### 支付（见 06-payments-ledger.md）

- Stripe：`STRIPE_*`（secret key、webhook secret）
- Creem：`CREEM_*`（同上）
- webhook 回调地址在渠道后台配置为 `https://apipool.dev/api/payment/notify/<provider>`

### 冒烟

- `APIPOOL_SMOKE_PORTAL_USER_ID` / `APIPOOL_SMOKE_OPERATOR_USER_ID`

## 1.5 New API 实例初始化（每个新实例一次性，✅已实测）

1. 启动容器：用 `docker-compose.yml` 的 `new-api` 服务（推荐），或独立 `docker run -d --name apipool-newapi -p <port>:3000 -v <数据目录>:/data calciumion/new-api:latest`。
2. 初始化 root：`POST /api/setup` body `{username:"root", password, confirmPassword}`（未初始化前所有登录失败，日志报 `no root user exists`）。密码限 8-20 字符。
3. root 登录拿 cookie 会话后，确认支付合规（**兑换码功能**的前置开关，充值/加额走兑换码模式时必做）：`POST /api/option/payment_compliance` body `{confirmed:true}`——必须用 dashboard 会话，API token 会被拒。
4. 生成管理员 access token：cookie 会话 + `New-Api-User: 1` 调 `GET /api/user/token`，存入 `NEWAPI_ADMIN_TOKEN`。注意该接口是重新生成语义，调用后旧 token 失效。
   > 步骤 2+4 已由 [`deploy/newapi-token.sh`](../deploy/newapi-token.sh) 自动化（setup root → login → 取 token）。
5. 配置至少一个上游渠道，否则 `/v1/chat/completions` 报 `model_not_found: No available channel`。**实测要点（calciumion/new-api rc.10）**：
   - 建渠道 API 必须用 `{"mode":"single","channel":{…}}` 包装（裸 channel 对象触发服务端 panic）。
   - 模型需配价，否则调用报 `model_price_error`；最小化可开**自用模式** `PUT /api/option/` body `{"key":"SelfUseModeEnabled","value":"true"}` 绕过逐模型配价。
   - **给用户充值额度**：`PUT /api/user/` 不改 `quota`；正路是**兑换码模式**（需步骤 3 的 payment_compliance + 门户运营 RBAC，门户 `adjustPortalQuota` 走这条），本地最小验证可直接改 New API SQLite。
   - 具体 curl 见 `deploy/bootstrap.md` §3。

本地开发实例：宿主机端口 3001（`NEWAPI_BASE_URL=http://127.0.0.1:3001`），数据落 `data/new-api/`（已 gitignore）。

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
