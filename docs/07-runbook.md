# 07 部署与运维手册

> 本手册是 MVP 上线的发布门禁，覆盖完整闭环：注册 → 充值 → 建 Key → 真实调用 → 用量可见 → 禁用 Key 被拒。

> **容器化部署件（2026-06）**：仓库已提供本地/服务器两用的 `docker-compose.yml`（门户 `apipool-v2`、`new-api` 与内网 `newapi-metadata-filter` 三服务）、门户 `Dockerfile`（构建期注入 `NEXT_PUBLIC_*`、esbuild 打包迁移、entrypoint 启动时自动建表并 fail-fast 校验密钥）、`.env.deploy.example` 与一次性引导手册 [`deploy/bootstrap.md`](../deploy/bootstrap.md)。具体起服务步骤以 `deploy/bootstrap.md` 为准；本手册聚焦发布门禁、安全与回滚。门户与 New API 已完成本地及服务器实跑验证，当前生产形态（腾讯云 VPS + Caddy + GitHub Actions CI/CD）见下文各节。

## 0. 当前 VPS

- 云服务器：腾讯云轻量服务器，实例 `ins-ep486xqw`，区域 `na-siliconvalley`，公网 IP `43.135.146.49`。
- SSH：本机 `~/.ssh/config` 使用别名 `apipool_vps`，端口 `22222`，用户 `root`，私钥文件 `~/.ssh/silicon_2.pem`（权限应为 `400`）。
- 连接命令：`ssh apipool_vps`。
- SSHD：仅保留 `22222`；腾讯云防火墙与主机防火墙都只允许 owner 的固定公网 IP/CIDR 访问该端口。TCP `22` 不监听、不放行。
- 系统：Debian GNU/Linux 13 (`trixie`)。
- Docker：已切到 Docker 官方 apt 源并启用开机自启。当前版本：Docker `29.5.3`，Docker Compose plugin `v5.1.4`，Buildx `v0.34.1`，sqlite3 `3.46.1-7+deb13u1`。若现场版本与本节不一致，以 `deploy/server-bootstrap.sh` 重新对齐后更新此记录。

## 0.5 域名迁移期 DNS

排空期 v2 只接管新增用户入口，不接管老站契约域名：

- `app.apipool.dev`：Cloudflare 代理（橙云），指向 v2 VPS，承载站点、登录、控制台、支付回调和 OAuth 回调。
- `api2.apipool.dev`：DNS only（灰云），直接指向 v2 VPS，临时把全部
  `/v1*` 请求转发到 New API，供单一测试用户使用原生 Key，绕开
  Cloudflare HTTP 请求时长上限。
- `newapi.apipool.dev`：Cloudflare 代理（橙云），指向 v2 VPS，仅运营访问，继续 noindex。
- `apipool.dev`：排空期继续指向老站，保留品牌与 SEO；cutover 后回收给 v2 营销站。
- `api.apipool.dev`：排空期继续指向老站；老用户改用旧站新的迁移域名后，
  回收给门户正式 API。`api2.apipool.dev` 仅保留到单一临时测试用户迁移完成。

Cloudflare / DNS 变更必须按上述归属分阶段执行。任何把 `apipool.dev` 或 `api.apipool.dev` 提前切到 v2 的操作，都会打断老用户或制造迁移风险。

## 1. 必需环境变量

### 基础

- `DATABASE_PROVIDER` / `DATABASE_URL`
- `AUTH_SECRET` / `AUTH_URL` —— **容器 entrypoint fail-fast：`AUTH_SECRET` 必须非空且 ≥16 字符**（空值会让 Better Auth 回退已知默认签名密钥），否则拒绝启动。用 `openssl rand -base64 32` 生成。
- `NEXT_PUBLIC_APP_URL=https://app.apipool.dev`（`NEXT_PUBLIC_*` 为构建期注入，容器需在 build 时经 build arg 传入，运行期改值不生效；排空期与 Caddy 门户域名保持一致）

### New API 桥接（见 04-newapi-contract.md）

- `NEWAPI_INTEGRATION_ENABLED=true`
- `NEWAPI_BASE_URL`（内部服务地址，不暴露给浏览器）
- `NEWAPI_ADMIN_TOKEN` / `NEWAPI_ADMIN_USER_ID`
- `NEWAPI_QUOTA_PER_UNIT`（与实例核对）
- `APIPOOL_KEY_CREATION_ENABLED=true`
- `NEXT_PUBLIC_APIPOOL_API_BASE_URL`（不含协议路径；门户正式上线时设为
  `https://api.apipool.dev`。临时直连 `api2` 使用 New API 原生 Key，不作为门户
  Key 的公开 endpoint）
- `APIPOOL_CREDENTIALS_SECRET`（AES-256-GCM 凭据加密密钥；与 `AUTH_SECRET` 同样被 entrypoint fail-fast 校验非空 ≥16 字符）
- 集成开启时（默认开），`NEWAPI_ADMIN_TOKEN` / `NEWAPI_ADMIN_USER_ID` 必填，否则 entrypoint 拒绝启动（避免绑定/建 Key 拖到用户操作时才失败）
- **凭据隔离**：仅引导脚本用的 `NEWAPI_ROOT_USER` / `NEWAPI_ROOT_PASS` 不进门户容器（compose 用 `environment:` allowlist 而非 `env_file:`）

### 支付（见 06-payments-ledger.md）

- Stripe：`STRIPE_*`（secret key、webhook secret）
- Creem：`CREEM_*`（同上）
- webhook 回调地址在渠道后台配置为 `https://app.apipool.dev/api/payment/notify/<provider>`

### 冒烟

- 生产 live smoke 只在 VPS 本地运行：这些变量保留在 `/opt/apipool-v2/.env.deploy`，不要放进 GitHub Actions secrets。
- `APIPOOL_SMOKE_PORTAL_USER_ID` / `APIPOOL_SMOKE_OPERATOR_USER_ID`
- `APIPOOL_SMOKE_PORTAL_EMAIL=smoke.portal@apipool.local` / `APIPOOL_SMOKE_OPERATOR_EMAIL=smoke.operator@apipool.local`（固定值；`deploy/setup-smoke-users.sh --apply` 创建/复用专用 service identity，live smoke 会拒绝其它邮箱）
- `APIPOOL_SMOKE_GROUP_SLUG`（可选；默认 `official`，可指定实际售卖分组如 `discount-1`）
- `APIPOOL_SMOKE_MODEL`（可选；设置时必须在 `APIPOOL_SMOKE_GROUP_SLUG` 对应分组中可调用；不设置时使用该分组的默认或首个可调用模型）
- `APIPOOL_SMOKE_QUOTA_USD`（可选；默认 `1`，必须为正数）
- `APIPOOL_SMOKE_USAGE_ATTEMPTS` / `APIPOOL_SMOKE_USAGE_DELAY_MS`（可选；用量延迟时调整轮询）
- `APIPOOL_SMOKE_REQUIRE_LIVE=true`：缺少 live smoke 必需配置时让 smoke 失败，而不是跳过。
- `APIPOOL_SMOKE_PRICE_RECONCILIATION=true`：在 live smoke 调用后强制做展示价与 New API 实际扣费口径对账。
- `APIPOOL_SMOKE_PRICE_TOLERANCE_QUOTA`（可选；默认 `1`）：价格对账允许的 quota 误差。

## 1.5 New API 实例初始化（每个新实例一次性，✅已实测）

1. 启动容器：用 `docker-compose.yml` 的 `new-api` 服务（推荐），或独立 `docker run -d --name apipool-newapi -p <port>:3000 -v <数据目录>:/data calciumion/new-api:latest`。
2. 初始化 root：`POST /api/setup` body `{username:"root", password, confirmPassword}`（未初始化前所有登录失败，日志报 `no root user exists`）。密码限 8-20 字符。
3. root 登录拿 cookie 会话后，确认支付合规（**兑换码功能**的前置开关，充值/加额走兑换码模式时必做）：`POST /api/option/payment_compliance` body `{confirmed:true}`——必须用 dashboard 会话，API token 会被拒。
4. 生成管理员 access token：cookie 会话 + `New-Api-User: 1` 调 `GET /api/user/token`，存入 `NEWAPI_ADMIN_TOKEN`。注意该接口是重新生成语义，调用后旧 token 失效。
   > 步骤 2+4 已由 [`deploy/newapi-token.sh`](../deploy/newapi-token.sh) 自动化（setup root → login → 取 token）。
5. 配置至少一个上游渠道，否则 `/v1/chat/completions` 报 `model_not_found: No available channel`。**实测要点（calciumion/new-api rc.10）**：
   - 建渠道 API 必须用 `{"mode":"single","channel":{…}}` 包装（裸 channel 对象触发服务端 panic）。
   - 模型需配价，否则调用报 `model_price_error`；最小化可开**自用模式** `PUT /api/option/` body `{"key":"SelfUseModeEnabled","value":"true"}` 绕过逐模型配价。
   - New API 原生直连账户如需调整其自身 quota，`PUT /api/user/` 不改 `quota`，应使用兑换码模式。门户用户的可用余额不走这条链路，统一由 APIPool 本地钱包管理。
   - 具体 curl 见 `deploy/bootstrap.md` §3。

本地开发实例：宿主机端口 3001（`NEWAPI_BASE_URL=http://127.0.0.1:3001`），数据落 `data/new-api/`（已 gitignore）。

## 2. New API 运营面安全

`newapi.apipool.dev` 仅运营访问。入口分为两层，不能互相替代：

- New API 运营登录与其自身权限仍是应用层认证；下面的源站边界和运营面守卫是额外的网络/代理层防线。
- **源站边界（强制）**：Caddy 只接受 `deploy/cloudflare-ips.txt` 中的 Cloudflare TCP 源地址；缺少、为空或存在非法 CIDR 时配置生成 fail-closed。该边界同时覆盖 `app.apipool.dev` 和 `newapi.apipool.dev`，防止绕过 Cloudflare 直接访问源站。
- **运营面守卫（可选叠加）**：New API 自身登录之外，可再配置 Basic Auth 或额外 IP 守卫；两者都未配置时脚本默认 fail-closed 退出 78。
  - **退出开关**：`APIPOOL_NEWAPI_ALLOW_UNPROTECTED=true` 只跳过运营面守卫，绝不会跳过上述 Cloudflare 源站边界。
  - `APIPOOL_NEWAPI_BASIC_AUTH_USER` + `APIPOOL_NEWAPI_BASIC_AUTH_HASH`（哈希用 `caddy hash-password --plaintext '<password>'` 生成）
  - `APIPOOL_NEWAPI_ALLOWED_IPS`（空格分隔的 IP/CIDR）
  - **写进 `.env.deploy` 时这两个值必须用单引号包起来**：`deploy/live-smoke.sh` 会 `source` 该文件，bcrypt 哈希里的 `$` 会被 shell 展开（`$2a$14$...` → `a4`，`basicauth` 谁也登不上），空格分隔的 IP 白名单里第二个 IP 会被当成命令执行、在 `set -e` 下直接中断部署。`configure-caddy.sh` 自己按字面量读取该文件，加不加引号都能正确解析。
  - 两项均配则同时生效（先过 IP 白名单，再过 Basic Auth）。变量写在 `/opt/apipool-v2/.env.deploy`；`server-bootstrap.sh` 把该文件路径经 `APIPOOL_DEPLOY_ENV_FILE` 交给 `configure-caddy.sh`，由后者按字面量读取（不 source）。
- `X-Robots-Tag: noindex, nofollow`。
- 不出现在公开导航、文档、sitemap、客服文案中。
- 门户桥接流量走 `NEWAPI_BASE_URL` 内部地址。

`api2.apipool.dev` 与 New API 管理面共用同一个上游容器（`127.0.0.1:3001`）。
Caddy 允许 `/v1*` 下的所有路径原样进入 New API，不再套用门户网关端点
白名单；其余路径（含 `/api/*` 管理接口）一律返回 404。

上线前实测三个子域的可达面（预期结果）：

```bash
curl -sS -o /dev/null -w '%{http_code}\n' https://api2.apipool.dev/v1/models   # 401（需 sk- key），非 404
curl -sS -o /dev/null -w '%{http_code}\n' https://api2.apipool.dev/api/status  # 404
curl -sS -o /dev/null -w '%{http_code}\n' https://newapi.apipool.dev/          # 200/401 取决于运营守卫，但必须经 Cloudflare
```

预跑生成的配置（无需 root，不改系统）：`bash deploy/configure-caddy.sh --print-config`。

**Caddy 配置何时生效**：`deploy/deploy.sh` 在每次部署开始时（备份与拉镜像**之前**）重新生成并 `caddy validate` 配置，然后 `systemctl reload caddy`。因此在 `.env.deploy` 里改动保护变量后，**下一次部署即生效**，无需手工操作。放在最前面是为了让 fail-closed（退出 78）成为零副作用中止，而不是留下半成品状态。

- 只在 caddy 缺失时才 `apt install`，避免每次部署顺带升级版本。
- **该步骤会覆盖 `/etc/caddy/Caddyfile`**。任何手工改动都会丢失，请改到 `configure-caddy.sh` 里。
- 想立即生效而不等下次部署：在 VPS 上执行
  `cd /opt/apipool-v2 && APIPOOL_DEPLOY_ENV_FILE=/opt/apipool-v2/.env.deploy ./deploy/configure-caddy.sh`。

## 3. 部署验收顺序（不可跳步，后步通过不能替代前步失败）

1. **元数据过滤器健康检查**：容器必须为 `healthy`；它不开放宿主机端口。
2. **New API 健康检查**：内部地址 `GET /api/status` 返回 `success=true`。
3. **bridge 冒烟**：门户服务端能以管理员上下文认证，且浏览器侧无内部标识泄漏。
4. **门户构建**：`pnpm install --frozen-lockfile && pnpm test && pnpm lint && pnpm build`。
5. **充值冒烟**：冒烟账号最小金额真实支付 → 订单 paid → wallet recharge 入账且 credit 不新增 → 控制台余额一致；不得再以 New API quota 作为门户余额。
6. **建 Key 冒烟**：创建真实 Key，确认明文只展示一次。
7. **调用冒烟**：门户 Key 通过容器内网网关调用发布模型；临时公网
   `https://api2.apipool.dev` 另用 New API 原生 Key 验证真实 `/v1/models`、
   图片等实际端点可调用。
8. **禁用拒绝冒烟**：禁用同一 Key，再调用收到拒绝。
9. **webhook 重放检查**：渠道后台重发最近一条 webhook，确认不重复入账/加额。

GitHub `APIPool MVP Verify` workflow 在 push/PR/手动触发时只跑无密钥本地验证。生产真实冒烟门禁必须在 VPS 上执行 `deploy/live-smoke.sh`，使用服务器本地 `.env.deploy`；不要把 `DATABASE_URL`、`NEWAPI_ADMIN_TOKEN` 或 smoke 用户 ID 配到 GitHub Actions。

### 3.1 自动化 MVP smoke

发布前先确认本地或发布环境数据库已迁移，且目录种子已写入至少一个 provider/group/model/listing：

```bash
npm run catalog:init
```

冒烟分组默认是 `official`，也可以通过 `APIPOOL_SMOKE_GROUP_SLUG` 指向实际售卖分组。该分组必须在后台维护好 `newapiGroup`，并与 New API 侧真实可调用 group 对齐；不能让 `newapiGroup` 为空落入 New API 默认分组。New API 侧也必须启用同名或指定分组：`GroupRatio` 包含该 group，相关 channel 的 group 包含该 group，并通过 New API 后台保存渠道或重建 abilities 使选路表生效。门户创建 Key 时会把 New API 用户 group 补齐到本次 `newapiGroup`，否则 New API 会以无权访问该分组拒绝 `/v1` 调用。

冒烟用户由 `APIPOOL_SMOKE_PORTAL_USER_ID` 指定，调额操作人由 `APIPOOL_SMOKE_OPERATOR_USER_ID` 指定，后者必须拥有 `admin.apipool.quota.adjust` 权限。冒烟调额写入本地钱包，不修改 New API quota。`APIPOOL_SMOKE_MODEL` 设置时必须指向当前冒烟分组中可调用的模型；不设置时使用该分组中的默认或首个可调用模型。`APIPOOL_SMOKE_QUOTA_USD` 控制本次冒烟加额，默认 `1`。

普通本地验证允许缺少 live smoke 必需配置时跳过：

```bash
npm run smoke:mvp
```

发布若依赖真实或等价 New API 证据，必须使用强制 live 门禁：

```bash
ssh apipool_vps 'cd /opt/apipool-v2 && ./deploy/setup-smoke-users.sh --apply'
ssh apipool_vps 'cd /opt/apipool-v2 && ./deploy/live-smoke.sh --no-price-reconciliation'
```

模型目录价格策略发布还必须补跑价格对账门禁：

```bash
ssh apipool_vps 'cd /opt/apipool-v2 && ./deploy/setup-smoke-users.sh --apply'
ssh apipool_vps 'cd /opt/apipool-v2 && ./deploy/live-smoke.sh'
```

价格对账会读取本次调用对应模型和冒烟分组的 confirmed effective price，并用 usage log 或 quota delta 计算 `expected/actual/delta/tolerance`。若 usage log 没有 token 与 cost/quota，且调用前后 quota delta 也不可用，脚本必须失败；失败不能发布。

`deploy/setup-smoke-users.sh --apply` 会先做 `pre-smoke-users` 备份，再按固定邮箱创建/复用两个不可登录的 production service identity：普通 smoke portal user 固定为 `smoke.portal@apipool.local`，带 `role_operator` 的 smoke operator 固定为 `smoke.operator@apipool.local`，并把邮箱与 user id 写回 `.env.deploy`。两者必须分离，以验证“被调额用户”和“执行调额的权限主体”不是同一身份；live smoke 会同时校验环境变量和数据库中的实际邮箱，避免误用真实用户造成记录污染。该脚本默认 dry-run，必须显式传 `--apply` 才写库。

`deploy/live-smoke.sh` 使用当前 `release.env` 中的门户镜像启动一次性容器，不依赖服务器源码。该脚本会创建冒烟分组绑定的 API Key、执行一次模型调用、等待用量和 token split 可见、禁用 Key 并确认禁用后调用被拒。成功路径会留下一个已禁用的 smoke Key；如需完全清理，可在 `/dashboard/api-keys` 或后台按该用户删除该 Key。失败路径会尝试先禁用已创建的 Key，并在输出中记录 cleanup 状态。

### 3.2 New API option-map 修复

New API 日志如果反复出现 `failed to update option map: unexpected end of JSON input`，先按只读方式确认 `options` 表中的分组 JSON map。`theme.frontend=default` 是合法的字符串配置，不属于 JSON map 错误。

```bash
ssh apipool_vps 'sqlite3 -header -column /opt/apipool-v2/data/new-api/one-api.db "
select
  key,
  quote(value) as quoted,
  json_valid(value) as json_valid,
  case when json_valid(value) then json_type(value) else null end as json_type
from options
where key in (
  '\''GroupGroupRatio'\'',
  '\''group_ratio_setting.group_special_usable_group'\'',
  '\''theme.frontend'\''
)
order by key;"'
```

只允许用仓库脚本修复已确认的两个空 map 键：`GroupGroupRatio` 与 `group_ratio_setting.group_special_usable_group`。不要把该脚本接进 `deploy.sh` 自动执行；它是人工数据修复工具。

```bash
scp deploy/repair-newapi-options.sh apipool_vps:/tmp/repair-newapi-options.sh
ssh apipool_vps 'chmod 700 /tmp/repair-newapi-options.sh && /tmp/repair-newapi-options.sh'
```

`--apply` 前必须先做 pre-deploy 备份，并确认最新归档包含 New API SQLite：

```bash
ssh apipool_vps 'cd /opt/apipool-v2 && ./deploy/backup.sh pre-deploy'
ssh apipool_vps 'tar -tzf "$(ls -t /opt/apipool-v2/backups/pre-deploy-*.tar.gz | head -1)" | grep -E "data/new-api/one-api.db$"'
```

确认 dry-run 只报告上述两个键后再应用：

```bash
ssh apipool_vps '/tmp/repair-newapi-options.sh --apply'
```

脚本会打印 `rollback sql:` 和 `rollback sha256:`。如果需要回滚，只能在明确确认业务窗口内没有新的 New API 配置改动后执行该 SQL。

应用后回读数据库、检查健康和下一轮同步日志：

```bash
ssh apipool_vps 'sqlite3 -header -column /opt/apipool-v2/data/new-api/one-api.db "
select key, value, json_valid(value) as json_valid, json_type(value) as json_type
from options
where key in (
  '\''GroupGroupRatio'\'',
  '\''group_ratio_setting.group_special_usable_group'\''
)
order by key;"'
ssh apipool_vps 'curl -fsS http://127.0.0.1:3001/api/status'
ssh apipool_vps 'cd /opt/apipool-v2 && docker compose --env-file .env.deploy --env-file release.env -f docker-compose.prod.yml logs --since 5m new-api | grep -E "syncing options|failed to update option map" || true'
```

如果修复后一轮同步仍出现同一个 option-map 错误，才单独重启 New API，再重新检查 `/api/status` 与日志：

```bash
ssh apipool_vps 'cd /opt/apipool-v2 && docker compose --env-file .env.deploy --env-file release.env -f docker-compose.prod.yml restart new-api'
ssh apipool_vps 'curl -fsS http://127.0.0.1:3001/api/status'
ssh apipool_vps 'cd /opt/apipool-v2 && docker compose --env-file .env.deploy --env-file release.env -f docker-compose.prod.yml logs --since 2m new-api | grep -E "failed to update option map" || true'
```

## 3.5 自动化部署流程

生产部署由四段组成：GitHub 托管 Runner 构建并推送镜像、VPS 自托管 Runner 仅通过出站 HTTPS 接单、root-owned 包装器拉取指定镜像、部署脚本先备份后切换容器。VPS 不构建镜像，GitHub 托管 Runner 也不再通过 SSH 登录 VPS。

### GitHub CI 镜像

- 工作流：`.github/workflows/docker-build.yaml`
- 镜像仓库：`ghcr.io/afreecoder/apipool-v2`
- 触发：push 到 `main` / `dev`、PR、手动 `workflow_dispatch`
- tag：`sha-<完整 commit>`、分支名、tag 名；默认分支额外推 `latest`
- 构建期生产参数：
  - `NEXT_PUBLIC_APP_URL=https://app.apipool.dev`
  - `NEXT_PUBLIC_APIPOOL_API_BASE_URL=https://api2.apipool.dev`
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
    ├── configure-ingress-firewall.sh
    ├── deploy.sh
    ├── go-live.sh
    ├── install-production-tooling.sh
    ├── lib.sh
    ├── live-smoke.sh
    ├── server-bootstrap.sh
    ├── setup-smoke-users.sh
    └── systemd/
```

VPS 自托管 Runner 固定安装在 `/opt/actions-runner-apipool`，使用无登录 shell 的 `apipool-runner` 用户。它只能免密执行 root 持有的 `/usr/local/sbin/apipool-runner-deploy`；不能直接以 root 运行任意命令。

生产 compose 与 `deploy/` 是 owner 经 SSH 安装的固定 root-owned 工具链；Actions checkout 不能覆盖它们。工具链需要更新时必须单独走 SSH 审核安装。Runner 用户自身未加入 Docker 组，nftables 只允许其发起 DNS/HTTPS，并拒绝访问云 metadata 网段；Docker 拉镜像由校验后的 root 包装器执行。

### 首次引导

从本机把候选部署件同步到服务器临时目录（不包含 `.env.deploy` 密钥文件），再由
root 安装器备份旧工具链并统一所有权；不要直接 rsync 覆盖 `/opt/apipool-v2`：

```bash
COPYFILE_DISABLE=1 tar --no-xattrs -czf - docker-compose.prod.yml deploy \
  | ssh apipool_vps 'install -d -m 700 /root/apipool-tooling-candidate && tar -xzf - -C /root/apipool-tooling-candidate'
ssh apipool_vps '/root/apipool-tooling-candidate/deploy/install-production-tooling.sh /root/apipool-tooling-candidate'
ssh apipool_vps 'cd /opt/apipool-v2 && ./deploy/server-bootstrap.sh'
```

`server-bootstrap.sh` 同时安装 Caddy 并生成反代配置：

- `app.apipool.dev` → 门户 `127.0.0.1:3000`
- `api2.apipool.dev` → New API 用户 API `127.0.0.1:3001`
- `newapi.apipool.dev` → New API 管理面 `127.0.0.1:3001`

New API 管理面直接对公网开放登录页，并加 `X-Robots-Tag: noindex, nofollow`。上线后需确保 New API root 密码和后台账号权限已设置妥当。

复制 `deploy/env.production.example` 为服务器 `/opt/apipool-v2/.env.deploy` 后填写密钥。若需要先把容器跑起来但 New API 管理 token 尚未初始化，可临时设置：

```env
NEWAPI_INTEGRATION_ENABLED=false
APIPOOL_KEY_CREATION_ENABLED=false
```

完成 New API root 初始化并写入 `NEWAPI_ADMIN_TOKEN` 后，再改回 `true` 并重新执行部署。

首次安装 repo-level 自托管 Runner 时，从 GitHub 生成一次性注册 token，经标准输入交给安装脚本；不要把 token 写入磁盘或命令行历史：

```bash
ssh apipool_vps 'install -d -m 700 /root/apipool-runner-bootstrap'
scp deploy/install-github-runner.sh deploy/runner-deploy.sh \
  apipool_vps:/root/apipool-runner-bootstrap/
gh api --method POST repos/AFreeCoder/apipool-v2/actions/runners/registration-token --jq .token \
  | ssh apipool_vps '/root/apipool-runner-bootstrap/install-github-runner.sh'
```

安装完成后删除 `/root/apipool-runner-bootstrap`。工作流每次只把当次 `GITHUB_TOKEN` 通过标准输入交给 root 包装器登录 GHCR，任务结束立即 logout，不在 VPS 保存长期 GHCR 凭据。

> 权限门禁：私有仓库当前若没有 `main` 分支保护或 production required reviewer，任何拥有 write 权限的协作者都能触发生产镜像发布。安装 Runner 前必须确认所有 write 协作者都属于生产发布信任边界；否则先降权，或升级 GitHub 方案并启用保护。

### 自动部署与人工恢复

`main` 构建成功后，部署 job 会自动投递给带 `apipool-prod-deploy` 标签的 VPS Runner。人工恢复时才通过 SSH 直接执行：

```bash
ssh apipool_vps 'cd /opt/apipool-v2 && ./deploy/deploy.sh sha-<commit>'
```

`deploy/deploy.sh` 会执行：

1. `deploy/backup.sh pre-deploy`，备份数据库目录和配置文件，只保留最近 2 次 pre-deploy 备份。
2. 写入 `release.env` 的 `IMAGE_TAG`。
3. `docker compose pull` 拉取门户镜像与 NewAPI 元数据过滤器镜像；New API 上游镜像按其既有标签获取。
4. `docker compose up -d --remove-orphans` 切换容器。
5. 验证 `http://127.0.0.1:3001/api/status` 与 `http://127.0.0.1:3000/`。
6. 健康检查失败时尝试回滚到上一次 `IMAGE_TAG`；数据库不自动回滚，需根据备份人工恢复。

### 主机入站防火墙

先在腾讯云防火墙放行 owner 确认的 SSH CIDR 到 TCP `22222`，再应用主机层规则。不要把当前临时出口 IP 自动当成长期白名单：

```bash
ssh apipool_vps
cd /opt/apipool-v2
APIPOOL_SSH_ALLOWED_CIDRS='<owner-cidr>/32' \
  ./deploy/configure-ingress-firewall.sh --print-config
sudo APIPOOL_SSH_ALLOWED_CIDRS='<owner-cidr>/32' \
  ./deploy/configure-ingress-firewall.sh --apply
```

`--apply` 会先安排 5 分钟后的自动回滚。保持当前会话不退出，从另一个终端建立新的 `ssh apipool_vps`；确认新会话、80/443 与 GitHub Runner 都正常后，才执行：

```bash
sudo /opt/apipool-v2/deploy/configure-ingress-firewall.sh --confirm
```

规则只允许公网 TCP `80/443`、HTTP/3 的 UDP `443`、确认 CIDR 的 TCP `22222`、回环、已建立连接、DHCP 续租以及必要 ICMP/ICMPv6；TCP `22` 与其他新入站默认丢弃。紧急人工回滚：

```bash
sudo /opt/apipool-v2/deploy/configure-ingress-firewall.sh --rollback
```

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
- `request_ledger` 行停留 `open`/`pending_backfill` 超过 10 分钟 → 告警。
- 运行时凭证桥接连续 `unauthorized`/`timeout` → 告警。

## 5. 回滚顺序（保留用户资产与审计）

1. 置 `APIPOOL_KEY_CREATION_ENABLED=false`，停止新 Key 创建。
2. 在支付渠道后台暂停支付（或下架套餐），避免回滚窗口内新订单。
3. 门户回滚到上一个稳定部署。
4. 不删除已有门户 Key、运行时凭证、钱包/请求账本或订单。
5. 保留钱包调额记录与管理审计日志用于对账；窗口期内的 paid 订单按 06 文档对账流程补记本地钱包充值，禁止通过 New API quota 补偿门户余额。

运行时凭证创建或停用失败时保留 `runtime_credential`/`credential_retirement` 状态与审计证据，先核对 New API 同名 token 再人工补偿；门户 Key 与运行时凭证未一致前，不得把凭证状态标记为可用。

## 6. 最终态上线 runbook

> **临时直连期间暂停本节**：`api2.apipool.dev/v1*` 当前绕过门户钱包
> 直连 New API，必须保持 `APIPOOL_CHECKOUT_ENABLED=false`，不执行
> `go-live verify` 或 `go-live open-checkout`。本节在 `api.apipool.dev` 切到门户正式
> 数据面并完成全链路验收后恢复执行。

本次首次上线基于“线上没有真实用户和真实流量”的事实，直接部署最终态，不维护渐进切流
状态。真实客户开始使用后，不得继续套用“无流量”前提：

- 充值始终写钱包账本并停写 credit；
- Dashboard 与公开 API 始终读取钱包和请求账本；
- `api2.apipool.dev/v1*` 当前临时全量直连 New API；该域名不作为门户正式数据面；
- `newapi.apipool.dev/v1*` 始终返回 404；
- 仅 `APIPOOL_CHECKOUT_ENABLED` 控制是否允许创建支付订单。

全程在 `/opt/apipool-v2` 执行。`deploy/go-live.sh` 使用 deploy lock；退出 78 表示
checkout 前态、恢复演练证据、当前镜像 smoke 标志或人工确认不满足，退出 75 表示锁冲突
或运行态验证失败。

### 6.1 上线顺序

1. 确认 pre-deploy 备份存在。首次开放 checkout 前必须在隔离环境完成一次备份恢复
   演练并保存证据；数据库与 `APIPOOL_CREDENTIALS_SECRET` 必须能在恢复环境重聚。
2. 确认 `.env.deploy` 中 `APIPOOL_CHECKOUT_ENABLED=false`。
3. 部署目标 `IMAGE_TAG`，等待数据库迁移和容器健康检查完成。
4. 在“模型目录 → 分组折扣”确认门户分组只映射一个 New API 分组，执行价格同步并复核模型基准价与售卖项状态。网关会据此自动生成路由和不可变价格快照，不再人工发布第二套路由/价格。
5. 执行生产库只读核验（§6.2）。
6. 执行 `./deploy/go-live.sh verify`。脚本依次验证固定路由、MVP smoke、充值
   smoke 和 Gateway smoke，并把两类专项标志绑定到当前 `IMAGE_TAG`。
7. 人工核对 Dashboard 本地钱包、请求账本和钱包充值流水；New API quota 不作为门户余额核对项。
8. 执行 `./deploy/go-live.sh open-checkout --evidence "$RESTORE_EVIDENCE"`，
   输入 `yes` 后才开放收款。
9. 按 §6.5 观察并收尾。

```bash
cd /opt/apipool-v2
RESTORE_EVIDENCE=/opt/apipool-v2/evidence/restore-drill-YYYYMMDD.md
./deploy/go-live.sh status
./deploy/go-live.sh verify
./deploy/go-live.sh open-checkout --evidence "$RESTORE_EVIDENCE"
./deploy/go-live.sh status
```

恢复演练证据文件必须是仅操作员可读的普通非空文件，建议权限 `600`，至少记录：

- 演练时间、操作员、源备份归档绝对路径及 SHA-256；
- 隔离恢复目标，Portal 与 New API SQLite 的 `PRAGMA integrity_check=ok`；
- 恢复后容器启动、迁移和只读健康检查结果；
- 使用恢复的 `APIPOOL_CREDENTIALS_SECRET` 验证凭证可解密的结果，不得记录密钥明文；
- 演练环境清理结果。

`go-live.sh` 只验证证据文件存在、可读且非空，并在人工确认时回显路径；操作员必须先
审阅内容真实性，不能用占位文件代替恢复演练。

固定路由的独立期待值始终是 401 / 404 / 404：

```bash
test "$(curl -sS -o /dev/null -w '%{http_code}' https://api2.apipool.dev/v1/models)" = 401
test "$(curl -sS -o /dev/null -w '%{http_code}' https://newapi.apipool.dev/v1/models)" = 404
test "$(curl -sS -o /dev/null -w '%{http_code}' https://api2.apipool.dev/api/status)" = 404
```

### 6.2 生产迁移只读核验

迁移完成后、执行上线验证前，以 URI `mode=ro` 打开生产门户库。先人工核对 Task 1
关键表的完整列，再运行缺列断言；最后一条查询期待返回 `0`：

```bash
cd /opt/apipool-v2
PORTAL_DB='file:/opt/apipool-v2/data/portal/portal.db?mode=ro'

sqlite3 "$PORTAL_DB" "PRAGMA table_info(wallet_account);"
sqlite3 "$PORTAL_DB" "PRAGMA table_info(wallet_ledger);"
sqlite3 "$PORTAL_DB" "PRAGMA table_info(request_ledger);"
sqlite3 "$PORTAL_DB" "PRAGMA table_info(runtime_credential);"
sqlite3 "$PORTAL_DB" "PRAGMA table_info(model_route);"
sqlite3 "$PORTAL_DB" "PRAGMA table_info(model_price_version);"

sqlite3 "$PORTAL_DB" <<'SQL'
WITH required(table_name, column_name) AS (VALUES
  ('wallet_account','user_id'), ('wallet_account','balance_micro_usd'),
  ('wallet_account','risk_limit_override'), ('wallet_account','frozen_at'),
  ('wallet_ledger','user_id'), ('wallet_ledger','entry_type'),
  ('wallet_ledger','signed_amount_micro_usd'), ('wallet_ledger','balance_after_micro_usd'),
  ('wallet_ledger','request_ledger_id'), ('wallet_ledger','order_no'),
  ('wallet_ledger','idempotency_key'),
  ('request_ledger','newapi_request_id'), ('request_ledger','portal_key_id'),
  ('request_ledger','credential_id'), ('request_ledger','route_version'),
  ('request_ledger','price_version_id'), ('request_ledger','status'),
  ('request_ledger','resolved_at'), ('request_ledger','charged_micro_usd'),
  ('request_ledger','reconcile_status'),
  ('runtime_credential','portal_user_id'), ('runtime_credential','newapi_group'),
  ('runtime_credential','remote_name'), ('runtime_credential','token_enc'),
  ('runtime_credential','status'),
  ('model_route','portal_group_id'), ('model_route','portal_model_id'),
  ('model_route','newapi_group'), ('model_route','newapi_model_id'),
  ('model_price_version','cached_input_micro_usd_per_m'),
  ('model_price_version','cache_write_5m_micro_usd_per_m'),
  ('model_price_version','cache_write_1h_micro_usd_per_m')
), missing AS (
  SELECT r.* FROM required r
  WHERE NOT EXISTS (
    SELECT 1 FROM pragma_table_info(r.table_name) p WHERE p.name=r.column_name
  )
)
SELECT count(*) AS missing_required_columns FROM missing;

SELECT name FROM sqlite_master
WHERE type='table' AND name IN (
  'portal_api_key','model_route','model_price_version','runtime_credential',
  'wallet_account','wallet_ledger','request_ledger','portal_admin_audit_log',
  'credential_retirement','gateway_job_lock','reconcile_orphan_observation'
) ORDER BY name;
SELECT name FROM sqlite_master
WHERE type='index' AND name IN (
  'uniq_wallet_ledger_request_charge','uniq_wallet_ledger_recharge_order',
  'uniq_wallet_ledger_idempotency','uniq_request_ledger_newapi_request',
  'uniq_runtime_credential_scope','uniq_model_route_active',
  'uniq_model_price_version_active'
) ORDER BY name;
SQL
```

再检查旧 credit 有效余额；以下查询必须返回零行：

```bash
sqlite3 -header -column "$PORTAL_DB" <<'SQL'
SELECT
  user_id,
  SUM(remaining_credits) AS remaining_credits
FROM credit
WHERE status = 'active'
  AND transaction_type = 'grant'
  AND remaining_credits > 0
  AND (
    expires_at IS NULL
    OR expires_at > CAST(strftime('%s', 'now') AS INTEGER) * 1000
  )
GROUP BY user_id
HAVING SUM(remaining_credits) > 0;
SQL
```

表或列缺失时停止上线；不得在生产库手写补列，先修复迁移并重新部署验证。若 credit
查询返回测试账号，登记后按测试数据清理流程处理；若归属不明或可能是真实余额，停止
开放 checkout，先确定迁移或补账方案，不得直接删除 credit 记录。

### 6.3 故障处理与镜像回滚

网关、Caddy、钱包或 smoke 任一失败时保持
`APIPOOL_CHECKOUT_ENABLED=false`，不要开放收款。由于当前没有真实用户，不需要切换
maintenance 数据面；直接修复后重跑 `verify`，或部署上一稳定 `IMAGE_TAG`：

```bash
cd /opt/apipool-v2
./deploy/go-live.sh status
./deploy/deploy.sh sha-<上一稳定完整提交>
./deploy/go-live.sh verify
```

Caddy 的当前临时路由不随镜像回滚改变：`api2 /v1*` 仍直连 New API，
`newapi /v1*` 仍固定 404。
若回滚后的旧镜像不兼容当前数据库迁移，停止并按备份恢复流程处理；不得删除流水、伪造
充值或临时把 New API `/v1` 暴露到公网。SQLite 数据恢复、重建环境或轮换
`APIPOOL_CREDENTIALS_SECRET` 仍需新的明确确认。

### 6.4 常规发布门禁

checkout 已开放后，`deploy/deploy.sh` 会在替换镜像前把 checkout 冻结为 false。新镜像
健康后执行当前 `IMAGE_TAG` 的充值 smoke：成功才恢复 checkout=true；失败则退出 75 并
保持冻结。该门禁与路由状态无关，因为路由已经固定为最终态。

### 6.5 观察 72h、告警与旧 token 收尾

前 6 小时每小时、之后每 6 小时执行一次检查并归档输出：

```bash
PORTAL_DB='file:/opt/apipool-v2/data/portal/portal.db?mode=ro'

# 钱包守恒：期待 0 行。
sqlite3 -header -column "$PORTAL_DB" "
SELECT a.user_id,a.balance_micro_usd,COALESCE(SUM(l.signed_amount_micro_usd),0) AS ledger_sum
FROM wallet_account a LEFT JOIN wallet_ledger l ON l.user_id=a.user_id
GROUP BY a.user_id,a.balance_micro_usd
HAVING a.balance_micro_usd<>COALESCE(SUM(l.signed_amount_micro_usd),0);"

# 对账差异、waived 量与回填积压。
sqlite3 -header -column "$PORTAL_DB" "
SELECT reconcile_status,count(*) AS n FROM request_ledger GROUP BY reconcile_status ORDER BY n DESC;
SELECT status,count(*) AS n FROM request_ledger
WHERE status IN ('failed_unbilled','pending_backfill','open') GROUP BY status;
SELECT count(*) AS orphan_open FROM reconcile_orphan_observation WHERE resolved_at IS NULL;
SELECT count(*) AS backfill_over_10m FROM request_ledger
WHERE status='pending_backfill' AND created_at < (unixepoch()*1000-600000);
SELECT count(*) AS frozen_wallets FROM wallet_account WHERE frozen_at IS NOT NULL;"

# 最小日志告警集；只使用代码中真实存在的关键字。有输出就登记时间窗、
# 用户/请求 ID（脱敏）和处置。
docker compose --env-file .env.deploy --env-file release.env \
  -f docker-compose.prod.yml logs --since 15m apipool-v2 2>&1 | \
  grep -E 'terminal write failed|unmapped_usage_dimension|request id not persisted|finalize pipeline error|request handler failed|duplicate newapi_request_id|route_price_group_mismatch|runtime credential (adoption mismatch|retirement failed|worker failed)|\[backfill\] exhausted, manual queue|out_of_scope_consumption|admin logs unavailable|reconcile_slice_overflow|waived_by_failure_high|wallet_invariant_broken|\[jobs\] tick failed' || true
```

关键字处置归类：

- `terminal write failed`、`request id not persisted`、`finalize pipeline error`、
  `request handler failed`、`duplicate newapi_request_id`：请求终态或幂等风险，立即按
  request ID 核对 `request_ledger`，不得仅靠重放请求修复。
- `runtime credential ... failed` / `adoption mismatch`：运行凭证创建或退役异常，检查
  本地 credential/retirement 状态与远端同名 token，禁用用户不得手工改回 pending。
- `[backfill] exhausted, manual queue`、`reconcile_slice_overflow`、
  `admin logs unavailable`：回填或对账能力降级，结合上方积压 SQL 判断是否停止放量。
- `wallet_invariant_broken`、`waived_by_failure_high`、`out_of_scope_consumption`、
  `route_price_group_mismatch`：资金或路由一致性告警，保持/进入 maintenance 后调查。

`unmapped_usage_dimension` 是协议演进信号：保持已知桶结算，立即查同时间窗的
`amount_mismatch`，确认上游新增维度后扩展 usage 白名单和 fixture，再用带审计理由的
`manual_adjustment` 补历史差额；不得把未知桶静默映射为零或整笔免单。持续检查
`reconcile_slice_overflow`，10 分钟/片、50 页/片、12 片/轮不足时再按真实积压调参。

72 小时无未解释差异、钱包不变量破坏或回填积压后，先只读导出旧 binding 清单：

```bash
sqlite3 -header -column "$PORTAL_DB" "
SELECT id,portal_user_id,newapi_user_id,newapi_key_id,key_masked,status
FROM newapi_key_binding WHERE status<>'deleted' ORDER BY portal_user_id,newapi_key_id;"
```

按 `newapi_key_id` 在 New API 运营面逐个 disabled/deleted，回读远端状态并保存审计证据；
不得通过 SQL 删除本地 binding 或 token。全部作废后再次确认 api2 三探测仍为 401/404/404，
该收尾步骤延后到临时测试用户迁移完成；此前不得作废其 New API 原生 Key。
