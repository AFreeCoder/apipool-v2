# 07 部署与运维手册

> 本手册是 MVP 上线的发布门禁，覆盖完整闭环：注册 → 充值 → 建 Key → 真实调用 → 用量可见 → 禁用 Key 被拒。

> **容器化部署件（2026-06）**：仓库已提供本地/服务器两用的 `docker-compose.yml`（门户 `apipool-v2` + `new-api` 两服务）、门户 `Dockerfile`（构建期注入 `NEXT_PUBLIC_*`、esbuild 打包迁移、entrypoint 启动时自动建表并 fail-fast 校验密钥）、`.env.deploy.example` 与一次性引导手册 [`deploy/bootstrap.md`](../deploy/bootstrap.md)。具体起服务步骤以 `deploy/bootstrap.md` 为准；本手册聚焦发布门禁、安全与回滚。门户与 New API 已完成本地及服务器实跑验证，当前生产形态（腾讯云 VPS + Caddy + GitHub Actions CI/CD）见下文各节。

## 0. 当前 VPS

- 云服务器：腾讯云轻量服务器，实例 `ins-ep486xqw`，区域 `na-siliconvalley`，公网 IP `43.135.146.49`。
- SSH：本机 `~/.ssh/config` 使用别名 `apipool_vps`，端口 `22222`，用户 `root`，私钥文件 `~/.ssh/silicon_2.pem`（权限应为 `400`）。
- 连接命令：`ssh apipool_vps`。
- SSHD：服务器已同时监听 `22` 和 `22222`；日常运维走 `22222`。云防火墙/安全组需保持 TCP `22222` 入站放行。
- 系统：Debian GNU/Linux 13 (`trixie`)。
- Docker：已切到 Docker 官方 apt 源并启用开机自启。当前版本：Docker `29.5.3`，Docker Compose plugin `v5.1.4`，Buildx `v0.34.1`，sqlite3 `3.46.1-7+deb13u1`。若现场版本与本节不一致，以 `deploy/server-bootstrap.sh` 重新对齐后更新此记录。

## 1. 必需环境变量

### 基础

- `DATABASE_PROVIDER` / `DATABASE_URL`
- `AUTH_SECRET` / `AUTH_URL` —— **容器 entrypoint fail-fast：`AUTH_SECRET` 必须非空且 ≥16 字符**（空值会让 Better Auth 回退已知默认签名密钥），否则拒绝启动。用 `openssl rand -base64 32` 生成。
- `NEXT_PUBLIC_APP_URL=https://new.apipool.dev`（`NEXT_PUBLIC_*` 为构建期注入，容器需在 build 时经 build arg 传入，运行期改值不生效；正式切换主域名前与 Caddy 门户域名保持一致）

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
- `APIPOOL_SMOKE_MODEL`（可选；默认使用配置里的 smoke-tested launch model）
- `APIPOOL_SMOKE_QUOTA_USD`（可选；默认 `1`，必须为正数）
- `APIPOOL_SMOKE_USAGE_ATTEMPTS` / `APIPOOL_SMOKE_USAGE_DELAY_MS`（可选；用量延迟时调整轮询）
- `APIPOOL_SMOKE_REQUIRE_LIVE=true`：缺少 live smoke 必需配置时让 smoke 失败，而不是跳过。

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

### 3.1 自动化 MVP smoke

发布前先确认本地或发布环境数据库已迁移，且目录种子已写入至少一个 provider/group/model/listing：

```bash
npm run catalog:init
```

`official` 分组必须在后台维护好 `newapiGroup`，并与 New API 侧真实可调用 group 对齐；不能让 `official.newapiGroup` 为空落入 New API 默认分组。New API 侧也必须启用同名或指定分组：`GroupRatio` 包含该 group，相关 channel 的 group 包含该 group，并通过 New API 后台保存渠道或重建 abilities 使选路表生效。门户创建 Key 时会把 New API 用户 group 补齐到本次 `newapiGroup`，否则 New API 会以无权访问该分组拒绝 `/v1` 调用。

冒烟用户由 `APIPOOL_SMOKE_PORTAL_USER_ID` 指定，调额操作人由 `APIPOOL_SMOKE_OPERATOR_USER_ID` 指定，后者必须拥有 `admin.apipool.quota.adjust` 权限。`APIPOOL_SMOKE_MODEL` 指向一个可调用且 smoke-tested 的模型；不设置时使用默认 launch model。`APIPOOL_SMOKE_QUOTA_USD` 控制本次冒烟加额，默认 `1`。

普通本地验证允许缺少 live smoke 必需配置时跳过：

```bash
npm run smoke:mvp
```

发布若依赖真实或等价 New API 证据，必须使用强制 live 门禁：

```bash
APIPOOL_SMOKE_REQUIRE_LIVE=true npm run smoke:mvp
```

该脚本会创建 `official` 分组绑定的 API Key、执行一次模型调用、等待用量和 token split 可见、禁用 Key 并确认禁用后调用被拒。成功路径会留下一个已禁用的 smoke Key；如需完全清理，可在 `/dashboard/api-keys` 或后台按该用户删除该 Key。失败路径会尝试先禁用已创建的 Key，并在输出中记录 cleanup 状态。

## 3.5 自动化部署流程

生产部署由 GitHub Actions 构建镜像、VPS 拉取指定镜像、部署脚本先备份后切换容器三段组成。

### GitHub CI 镜像

- 工作流：`.github/workflows/docker-build.yaml`
- 镜像仓库：`ghcr.io/afreecoder/apipool-v2`
- 触发：push 到 `main` / `dev`、PR、手动 `workflow_dispatch`
- tag：`sha-<完整 commit>`、分支名、tag 名；默认分支额外推 `latest`
- 构建期生产参数：
  - `NEXT_PUBLIC_APP_URL=https://new.apipool.dev`
  - `NEXT_PUBLIC_APIPOOL_API_BASE_URL=https://api.apipool.dev/v1`
  - `NEXT_PUBLIC_APIPOOL_DEFAULT_MODEL=gpt-5.4-mini`

生产部署必须使用 `sha-<commit>` 这类不可变 tag。`latest` 只用于人工排查，不作为正式发布输入。

### VPS 目录结构

服务器部署根目录固定为 `/opt/apipool-v2`：

```text
/opt/apipool-v2/
├── .env.deploy              # 生产密钥与运行时配置，root-only，不入库
├── release.env              # 当前 IMAGE_TAG，由 deploy.sh 写入
├── docker-compose.prod.yml  # 生产 compose，拉 GHCR 镜像
├── data/
│   ├── portal/              # 门户 SQLite
│   └── new-api/             # New API SQLite
├── backups/                 # 备份归档，chmod 700
└── deploy/
    ├── backup.sh
    ├── configure-caddy.sh
    ├── deploy.sh
    ├── server-bootstrap.sh
    └── systemd/
```

### 首次引导

从本机同步部署件到服务器（不包含 `.env.deploy` 密钥文件）：

```bash
rsync -az docker-compose.prod.yml deploy/ apipool_vps:/opt/apipool-v2/
ssh apipool_vps 'cd /opt/apipool-v2 && ./deploy/server-bootstrap.sh'
```

`server-bootstrap.sh` 同时安装 Caddy 并生成反代配置：

- `new.apipool.dev` → 门户 `127.0.0.1:3000`
- `newapi.apipool.dev` → New API `127.0.0.1:3001`

New API 管理面直接对公网开放登录页，并加 `X-Robots-Tag: noindex, nofollow`。上线后需确保 New API root 密码和后台账号权限已设置妥当。

复制 `deploy/env.production.example` 为服务器 `/opt/apipool-v2/.env.deploy` 后填写密钥。若需要先把容器跑起来但 New API 管理 token 尚未初始化，可临时设置：

```env
NEWAPI_INTEGRATION_ENABLED=false
APIPOOL_KEY_CREATION_ENABLED=false
```

完成 New API root 初始化并写入 `NEWAPI_ADMIN_TOKEN` 后，再改回 `true` 并重新执行部署。

私有 GHCR 镜像需要服务器先登录：

```bash
gh auth token | ssh apipool_vps 'docker login ghcr.io -u AFreeCoder --password-stdin'
```

### 部署命令

CI 成功后取完整 commit 对应的镜像 tag：

```bash
ssh apipool_vps 'cd /opt/apipool-v2 && ./deploy/deploy.sh sha-<commit>'
```

`deploy/deploy.sh` 会执行：

1. `deploy/backup.sh pre-deploy`，备份数据库目录和配置文件，只保留最近 2 次 pre-deploy 备份。
2. 写入 `release.env` 的 `IMAGE_TAG`。
3. `docker compose pull` 拉取门户镜像与 New API 镜像。
4. `docker compose up -d --remove-orphans` 切换容器。
5. 验证 `http://127.0.0.1:3001/api/status` 与 `http://127.0.0.1:3000/`。
6. 健康检查失败时尝试回滚到上一次 `IMAGE_TAG`；数据库不自动回滚，需根据备份人工恢复。

### 定时备份

`deploy/server-bootstrap.sh` 会安装并启用 `apipool-v2-backup.timer`：

```bash
systemctl list-timers apipool-v2-backup.timer --no-pager
```

timer 每天 `Asia/Shanghai` 04:00 执行：

```bash
/opt/apipool-v2/deploy/backup.sh daily
```

daily 备份包含 `data/`、`.env.deploy`、`release.env`、compose 文件和 deploy 脚本，只保留最近 7 天的 daily 备份。备份归档权限为 `600`，备份目录为 `700`，避免泄漏 `.env.deploy` 中的密钥。

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
