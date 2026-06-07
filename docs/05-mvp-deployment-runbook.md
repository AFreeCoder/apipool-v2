# APIPool v2 MVP Deployment Runbook

This runbook is the release gate for the public MVP. It covers only the first
closed loop: login, create a real key, operator quota adjustment, one launch
model call, usage visibility, and disabled-key rejection.

## Required Environment

- `DATABASE_PROVIDER=sqlite`
- `DATABASE_URL`
- `NEWAPI_INTEGRATION_ENABLED=true`
- `APIPOOL_KEY_CREATION_ENABLED=true`
- `NEWAPI_BASE_URL`
- `NEWAPI_ADMIN_TOKEN`
- `NEXT_PUBLIC_APIPOOL_API_BASE_URL=https://api.apipool.dev/v1`
- `APIPOOL_SMOKE_PORTAL_USER_ID`
- `APIPOOL_SMOKE_OPERATOR_USER_ID`

`NEWAPI_BASE_URL` must point to the internal service URL used by the portal
server. Browser traffic must use `https://api.apipool.dev/v1`, never the New API
admin origin.

## New API Operator Surface

If `newapi.apipool.dev` is exposed for operations, it must be treated as an
operator-only surface.

- Require New API operator login.
- Add at least one extra perimeter layer: Basic Auth or IP allowlist.
- Set `X-Robots-Tag: noindex, nofollow` or an equivalent noindex policy.
- Keep `newapi.apipool.dev` out of public navigation, public docs, sitemap, and
  customer support copy.
- Keep portal bridge traffic on the internal service URL from `NEWAPI_BASE_URL`.

## Deployment Order

Run these checks in this order. Do not treat a later passing step as a substitute
for an earlier failed step.

1. New API health check: verify `/api/admin/health` through the internal service
   URL with the admin token.
2. bridge smoke: verify the portal server can authenticate to New API and receive
   typed responses without exposing internal identifiers to the browser.
3. portal build: run `pnpm install --frozen-lockfile`, `pnpm test`,
   `pnpm lint`, and `pnpm build`.
4. create Key smoke: create a real portal API key for the smoke user and confirm
   the plaintext key is shown only once.
5. API call smoke: apply manual quota, then call the launch model through
   `https://api.apipool.dev/v1`.
6. disabled key rejection smoke: disable the same key and confirm the same key
   receives an HTTP rejection.

The GitHub `APIPool MVP Verify` workflow runs local verification on push and PR.
Use `workflow_dispatch` for the live smoke gate after production secrets are set.

## Rollback Order

Rollback must preserve user assets and audit records.

1. Set `APIPOOL_KEY_CREATION_ENABLED=false` before rolling back the portal.
2. roll back the portal to the previous stable deployment.
3. do not delete existing New API keys.
4. do not delete ledger entries.
5. Keep New API quota adjustment records and bridge audit logs available for
   reconciliation.

If a remote mutation succeeded but the portal failed to bind local state, leave
the key in `remote_created_binding_failed` and compensate manually from the audit
log. Do not mark the operation as successful in the customer UI until local and
remote state agree.
