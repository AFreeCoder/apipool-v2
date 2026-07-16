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
- 镜像构建 job 使用 GitHub 托管 `ubuntu-latest`；生产部署 job 使用 VPS 上仓库级专用
  Runner 标签 `[self-hosted, linux, x64, apipool-prod-deploy]`。Runner 通过出站 HTTPS
  领取任务，不开放 GitHub Runner SSH 入站。
- 生产部署 job 通过 root-owned `/usr/local/sbin/apipool-runner-deploy` 校验 checkout
  SHA、不可变镜像 tag、固定部署文件所有权与 `.env.deploy` 权限，再执行：

```bash
cd /opt/apipool-v2 && ./deploy/deploy.sh sha-<commit>
```

`deploy/deploy.sh` 使用 `/run/apipool-v2-deploy.lock`，同一时间只允许一个部署。
workflow checkout 无权覆盖 `/opt/apipool-v2/docker-compose.prod.yml` 或 `deploy/`；发布
工具链变更必须由 owner 通过 SSH 单独安装。Runner 用户未加入 Docker 组，且 nftables
将其自身出口限制为 DNS/HTTPS并拒绝云 metadata 网段。

## Runtime Architecture

- 运行单元：`docker-compose.prod.yml` 中的 `apipool-v2`、`new-api` 和
  `newapi-metadata-filter`
- 门户容器：拉取 GHCR 镜像，监听服务器本机 `127.0.0.1:3000`
- New API 容器：`calciumion/new-api`，监听服务器本机 `127.0.0.1:3001`
- 元数据过滤器：独立 GHCR 镜像，仅在 Compose 内网监听 `8080`；不发布宿主机端口。
- 持久化数据：
  - `data/portal/`：门户 SQLite 数据
  - `data/new-api/`：New API SQLite 数据
- 反向代理：Caddy，配置由 `deploy/configure-caddy.sh` 生成，`deploy/deploy.sh`
  **每次部署都会在备份与拉镜像之前重新生成 + `caddy validate` + `reload`**
  （该步骤会覆盖 `/etc/caddy/Caddyfile`，旧配置备份到 `Caddyfile.bak`）：
  - `app.apipool.dev` → `127.0.0.1:3000`。Caddy 按实际 TCP 对端只接受
    `deploy/cloudflare-ips.txt` 中的 Cloudflare 官方代理网段，其他来源返回 403
  - `api2.apipool.dev` → `127.0.0.1:3001`，**只放行 `/v1*` 数据面**，其余路径（含
    `/api/*` 管理接口）返回 404
  - `newapi.apipool.dev` → `127.0.0.1:3001`。默认要求在 `.env.deploy` 配 Basic
    Auth 与/或额外 IP 守卫，否则 `configure-caddy.sh` fail-closed 退出 78，部署在
    动任何东西之前中止。无论是否配置 operator guard，newapi 源站始终只接受
    Cloudflare 官方代理网段。**当前生产已显式设
    `APIPOOL_NEWAPI_ALLOW_UNPROTECTED=true`**（owner 决策，2026-07-09）：不额外叠加
    Caddy Basic Auth/运营 IP，但 Cloudflare 源站 ACL 与 New API 自身 root 登录仍生效
- 运行时配置：
  - `/opt/apipool-v2/.env.deploy`
  - `/opt/apipool-v2/release.env`
  - `/opt/apipool-v2/docker-compose.prod.yml`

## NewAPI 受控模型元数据同步

生产 Compose 还运行一个不发布端口的 `newapi-metadata-filter` 服务。它实时读取公共
元数据源，只保留仓库中
`services/newapi-metadata-filter/config/official-vendors.yaml` 定义的供应商，并通过
`SYNC_UPSTREAM_BASE=http://newapi-metadata-filter:8080` 提供给 NewAPI。生产环境使用
随该服务镜像构建的 YAML，不做宿主机 bind mount，因此回滚 `IMAGE_TAG` 会同时回滚
过滤器代码和白名单策略。

- 控制台入口不变：**模型 → 元信息 → 添加模型旁的更多操作 → 同步上游**。
- 过滤器不缓存、不回退到公共源。公共源故障、供应商图标缺失或过滤后出现重复
  `model_name` 时返回 502；此时停止同步，先检查日志和白名单策略。
- `Alibaba/deepseek-r1` 是当前唯一显式排除项。新增候选或处理新冲突必须先提交并审核
  YAML，不得以源顺序或模型名前缀静默选择供应商。
- 同步操作会把结果写入 NewAPI 自己的元信息表；镜像/策略回滚只恢复后续同步来源，
  不会自动回滚已经写入的元信息。

### Token 倍率同步

过滤器提供 `GET /api/newapi/ratio_config-v1-base.json`，并以 `GET /api/pricing` 作为
普通同步渠道兼容别名。它从已过滤且同名
fail-closed 的模型记录直接生成 `model_ratio`、`completion_ratio` 和 `cache_ratio`，
不会读取公共全量倍率配置，也不会自动生成按次 `model_price`。

在 NewAPI 渠道中创建一条禁用、无模型的同步专用渠道（建议名称“官方过滤倍率”）：

```text
Base URL=http://newapi-metadata-filter:8080
状态=禁用
```

在 **计费与支付 → 模型定价 → 上游价格同步** 中选择该渠道，使用默认 `pricing`
端点即可。此请求由 NewAPI 容器访问 Compose 内网地址，过滤器仍不发布宿主机端口；渠道
禁用且无模型，不能参与数据面路由。获取差异后可用来源列表头复选框批量选择并应用；分组
倍率不在此次同步范围。按次计费模型继续在本地 `ModelPrice` 手工维护。

服务器排障（不需要公网路由）：

```bash
ssh apipool_vps 'cd /opt/apipool-v2 && docker compose --env-file .env.deploy --env-file release.env -f docker-compose.prod.yml ps newapi-metadata-filter'
ssh apipool_vps 'cd /opt/apipool-v2 && docker compose --env-file .env.deploy --env-file release.env -f docker-compose.prod.yml exec -T newapi-metadata-filter wget -q -O - http://127.0.0.1:8080/healthz'
ssh apipool_vps 'cd /opt/apipool-v2 && docker compose --env-file .env.deploy --env-file release.env -f docker-compose.prod.yml logs --tail=120 newapi-metadata-filter'
```

服务应为 `healthy` 后再从 NewAPI 控制台预览同步结果。预览中若供应商、图标或标签
不符合预期，不执行同步；先修订白名单并在本地验证。回滚使用已有的前一
`IMAGE_TAG` 与 `deploy/deploy.sh`，然后重新预览，再决定是否需要人工清理或重同步
NewAPI 元信息。

## DNS Phase

当前处于老站排空期：

- `app.apipool.dev`、`newapi.apipool.dev` 保持 Cloudflare proxied，并指向 v2 VPS。
- `api2.apipool.dev` 指向 v2 VPS 且使用 DNS-only，避免长耗时图片请求继续受
  Cloudflare HTTP 代理超时限制；该记录会公开 VPS IP。
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
- `services/newapi-metadata-filter/Dockerfile`
- `services/newapi-metadata-filter/config/official-vendors.yaml`
- `docker-compose.prod.yml`
- `deploy/deploy.sh`
- `deploy/configure-caddy.sh`
- `deploy/cloudflare-ips.txt`
- `deploy/configure-ingress-firewall.sh`
- `deploy/runner-deploy.sh`
- `deploy/install-github-runner.sh`
- `deploy/install-production-tooling.sh`
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
- Runner 部署入口回滚：在公网 SSH 尚未关闭的过渡窗口内，将 workflow 恢复为上一版
  SSH deploy job；停止 Runner 服务不会影响当前容器运行。
- Runner 工具链回滚：恢复 `/usr/local/sbin/apipool-runner-deploy` 与
  `/opt/apipool-v2/deploy/` 的上一份 root-owned 版本；workflow 不会自动覆盖它们。
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
gh api repos/AFreeCoder/apipool-v2/actions/runners --jq '.runners[] | {name,status,busy,labels}'
```

服务器运行态：

```bash
ssh apipool_vps 'cd /opt/apipool-v2 && cat release.env && docker compose --env-file .env.deploy --env-file release.env -f docker-compose.prod.yml ps'
ssh apipool_vps 'cd /opt/apipool-v2 && docker compose --env-file .env.deploy --env-file release.env -f docker-compose.prod.yml ps newapi-metadata-filter'
ssh apipool_vps 'curl -fsS http://127.0.0.1:3001/api/status && curl -fsS http://127.0.0.1:3000/ >/dev/null'
ssh apipool_vps 'docker logs --since 5m apipool-v2-apipool-v2-1 2>&1 | tail -120'
ssh apipool_vps 'df -h /opt/apipool-v2 && free -h && docker system df'
```

外部健康检查：

```bash
curl -fsS https://app.apipool.dev/ >/dev/null

# newapi 运营面：
#   - 若配了 Basic Auth / IP 白名单：无凭据应 401/403
#   - 若 APIPOOL_NEWAPI_ALLOW_UNPROTECTED=true（当前生产）：经 Cloudflare 预期 200；
#     直连源站仍由 Cloudflare CIDR ACL 拦截，运营登录由 New API 自身承担
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
- `apipool-prod-deploy` Runner online/idle，部署日志不包含 SSH/ssh-keyscan 路径。
- 服务器 `/opt/apipool-v2/release.env` 中的 `IMAGE_TAG` 是目标 `sha-<commit>`。
- `docker compose ps` 显示 `apipool-v2`、`new-api` 运行中，且 `newapi-metadata-filter` 为 `healthy`。
- `http://127.0.0.1:3001/api/status` 和 `http://127.0.0.1:3000/` 通过。
- 外部 `https://app.apipool.dev/` 通过。
- 外部 `https://newapi.apipool.dev/`：配了 operator guard 时应 401/403；当前生产设
  `APIPOOL_NEWAPI_ALLOW_UNPROTECTED=true`，经 Cloudflare 预期 200，但绕过 Cloudflare
  的源站直连必须返回 403。
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
