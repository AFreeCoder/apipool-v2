# APIPool v2 发布手册

本文件是生产发布的规范化入口。详细业务门禁继续以
[`docs/07-runbook.md`](./07-runbook.md) 为准；本文件只记录发布流程、命令、
检查项和成功标准，不记录密钥、token、私钥或客户数据。

## Release Target

- 发布分支：`main`
- 生产环境：腾讯云 VPS，部署目录 `/opt/apipool-v2`
- 生产门户：`https://app.apipool.dev`
- 生产 API Endpoint：`https://api2.apipool.dev`
- New API 管理面：`https://newapi.apipool.dev`，仅运营访问
- 远端 SSH：使用本机 SSH config 中的 `apipool_vps` 别名

## Trigger

- 触发方式：push 到 `origin/main`
- CI/CD 工作流：`.github/workflows/docker-build.yaml`
- 验证工作流：`.github/workflows/mvp-verify.yaml`
- 镜像仓库：`ghcr.io/afreecoder/apipool-v2`
- 正式部署镜像 tag：`sha-<完整 commit>`，不要用 `latest` 作为正式发布输入
- 服务器部署命令由 GitHub Actions 执行：

```bash
cd /opt/apipool-v2 && ./deploy/deploy.sh sha-<commit>
```

`deploy/deploy.sh` 使用 `/run/apipool-v2-deploy.lock`，同一时间只允许一个部署。

## Runtime Architecture

- 运行单元：`docker-compose.prod.yml` 中的 `apipool-v2` 和 `new-api`
- 门户容器：拉取 GHCR 镜像，监听服务器本机 `127.0.0.1:3000`
- New API 容器：`calciumion/new-api`，监听服务器本机 `127.0.0.1:3001`
- 持久化数据：
  - `data/portal/`：门户 SQLite 数据
  - `data/new-api/`：New API SQLite 数据
- 反向代理：Caddy，配置由 `deploy/configure-caddy.sh` 生成，`deploy/deploy.sh`
  **每次部署都会在备份与拉镜像之前重新生成 + `caddy validate` + `reload`**
  （该步骤会覆盖 `/etc/caddy/Caddyfile`，旧配置备份到 `Caddyfile.bak`）：
  - `app.apipool.dev` → `127.0.0.1:3000`（门户，无额外保护）
  - `api2.apipool.dev` → `127.0.0.1:3001`，**只放行 `/v1*` 数据面**，其余路径（含
    `/api/*` 管理接口）返回 404
  - `newapi.apipool.dev` → `127.0.0.1:3001`。默认要求在 `.env.deploy` 配 Basic
    Auth 与/或 IP 白名单，否则 `configure-caddy.sh` fail-closed 退出 78，部署在
    动任何东西之前中止。**本项目在 Cloudflare 后面**，`remote_ip` 看到的是 CF 边缘
    IP，故 IP 白名单在当前脚本下不可用（会误伤所有人）；如需保护用 Basic Auth，
    或在 Cloudflare 层做。**当前生产已显式设 `APIPOOL_NEWAPI_ALLOW_UNPROTECTED=true`**
    （owner 决策，2026-07-09）：Caddy 层不加保护，管理后台公网可达，仅由 New API
    自身 root 登录挡管理接口
- 运行时配置：
  - `/opt/apipool-v2/.env.deploy`
  - `/opt/apipool-v2/release.env`
  - `/opt/apipool-v2/docker-compose.prod.yml`

## DNS Phase

当前处于老站排空期：

- `app.apipool.dev`、`api2.apipool.dev`、`newapi.apipool.dev` 指向 v2 VPS。
- `apipool.dev` 和 `api.apipool.dev` 保持指向老站；不要在排空期发布中改到 v2。
- final cutover 才把 `apipool.dev` 回收给 v2 营销站、把 `api.apipool.dev` 回收给 v2 API；`api2.apipool.dev` 永久保留为别名。

## Pre-Deploy Checks

每次 push 或生产部署前先运行：

```bash
git status -sb
git branch --show-current
git log --oneline --decorate -n 5
pnpm exec tsc --noEmit --pretty false
pnpm test
pnpm lint
pnpm build
pnpm smoke:mvp
```

GitHub Actions 和本地 CI 只跑无密钥门禁。生产 live smoke 使用 VPS 本地
`.env.deploy`，不要把 `DATABASE_URL`、`NEWAPI_ADMIN_TOKEN` 或 smoke 用户 ID 放到
GitHub secrets。部署后按发布类型执行：

```bash
ssh apipool_vps 'cd /opt/apipool-v2 && ./deploy/setup-smoke-users.sh --apply'
ssh apipool_vps 'cd /opt/apipool-v2 && ./deploy/live-smoke.sh'
```

`APIPOOL_SMOKE_GROUP_SLUG` 可在 VPS `.env.deploy` 中指定真实冒烟分组；默认是
`official`。若指定 `APIPOOL_SMOKE_MODEL`，该模型必须在冒烟分组中可调用。

非价格策略发布如只需验证建 Key、调用、用量和禁用闭环，可把第二条命令改为
`./deploy/live-smoke.sh --no-price-reconciliation`。

如果部署、compose、Dockerfile、entrypoint、迁移或 GitHub Actions 发生改动，额外
验证部署配置：

```bash
docker compose --env-file deploy/env.production.example --env-file <release-env> -f docker-compose.prod.yml config
```

`<release-env>` 应是仅包含非敏感 `IMAGE_TAG=sha-<commit>` 的临时文件。不要把生产
`.env.deploy` 拷到本地或提交到仓库。

## Deployment-Critical Files

每次发布前至少阅读：

- `README.md`
- `docs/deployment.md`
- `docs/07-runbook.md`
- `.github/workflows/docker-build.yaml`
- `.github/workflows/mvp-verify.yaml`
- `Dockerfile`
- `docker-compose.prod.yml`
- `deploy/deploy.sh`
- `deploy/configure-caddy.sh`
- `deploy/server-bootstrap.sh`
- `deploy/backup.sh`
- `deploy/entrypoint.sh`
- `deploy/live-smoke.sh`
- `deploy/setup-smoke-users.sh`
- `deploy/env.production.example`
- `deploy/bootstrap.md`
- `src/config/db/migrations_sqlite/`
- `scripts/smoke-mvp.ts`
- `scripts/smoke-mvp-runner.ts`

## Backup Requirements

- 触发方式：`deploy/deploy.sh` 在切换镜像前执行 `deploy/backup.sh pre-deploy`
- smoke 用户初始化：`deploy/setup-smoke-users.sh --apply` 在写库前执行
  `deploy/backup.sh pre-smoke-users`
- 备份内容：`data/`、`.env.deploy`、`release.env`、compose 文件和 `deploy/`
- 备份位置：`/opt/apipool-v2/backups/pre-deploy-*.tar.gz` 或
  `/opt/apipool-v2/backups/pre-smoke-users-*.tar.gz`
- 权限：备份目录 `700`，归档文件 `600`
- 保留策略：pre-deploy 备份保留最近 2 次，daily 备份保留最近 7 天
- sanity check：

```bash
ssh apipool_vps 'ls -lt /opt/apipool-v2/backups/pre-deploy-*.tar.gz | head -3'
ssh apipool_vps 'tar -tzf "$(ls -t /opt/apipool-v2/backups/pre-deploy-*.tar.gz | head -1)" | head -40'
```

如果 pre-deploy 备份没有生成或归档无法列出内容，停止发布。

## Rollback and Recovery

- 最快服务恢复：
  1. 置 `APIPOOL_KEY_CREATION_ENABLED=false`，停止新 Key 创建。
  2. 如支付链路受影响，在支付渠道后台暂停支付或下架套餐。
  3. 将门户回滚到上一个稳定 `sha-<commit>` 镜像。
- 自动回滚：`deploy/deploy.sh` 健康检查失败时会把 `release.env` 写回上一次
  `IMAGE_TAG`，重新 `compose pull && compose up -d --remove-orphans`。
- 手动镜像回滚：

```bash
ssh apipool_vps 'cd /opt/apipool-v2 && printf "IMAGE_TAG=<previous-sha-tag>\nDEPLOYED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)\n" > release.env && docker compose --env-file .env.deploy --env-file release.env -f docker-compose.prod.yml pull && docker compose --env-file .env.deploy --env-file release.env -f docker-compose.prod.yml up -d --remove-orphans'
```

- Caddy 配置回滚：`ssh apipool_vps 'cp -a /etc/caddy/Caddyfile.bak /etc/caddy/Caddyfile && caddy validate --config /etc/caddy/Caddyfile && systemctl reload caddy'`。
- 数据恢复：只在确认持久化数据或 schema 状态需要恢复时，从
  `/opt/apipool-v2/backups/` 选择归档人工恢复。
- 需要新确认的操作：数据库恢复、删除数据、破坏性迁移回滚、重建环境、轮换凭据。
- 恢复后必须重新验证门户、New API 状态、容器状态和关键用户闭环。

## Monitoring During Deployment

CI/CD：

```bash
gh run list -R AFreeCoder/apipool-v2 --workflow 'Build and Push Docker Image' --limit 5
gh run watch -R AFreeCoder/apipool-v2 <run-id> --exit-status
gh run view -R AFreeCoder/apipool-v2 <run-id> --json status,conclusion,headSha,jobs,url
```

服务器运行态：

```bash
ssh apipool_vps 'cd /opt/apipool-v2 && cat release.env && docker compose --env-file .env.deploy --env-file release.env -f docker-compose.prod.yml ps'
ssh apipool_vps 'curl -fsS http://127.0.0.1:3001/api/status && curl -fsS http://127.0.0.1:3000/ >/dev/null'
ssh apipool_vps 'docker logs --since 5m apipool-v2-apipool-v2-1 2>&1 | tail -120'
ssh apipool_vps 'df -h /opt/apipool-v2 && free -h && docker system df'
```

外部健康检查：

```bash
curl -fsS https://app.apipool.dev/ >/dev/null

# newapi 运营面：
#   - 若配了 Basic Auth / IP 白名单：无凭据应 401/403
#   - 若 APIPOOL_NEWAPI_ALLOW_UNPROTECTED=true（当前生产）：预期 200（Caddy 层不拦，
#     保护由 New API 自身登录或 Cloudflare 承担）
curl -sS -o /dev/null -w 'newapi /api/status -> %{http_code}\n' https://newapi.apipool.dev/api/status

# api2 只放行 /v1*：管理接口路径必须 404
test "$(curl -sS -o /dev/null -w '%{http_code}' https://api2.apipool.dev/api/status)" = "404"

APIPOOL_API_ENDPOINT=https://api2.apipool.dev
test "$(curl -sS -o /tmp/apipool-api2-models-no-key.out -w '%{http_code}' "$APIPOOL_API_ENDPOINT/v1/models")" = "401"
```

`https://api2.apipool.dev` 是排空期 v2 用户 API endpoint；无 API key 访问
OpenAI-compatible `/v1/models` 应返回认证错误。真实可调用性由 VPS 本地
`./deploy/live-smoke.sh` 覆盖。`api.apipool.dev` 在老站排空期继续服务老用户，
cutover 后再回收给 v2。

## Success Criteria

发布完成必须同时满足：

- `origin/main` 已包含目标提交。
- `Build and Push Docker Image` 工作流成功，部署 job 成功。
- 服务器 `/opt/apipool-v2/release.env` 中的 `IMAGE_TAG` 是目标 `sha-<commit>`。
- `docker compose ps` 显示 `apipool-v2` 和 `new-api` 运行中。
- `http://127.0.0.1:3001/api/status` 和 `http://127.0.0.1:3000/` 通过。
- 外部 `https://app.apipool.dev/` 通过。
- 外部 `https://newapi.apipool.dev/`：配了保护时应 401/403；当前生产设 `APIPOOL_NEWAPI_ALLOW_UNPROTECTED=true`，预期 200（Caddy 层不拦，属 owner 已知情决策）。
- 外部 `https://api2.apipool.dev/api/status` 返回 404（管理接口未经 api2 暴露）。
- 外部 `https://api2.apipool.dev` 的 OpenAI-compatible `/v1/models` 无 API key 返回 401 认证错误；带 Key
  真实调用由 live smoke 验证。
- 新的 `pre-deploy-*.tar.gz` 存在并能列出内容。
- 上一个稳定镜像 tag 或 commit 可用于快速恢复。
- 发布要求的 smoke、管理后台或用户闭环验收通过。
- 关键日志没有启动、迁移、鉴权、权限、网络或资源失败。

## Failure Handling

- CI 构建失败且未影响线上：收集失败 job、失败 step、commit 和构建日志后停止。
- deploy job 失败且旧容器仍健康：收集部署脚本输出、服务器 `release.env`、
  compose 状态、最新备份和容器日志后停止。
- 新版本已切换且用户可见降级：优先执行最快服务恢复路径，先恢复服务，再分析根因。
- 数据恢复、破坏性 schema 回滚、删除数据、重建环境或轮换凭据必须先取得新的明确确认。

## Post-Deploy Documentation

如果实际发布流程、检查命令、健康信号、回滚方式或环境入口与本文件不一致，在服务稳定后
更新本文件。不要写入任何密钥、token、私钥、密码或敏感客户数据。
