# APIPool v2

APIPool v2 is the MVP portal for a real API key lifecycle:

- login and portal account binding
- server-side New API bridge for one New API-backed customer key per portal user, disable/delete, quota, usage, and recent logs
- model catalog with New API group-aligned route groups for standard and discounted channels
- customer dashboard for live New API balance, requests, tokens, spend, recent logs, API keys, and billing ledger
- operator-only manual quota adjustment with ledger v0 and bridge audit logs

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
NEWAPI_DEFAULT_TOKEN_GROUP=auto
NEWAPI_TOKEN_CROSS_GROUP_RETRY=true
```

The browser must never receive New API admin credentials or internal New API user identifiers.
For rollback, set `APIPOOL_KEY_CREATION_ENABLED=false` before rolling back the
portal so new customer key creation stops while existing keys can still be
listed, disabled, or deleted.
If `newapi.apipool.dev` is deployed for operators, protect it separately with
operator login plus Basic Auth or an IP allowlist, and keep portal bridge traffic
on the internal service URL.

## Deployment

A two-service `docker-compose.yml` runs the portal (`apipool-v2`) plus the New
API upstream (`calciumion/new-api`). The portal image builds from the local
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

For production, GitHub Actions builds immutable GHCR images and the VPS deploy
script pulls the selected tag after a pre-deploy backup:

```bash
ssh apipool_vps 'cd /opt/apipool-v2 && ./deploy/deploy.sh sha-<commit>'
```

Release gating, security, backup retention, rollback, and the current VPS
access record are in [`docs/07-runbook.md`](docs/07-runbook.md).

## Verification

```bash
pnpm test
pnpm lint
pnpm build
```

Live MVP smoke:

```bash
pnpm smoke:mvp
```

`smoke:mvp` creates a portal API key, applies a manual quota adjustment with an
operator that has `admin.apipool.quota.adjust`, calls the launch model through
`https://api.apipool.dev/v1`, disables the key, and checks that the disabled key
is rejected. It skips when live New API credentials,
`APIPOOL_SMOKE_PORTAL_USER_ID`, or `APIPOOL_SMOKE_OPERATOR_USER_ID` are missing; set
`APIPOOL_SMOKE_REQUIRE_LIVE=true` in CI/prod validation to make missing live
configuration fail.

Real MVP acceptance still requires live smoke tests against `https://api.apipool.dev/v1` after New API credentials, the launch model, and operator access are configured.
