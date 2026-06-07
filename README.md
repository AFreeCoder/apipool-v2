# APIPool v2

APIPool v2 is the MVP portal for a real API key lifecycle:

- login and portal account binding
- server-side New API bridge for key creation, disable/delete, quota, usage, and recent logs
- model catalog with one launch `available` model and other candidates marked `coming_soon`
- customer dashboard for balance, requests, tokens, recent logs, API keys, and billing ledger
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
```

The browser must never receive New API admin credentials or internal New API user identifiers.
For rollback, set `APIPOOL_KEY_CREATION_ENABLED=false` before rolling back the
portal so new customer key creation stops while existing keys can still be
listed, disabled, or deleted.
If `newapi.apipool.dev` is deployed for operators, protect it separately with
operator login plus Basic Auth or an IP allowlist, and keep portal bridge traffic
on the internal service URL.

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
