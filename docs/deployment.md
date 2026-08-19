# APIPool v2 发布手册

本文件是生产发布的规范化入口。详细业务门禁继续以
[`docs/07-runbook.md`](./07-runbook.md) 为准；本文件只记录发布流程、命令、
检查项和成功标准，不记录密钥、token、私钥或客户数据。

## Release Target

- 发布分支：`main`
- 生产环境：腾讯云 VPS，部署目录 `/opt/apipool-v2`
- 生产门户：`https://app.apipool.dev`
- 生产门户 API Endpoint：`https://app.apipool.dev`
- New API 原生数据面：`https://api2.apipool.dev`
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
- 8GiB 共机资源边界：门户 `1GiB`、New API `512MiB`、metadata filter
  `256MiB`；对应 mem+swap 上限分别为 `1280MiB`、`768MiB`、`384MiB`。
  这些限制用于隔离异常，不代表常态占用；迁移前实测三者合计约 `295MiB`。
- 反向代理：受管 Caddy `2.11.4`（Go `1.26.5`），版本、构建输入和二进制哈希由
  `deploy/caddy-runtime.env` 钉住。运行时与升级脚本的事实源在仓库，服务器只安装
  root-owned 副本；GitHub 应用发布不能自行安装或升级宿主机运行时。配置由
  `deploy/configure-caddy.sh` 生成，`deploy/deploy.sh` **每次部署都会在备份与拉镜像
  之前重新生成 + 全树 validate + 安全 reload**。共享根文件
  `/etc/caddy/Caddyfile` 只负责 `grace_period 15m` 与
  `import /etc/caddy/sites-enabled/*.caddy`。legacy 与 v2 都使用各自的精确
  公网证书名称，按 Caddy 默认行为自动签发和续期。禁止使用
  `auto_https ignore_loaded_certs`，也禁止加载会覆盖 v2 子域的 Origin wildcard，
  否则会让不属于目标机入口的域名重复发起公网 ACME。v2 只原子更新自己的
  `/etc/caddy/sites-enabled/apipool-v2.caddy`，不会覆盖 legacy 或其他服务分片。
  更新前会把现有所有分片复制到候选树做一次完整 `caddy validate`，通过后才替换并
  应用；上一份 v2 分片保存在 `apipool-v2.caddy.bak`。
- 共享根与 v2 分片均无变化时直接短路，不 reload Caddy。变更 reload 后必须确认
  MainPID 不变、进程持续 active、journal 无 panic/退出签名。
- 所有反代配置使用 `stream_close_delay 15m`，systemd 使用
  `TimeoutStopSec=16min` 与 `Restart=on-failure`。宿主机运行时升级必须走
  `deploy/upgrade-caddy-runtime.sh` 的候选实例 + nftables 新连接透明切流流程，禁止
  直接安装 `.deb` 或 `systemctl restart caddy`。
- `--apply` 前必须先安装同一批次的 legacy root-owned 写入器，并通过
  `/opt/sub2api/deploy/caddy-runtime-contract` 的显式契约门禁；生产 workflow
  必须等待 deployment-contract 测试通过。候选实例使用独立 HOME/XDG 与 autosave，
  真实切流须同时验证 Cloudflare、轻云、DNS-only TCP/HTTP3，且不得在 `Alt-Svc`
  宣告内部端口。
- 所有服务的 Caddy 配置写入器必须共用 `/run/apipool-caddy.lock`。首次从旧版 v2
  三站点单体根配置升级时脚本会备份根文件并迁移到共享入口；若根文件不是可识别的旧版
  v2 配置且尚未使用共享 import，脚本退出 78，不覆盖未知配置。
- `app.apipool.dev` 始终指向门户 `127.0.0.1:3000`，同时承载站点与门户 `/v1*`
  API，并按实际 TCP 对端只接受
  `deploy/cloudflare-ips.txt` 中的 Cloudflare 官方代理网段，其他来源返回 403。
- `api2.apipool.dev` 是 DNS-only New API 原生数据面，所有 `/v1*` 路径
  均直接代理到 `127.0.0.1:3001`，避开 Cloudflare 超时和门户网关
  端点白名单；非 `/v1*` 路径固定返回 404，不暴露 New API 管理面。
- `api2` 使用 New API 原生 Key，与门户 Key、门户钱包和 checkout 相互独立；
  它不是门户公开 Endpoint。
- `newapi.apipool.dev/v1*` 固定返回 404，禁止绕过门户鉴权和钱包计费直连
  New API。

- `newapi.apipool.dev` 的非 `/v1*` 路径仍指向 New API 运营面
  `127.0.0.1:3001`，并始终只接受 Cloudflare 官方代理网段。默认还要求在
  `.env.deploy` 配 Basic Auth 与/或额外运营 IP 白名单，否则
  `configure-caddy.sh` fail-closed 退出 78，部署在动任何东西之前中止。
  **当前生产已显式设 `APIPOOL_NEWAPI_ALLOW_UNPROTECTED=true`**（owner 决策，
  2026-07-09）：只跳过额外的 Caddy Basic Auth/运营 IP 守卫；Cloudflare 源站 ACL
  与 New API 自身 root 登录仍然生效。
- 首次上线按 [`docs/07-runbook.md` 的“最终态上线 runbook”](./07-runbook.md#6-最终态上线-runbook)
  执行；`deploy/go-live.sh` 只负责验证当前发布并在人工确认后开放 checkout。
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

## DNS 与入口现状

- `apipool.dev`、`app.apipool.dev`、`newapi.apipool.dev` 经 Cloudflare 到
  `apipool_vps`。
- `api.apipool.dev` 先到轻云互联，再转发到 `apipool_vps` 的 legacy 服务。
- `api2.apipool.dev` 为 DNS-only，直接到 `apipool_vps` 的 New API 数据面。
- DigitalOcean 上的 legacy 容器已停止，数据库已落后，不得再接生产流量或作为
  Caddy 升级回退源；仅 biz 服务按迁移决定保留。

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

# Compose 变量替换与门户容器 allowlist 必须可解析。
IMAGE_TAG=validation docker compose --env-file deploy/env.production.example \
  -f docker-compose.prod.yml config >/dev/null

# 三态 Caddy fixture + 真实 adapt/validate + Compose allowlist。
caddy version
pnpm exec tsx --test \
  tests/deploy/deploy-automation.test.ts \
  tests/deploy/caddy-adapt.test.ts \
  tests/deploy/compose-allowlist.test.ts
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
冒烟业务用户和调额操作人统一固定为 `smo@apipool.local`；两组环境变量必须指向
同一个 user ID。脚本会核对 user ID 对应的数据库邮箱，禁止改用真实用户账号，
以免多轮测试污染用户与审计记录。

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
- `deploy/caddy-runtime.env`
- `deploy/caddy-runtime-lib.sh`
- `deploy/build-caddy-runtime.sh`
- `deploy/upgrade-caddy-runtime.sh`
- `deploy/systemd/caddy-apipool.conf`
- `deploy/rollback-caddy.sh`
- `deploy/go-live.sh`
- `deploy/lib.sh`
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

- Caddy v2 分片回滚：
  `ssh apipool_vps 'cd /opt/apipool-v2 && ./deploy/rollback-caddy.sh'`。脚本在共享锁内把
  `apipool-v2.caddy.bak` 与全部现有分片组装成候选树，完整 validate 通过后才原子替换
  live 分片并 reload；当前 live 版本另存为 `apipool-v2.caddy.pre-rollback`。
  `Caddyfile.bak` 只用于首次把旧版 v2 单体根配置迁移为共享入口时的人工恢复，不要用它
  覆盖已承载 legacy 分片的当前共享入口。
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
test "$(curl -sS -o /dev/null -w '%{http_code}' https://app.apipool.dev/v1/models)" = "401"

# newapi 运营面：
#   - 若配了 Basic Auth / IP 白名单：无凭据应 401/403
#   - 若 APIPOOL_NEWAPI_ALLOW_UNPROTECTED=true（当前生产）：经 Cloudflare 预期 200；
#     直连源站仍由 Cloudflare CIDR ACL 拦截，运营登录由 New API 自身承担
curl -sS -o /dev/null -w 'newapi /api/status -> %{http_code}\n' https://newapi.apipool.dev/api/status

# api2 只放行 /v1*：管理接口路径必须 404
test "$(curl -sS -o /dev/null -w '%{http_code}' https://api2.apipool.dev/api/status)" = "404"

NEWAPI_NATIVE_ENDPOINT=https://api2.apipool.dev
test "$(curl -sS -o /tmp/apipool-api2-models-no-key.out -w '%{http_code}' "$NEWAPI_NATIVE_ENDPOINT/v1/models")" = "401"
```

`https://app.apipool.dev` 是门户公开 API Endpoint；无门户 Key 访问
`/v1/models` 应返回门户认证错误。`https://api2.apipool.dev` 是 New API 原生
直连 endpoint；无 API key 访问
OpenAI-compatible `/v1/models` 应返回认证错误。真实可调用性使用临时用户的
New API 原生 Key 做外部 smoke；`deploy/live-smoke.sh --gateway` 验证门户内部网关。
`api.apipool.dev` 在老站排空期继续服务老用户，
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
- 外部 `https://app.apipool.dev/v1/models` 无门户 Key 返回 401，且响应具有门户网关请求 ID。
- 外部 `https://newapi.apipool.dev/`：配了 operator guard 时应 401/403；当前生产设
  `APIPOOL_NEWAPI_ALLOW_UNPROTECTED=true`，经 Cloudflare 预期 200，但绕过 Cloudflare
  的源站直连必须返回 403。
- 外部 `https://api2.apipool.dev/api/status` 返回 404（管理接口未经 api2 暴露）。
- 外部 `https://api2.apipool.dev` 的任意 `/v1*` 路径均进入 New API；
  `/v1/models` 无 API key 返回 401 认证错误，带 New API 原生 Key
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
