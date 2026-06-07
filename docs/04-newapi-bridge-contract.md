# New API Bridge Contract

## Scope

The APIPool portal never calls New API from the browser. All New API access is server-only and starts from the current `portalUserId`. Frontend requests must not include `newapiUserId`, `newapiKeyId`, or the New API admin token.

## Environment

- `NEWAPI_INTEGRATION_ENABLED`: enables live bridge behavior when not set to `false`; disabled bridge calls fail before any remote request.
- `NEWAPI_BASE_URL`: required New API internal service origin, for example `http://newapi-internal:3000`. Do not expose this origin to browser traffic.
- `NEWAPI_ADMIN_TOKEN`: server-only bearer token for New API admin endpoints.
- `NEXT_PUBLIC_APIPOOL_API_BASE_URL`: public customer API base URL, currently `https://api.apipool.dev/v1`.

## Authentication

Bridge requests use:

```http
Authorization: Bearer $NEWAPI_ADMIN_TOKEN
Accept: application/json
Content-Type: application/json
Idempotency-Key: <operation key, for mutating requests>
```

## Endpoint Matrix

| Portal operation        | Method   | New API path                                          | Idempotency                               |
| ----------------------- | -------- | ----------------------------------------------------- | ----------------------------------------- |
| Health check            | `GET`    | `/api/admin/health`                                   | none                                      |
| Bind portal user        | `POST`   | `/api/admin/users`                                    | `portal-user:<portalUserId>`              |
| Create API key          | `POST`   | `/api/admin/keys`                                     | `portal-key:<portalUserId>:<uuid>`        |
| List API keys           | `GET`    | `/api/admin/keys?user_id=<newapiUserId>`              | none                                      |
| Disable API key         | `POST`   | `/api/admin/keys/<newapiKeyId>/disable`               | `portal-key-disable:<portalUserId>:<keyId>:<uuid>` |
| Delete API key          | `DELETE` | `/api/admin/keys/<newapiKeyId>`                       | `portal-key-delete:<portalUserId>:<keyId>:<uuid>`  |
| Read quota              | `GET`    | `/api/admin/users/<newapiUserId>/quota`               | none                                      |
| Read usage summary      | `GET`    | `/api/admin/users/<newapiUserId>/usage?range=<range>` | none                                      |
| Read recent logs        | `GET`    | `/api/admin/users/<newapiUserId>/logs?limit=20`       | none                                      |
| Manual quota adjustment | `POST`   | `/api/admin/users/<newapiUserId>/quota/adjust`        | `portal-adjustment:<portalUserId>:<uuid>` |

Supported usage summary ranges: `7d`, `30d`, and `month`.

## Request DTO Rules

- Bind portal user sends `portalUserId`, optional `email`, and `initialQuotaUsd: 0`. New APIPool portal users must start with zero quota; real calls require an operator-applied quota adjustment.
- Create API key sends the current user's mapped `newapiUserId`, key display name, allowed model list, optional quota limit, optional IP allowlist, and the idempotency key. Frontend callers never provide `newapiUserId`.
- List API keys reads the remote list for the current user's mapped `newapiUserId` when the bridge is available, then merges remote `active`, `disabled`, and `revoked` status into the portal key binding. If the remote read fails, the portal returns the local key snapshot instead of exposing an internal failure or remote identifiers.
- Usage summary `byModel` items must contain `modelId`, numeric `requests`, numeric `tokens`, and optional numeric `spendUsd`. Malformed model distribution data is rejected as a malformed bridge response.
- Manual quota adjustment sends only `amountUsd` and `reason` to the remote quota executor after the portal ledger row is created.

## Error Mapping

| HTTP/runtime result | Bridge code          | UI behavior                                |
| ------------------- | -------------------- | ------------------------------------------ |
| disabled bridge     | `not_configured`     | show bridge unavailable                    |
| missing base URL    | `not_configured`     | show bridge unavailable                    |
| missing token       | `not_configured`     | show bridge unavailable                    |
| `401`               | `unauthorized`       | show failed, require ops config            |
| `403`               | `forbidden`          | show failed, require ops permission        |
| `429`               | `rate_limited`       | show retriable failure                     |
| timeout             | `timeout`            | show retriable failure                     |
| non-2xx             | `remote_error`       | show retriable or failed state             |
| invalid JSON shape  | `malformed_response` | show failed, keep local state conservative |

Default timeout is 15 seconds.

## Retry Policy

- Default retry count is 1.
- Retries are limited to transient failures: `429`, timeout, and generic remote/runtime errors.
- Mutations are retried only when the bridge sends an `Idempotency-Key`.
- `GET` reads may be retried without an idempotency key.
- `401`, `403`, and malformed response bodies are never retried.

## Local State Rules

- Key creation writes `active` only after remote create and local binding both succeed.
- Remote create success plus local binding failure must enter `remote_created_binding_failed` and be compensated manually.
- Key listing treats New API status as authoritative when a remote list is available, but does not show `newapiUserId`, `newapiKeyId`, or idempotency keys to the browser.
- Disable/delete starts as `disable_pending` or `delete_pending`.
- Disable/delete only becomes completed after New API confirms the remote result.
- Failed remote mutation must remain `failed_retriable` or `failed_terminal`, never silently show success.
- Manual quota adjustment first writes a pending ledger row, then marks it `applied` only after New API returns a `changeId`.
- Failed quota adjustment keeps the ledger row with `failed` status and must not be presented as applied balance.

## Audit

Every bridge mutation writes `new_api_bridge_audit_log` with actor, portal user, target type, target id, status, idempotency key, redacted request/response body, and error message when present.
