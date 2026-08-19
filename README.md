# APIPool v2

APIPool v2 is the MVP portal for a real API key lifecycle:

- login and portal account binding
- local portal API keys with server-side New API runtime credential provisioning
- model catalog with one launch `available` model and other candidates marked `coming_soon`
- catalog-driven routing and immutable request price snapshots
- customer dashboard backed by the local wallet and request ledger
- operator-only APIPool wallet adjustment with an append-only audit trail

## Local Development

```bash
pnpm install
pnpm dev
```

The default local URL is `http://localhost:3000`.

## Environment

Start from `.env.example`. The New API bridge is disabled unless these server-side variables are configured:

```bash
NEWAPI_INTEGRATION_ENABLED=true
APIPOOL_KEY_CREATION_ENABLED=true
NEWAPI_BASE_URL=http://newapi-internal:3000
NEWAPI_ADMIN_TOKEN=...
```

The browser must never receive New API admin credentials or internal New API user identifiers.
For rollback, set `APIPOOL_KEY_CREATION_ENABLED=false` before rolling back the
portal so new customer key creation stops while existing keys can still be
listed, disabled, or deleted.
If `newapi.apipool.dev` is deployed for operators, protect it separately with
operator login plus Basic Auth or an IP allowlist, and keep portal bridge traffic
on the internal service URL.

## Deployment

A three-service `docker-compose.yml` runs the portal (`apipool-v2`), the New
API upstream (`calciumion/new-api`), and an internal NewAPI metadata filter.
The portal image builds from the local
`Dockerfile` (build-time `NEXT_PUBLIC_*` injection, esbuild-bundled SQLite
migrator, migrate-on-startup with fail-fast secret checks). Copy
`.env.deploy.example` to `.env.deploy`, fill the secrets, then follow the
step-by-step runbook in [`deploy/bootstrap.md`](deploy/bootstrap.md):

```bash
docker compose --env-file .env.deploy up -d --build
```

`AUTH_SECRET` and `APIPOOL_CREDENTIALS_SECRET` must be non-empty (>=16 chars) or
the container refuses to start. New API root credentials (`NEWAPI_ROOT_*`) are
host-bootstrap-only and are not injected into the portal container.

生产环境由 GitHub 托管 Runner 构建不可变 GHCR 镜像。VPS 上的仓库级专用部署
Runner 只通过出站 HTTPS 领取生产部署任务，在预部署备份后拉取指定镜像。VPS 不构建
镜像，GitHub 托管 Runner 也不通过 SSH 登录 VPS。workflow 无权替换 root 持有的
生产 compose/deploy 工具链；工具链更新仍需运营人员显式通过 SSH 完成。人工恢复继续
使用运营 SSH 通道：

```bash
ssh apipool_vps 'cd /opt/apipool-v2 && ./deploy/deploy.sh sha-<commit>'
```

发布门禁、安全边界、备份保留、回滚和当前 VPS 访问记录见
[`docs/07-runbook.md`](docs/07-runbook.md)。

## Verification

```bash
pnpm test
pnpm lint
pnpm build
```

Local MVP smoke:

```bash
pnpm smoke:mvp
```

`smoke:mvp` creates a portal API key, applies a local wallet adjustment with an
operator that has `admin.apipool.quota.adjust`, calls the configured API base,
disables the key, and checks that the disabled key is rejected. It skips when live New API credentials,
`APIPOOL_SMOKE_PORTAL_USER_ID`, or `APIPOOL_SMOKE_OPERATOR_USER_ID` are missing.
`APIPOOL_SMOKE_GROUP_SLUG` defaults to `official`; set it with
`APIPOOL_SMOKE_MODEL` to test a specific callable production group/model. Set
`APIPOOL_SMOKE_REQUIRE_LIVE=true` to make missing live configuration fail.
GitHub Actions intentionally runs only no-secret gates; production live smoke
runs on the VPS with server-local environment:

```bash
ssh apipool_vps 'cd /opt/apipool-v2 && ./deploy/setup-smoke-users.sh --apply'
ssh apipool_vps 'cd /opt/apipool-v2 && ./deploy/live-smoke.sh'
```

The public portal API endpoint is `https://app.apipool.dev`; protocol-specific
clients append paths such as `/v1`. The separate `https://api2.apipool.dev`
endpoint forwards `/v1*` directly to New API and therefore accepts New API
native keys, not portal keys. Portal-to-New API traffic stays on the internal
`NEWAPI_BASE_URL`. During the legacy drain period, `apipool.dev` and
`api.apipool.dev` stay on the old service.
