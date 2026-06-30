# User MVP Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` when executing business-code implementation tasks from this plan. Use `superpowers:verification-before-completion` before marking any task complete.

**Goal:** Bring APIPool_v2 user-mvp to the 2026-06-26 requirements baseline: a user can log in, recharge or receive quota, browse model listings, create a group-bound API Key, make a real or equivalent model call, and see balance/usage/Key state; an admin can maintain catalog/configuration and rescue key, billing, and usage failures.

**Architecture:** Next.js App Router + RSC pages; sqlite/libsql via Drizzle as the user-mvp database boundary; server-only New API bridge; catalog cache via `unstable_cache` + `catalog` tag; `/dashboard` for current-user self-service; `/admin` for RBAC-protected operations.

**Tech Stack:** Next.js 16, React 19, TypeScript, Drizzle ORM, sqlite/libsql, Better Auth, Resend, existing payment provider integration, New API bridge, `node:test`, `tsx`, true browser dogfood for UI/i18n/integration validation.

**Primary Inputs:**

- Requirements: `docs/08-user-mvp-requirements.md`
- Design: `docs/design/user-mvp/DESIGN.md`
- Review log: `docs/design/user-mvp/review-log.md`
- New API contract: `docs/04-newapi-contract.md`
- Payments ledger: `docs/06-payments-ledger.md`
- Runbook: `docs/07-runbook.md`

## Execution Rules

- Do not start implementation until the requirements/design/review artifacts are current.
- Keep management functionality in `/admin`; do not add admin-only controls to `/dashboard`.
- Public user surfaces must not expose internal IDs, New API admin concepts, or `newapiGroup`.
- Treat current implementation as partially complete: verify first, then patch only proven gaps.
- Every UI-facing task must include real browser validation and screenshot evidence before release.
- For each code task, add or update focused tests before claiming completion.

## Task 0: Freeze the Current Design Baseline

**Purpose:** Ensure future implementation starts from the 2026-06-26 baseline, not from the 2026-06-24 frozen draft.

**Files:**

- Read: `docs/08-user-mvp-requirements.md`
- Read: `docs/design/user-mvp/DESIGN.md`
- Read: `docs/design/user-mvp/review-log.md`
- Read: `docs/design/user-mvp/PLAN.md`
- Optional read: `docs/superpowers/plans/2026-06-26-user-mvp-refresh.md`

**Steps:**

- [ ] Confirm `DESIGN.md` status is “2026-06-26 需求基线修订版”.
- [ ] Confirm `review-log.md` contains the latest brainstorming + autoplan review.
- [ ] Confirm all “必须修改” items are either closed in design or represented below as implementation tasks.
- [ ] Confirm there are no unresolved placeholder markers in the three user-mvp docs.

**Verification:**

```bash
rg -n "TO""DO|TB""D|待""定|FIX""ME" docs/design/user-mvp docs/superpowers/plans/2026-06-26-user-mvp-refresh.md
```

Expected: no unresolved placeholders outside explanatory historical text.

## Task 1: Catalog Data Model and Public Boundary Audit

**Purpose:** Verify the model catalog supports provider, group, category, capability, status, model, and listing requirements without leaking internal routing details.

**Files:**

- Inspect: `src/config/db/schema.sqlite.ts`
- Inspect: `src/features/api-catalog/server/queries.ts`
- Inspect: `src/features/api-catalog/server/catalog-service.ts`
- Inspect: `src/features/api-catalog/lib/types.ts`
- Inspect: `src/app/[locale]/(landing)/models/page.tsx`
- Tests: `tests/api-catalog/*.test.ts`

**Implementation checks:**

- [ ] `catalog_category` exists and admin CRUD uses it as the category dictionary.
- [ ] `catalog_model.category` stores the category slug and does not imply New API routing.
- [ ] `catalog_model_listing` enforces `modelId + groupId` uniqueness.
- [ ] Public listing rows include category, group name/slug, status, prices, discount, capabilities, and callable visibility.
- [ ] Public listing rows do not include `catalog_* .id`, `newapiGroup`, New API admin URL, or backend-only naming.
- [ ] `/models` filters include supplier, group, category, capability, and status.

**Tests to run or add if missing:**

```bash
npm test -- tests/api-catalog
```

If the test runner does not support directory narrowing, run:

```bash
npm test
```

**Acceptance:**

- [ ] `/models` can show at least one configured callable listing.
- [ ] Same `modelId` can appear in two groups with different prices.
- [ ] A stringified public response does not contain `newapiGroup` or internal IDs.

## Task 2: Admin Catalog Operations

**Purpose:** Ensure admins can maintain all catalog dimensions required by the baseline.

**Files:**

- Inspect or modify if needed: `src/app/[locale]/(admin)/admin/catalog/**`
- Inspect or modify if needed: `src/config/locale/messages/en/admin/catalog.json`
- Inspect or modify if needed: `src/config/locale/messages/zh/admin/catalog.json`
- Inspect or modify if needed: `src/config/locale/index.ts`
- Tests: `tests/api-catalog/catalog-pages.test.ts`

**Implementation checks:**

- [ ] `/admin/catalog/vendors` supports list/create/edit/disable.
- [ ] `/admin/catalog/groups` supports `newapiGroup`, `allowCreateKey`, status, user-visible description.
- [ ] `/admin/catalog/categories` supports list/create/edit/disable.
- [ ] `/admin/catalog/capabilities` supports list/create/edit/disable.
- [ ] `/admin/catalog/statuses` supports `isCallable` and `isPublicVisible`.
- [ ] `/admin/catalog/models` supports vendor, category, context window, capability tagging.
- [ ] Listing subpages support group, status, input/output micro-USD prices, list prices, discount note, description, `smokeTested`.
- [ ] All catalog pages are gated by catalog read/write permissions.
- [ ] All catalog namespaces are registered; no raw `admin.catalog.*` keys appear in browser.

**Tests:**

```bash
npm test -- tests/api-catalog/catalog-pages.test.ts
```

**Browser validation:**

- [ ] Open each `/admin/catalog/*` page.
- [ ] Create or edit one safe test record in local/dev data.
- [ ] Capture screenshot evidence for table, form, and i18n rendering.

**Acceptance:**

- [ ] Admin can configure at least one supplier, one group, one category, one capability, one callable status, one model, one listing.
- [ ] The configured listing appears on `/models`.

## Task 3: Authentication and Email Configuration

**Purpose:** Keep login complete while preserving the requirement that email verification does not block API Key creation.

**Files:**

- Inspect or modify if needed: `src/core/auth/config.ts`
- Inspect or modify if needed: `src/shared/blocks/sign/sign-up.tsx`
- Inspect or modify if needed: `src/shared/blocks/sign/verify-email.tsx`
- Inspect or modify if needed: `src/app/[locale]/(admin)/admin/settings/[tab]/page.tsx`
- Inspect or modify if needed: `src/config/locale/messages/*/admin/settings.json`
- Tests: `tests/config/settings-page.test.ts`, auth-related tests if present

**Implementation checks:**

- [ ] Google and GitHub OAuth settings are configurable from `/admin/settings/auth`.
- [ ] Resend API key, sender, and email verification toggle are configurable from `/admin/settings/email`.
- [ ] Email verification uses link verification, not a custom code input flow.
- [ ] API Key creation path does not check `emailVerified`.
- [ ] Admin can perform a minimal email service check or a clearly documented equivalent.

**Tests:**

```bash
npm test -- tests/config/settings-page.test.ts
npm test
```

**Browser validation:**

- [ ] Verify settings tabs render without raw i18n keys.
- [ ] Verify secret fields are masked.
- [ ] Verify saving config shows a clear result.

**Acceptance:**

- [ ] Google/GitHub/email login are available when configured.
- [ ] Logged-in users can create API Keys regardless of email verification status.

## Task 4: API Key Lifecycle and Cleanup

**Purpose:** Make group-bound API Key creation reliable and diagnosable across remote and local failure modes.

**Files:**

- Inspect or modify if needed: `src/features/api-console/lib/key-input.ts`
- Inspect or modify if needed: `src/features/api-console/lib/status.ts`
- Inspect or modify if needed: `src/features/api-console/components/api-key-manager.tsx`
- Inspect or modify if needed: `src/features/newapi-bridge/server/client.ts`
- Inspect or modify if needed: `src/features/newapi-bridge/server/portal.ts`
- Inspect or modify if needed: `src/app/api/apipool/keys/**`
- Inspect or modify if needed: `src/app/[locale]/(landing)/dashboard/api-keys/page.tsx`
- Tests: `tests/api-console/*.test.ts`, `tests/newapi-bridge/*key*.test.ts`

**Implementation checks:**

- [ ] Create request body accepts `name` and `groupSlug` only.
- [ ] Server resolves `groupSlug -> catalog_group.id + newapiGroup`.
- [ ] Disabled or `allowCreateKey=false` groups cannot be selected or used.
- [ ] New API key creation uses `newapiGroup`.
- [ ] Local binding stores `groupId` and a `newapiGroup` snapshot for audit only.
- [ ] Public response and UI do not expose `groupId` or `newapiGroup`.
- [ ] Duplicate undeleted key names are rejected with a user-safe message.
- [ ] `creating_remote`, `failed_retriable`, `failed_terminal`, `remote_created_binding_failed` can be cleaned up.
- [ ] `deleted` keys are filtered from user lists.
- [ ] Disable/delete operations attempt remote sync and retain failure state on error.

**Tests:**

```bash
npm test -- tests/api-console
npm test -- tests/newapi-bridge
```

Fallback:

```bash
npm test
```

**Browser validation:**

- [ ] Create a key with a unique name; full key appears once.
- [ ] Try a duplicate name; UI shows a clear error.
- [ ] Disable the key; status changes and subsequent call fails.
- [ ] Delete the key; it no longer appears as usable.
- [ ] Seed or reproduce a failed key; cleanup removes it from the active list.

**Acceptance:**

- [ ] One group-bound key can make a successful real or equivalent model call.
- [ ] Failure states are visible, cleanable, and audited.

## Task 5: Billing, Ledger, and Low Balance UX

**Purpose:** Ensure users and admins can distinguish payment completion from quota arrival.

**Files:**

- Inspect or modify if needed: `src/features/newapi-bridge/server/portal.ts`
- Inspect or modify if needed: `src/features/apipool-ledger/**`
- Inspect or modify if needed: `src/app/[locale]/(landing)/dashboard/billing/page.tsx`
- Inspect or modify if needed: `src/features/api-console/components/balance-warning.tsx`
- Inspect or modify if needed: `src/app/api/payments/**` or provider webhook paths if present
- Tests: `tests/newapi-bridge/billing-ledger.test.ts`, ledger/payment tests if present

**Implementation checks:**

- [ ] Billing projection joins `apipool_ledger_entry` with `order` by `orderNo`.
- [ ] UI shows order time, amount, payment status, ledger arrival status.
- [ ] `amountUsd=5` displays as `$5.00`, not `$0.05` or `$500.00`.
- [ ] `ledger.status=pending` maps to “到账处理中”.
- [ ] `ledger.status=failed` maps to a clear failure state.
- [ ] Payment webhook is idempotent and does not double apply quota.
- [ ] Low balance warning does not misfire when balance is unknown.
- [ ] Pending paid order guidance points users to “到账处理中”.

**Tests:**

```bash
npm test -- tests/newapi-bridge/billing-ledger.test.ts
npm test
```

**Browser validation:**

- [ ] `/dashboard/billing` renders paid/applied, paid/pending, failed states.
- [ ] Low balance banner links to billing.

**Acceptance:**

- [ ] A user can see whether money was paid and whether quota arrived.
- [ ] Admin can identify and recover failed or stuck ledger entries.

## Task 6: Usage Synchronization and Dashboard Metrics

**Purpose:** Make the dashboard trustworthy after real API calls.

**Files:**

- Inspect or modify if needed: `src/features/newapi-bridge/server/portal.ts`
- Inspect or modify if needed: `src/app/[locale]/(landing)/dashboard/page.tsx`
- Inspect or modify if needed: `src/app/[locale]/(landing)/dashboard/usage/page.tsx`
- Inspect or modify if needed: `src/app/[locale]/(admin)/admin/users/[id]/detail/page.tsx`
- Tests: `tests/newapi-bridge/usage*.test.ts`, dashboard tests if present

**Implementation checks:**

- [ ] Usage summary tracks requests, input tokens, output tokens, spend, model distribution.
- [ ] `ready/empty/syncing/stale/failed` are represented in server data and UI.
- [ ] Sync failure with usable cache returns stale data and a warning.
- [ ] Sync failure without usable cache returns failed state, not fake success.
- [ ] Usage logs refresh without duplicate accumulation.
- [ ] UI list keys are unique even if New API repeats `newapiRequestId`.

**Tests:**

```bash
npm test -- tests/newapi-bridge
npm test
```

**Browser validation:**

- [ ] After a smoke call, `/dashboard` shows request count and token split.
- [ ] `/dashboard/usage` shows recent logs without duplicate key warnings.
- [ ] Stale/failed states have user-readable messages.

**Acceptance:**

- [ ] Real or equivalent call appears in usage.
- [ ] Balance and usage are consistent with New API response semantics.

## Task 7: Admin User Detail and Exception Handling

**Purpose:** Give operators the minimum tools to inspect and recover user-level issues.

**Files:**

- Inspect or modify if needed: `src/app/[locale]/(admin)/admin/users/page.tsx`
- Inspect or modify if needed: `src/app/[locale]/(admin)/admin/users/[id]/detail/page.tsx`
- Inspect or modify if needed: `src/app/[locale]/(admin)/admin/apipool-adjustments/page.tsx`
- Inspect or modify if needed: `src/features/api-console/components/admin/quota-adjustment-form.tsx`
- Inspect or modify if needed: `src/features/newapi-bridge/server/portal.ts`
- Tests: `tests/newapi-bridge/admin-user-detail.test.ts`, adjustment/ledger tests if present

**Implementation checks:**

- [ ] Admin user detail shows balance, usage, API Keys, and adjustment history.
- [ ] No binding is handled as an empty/admin-readable state.
- [ ] Usage sync failure is visible to admin.
- [ ] Manual quota adjustment supports increase and decrease.
- [ ] Each adjustment records operator, target user, amount, reason, time, status.
- [ ] Failed key, failed ledger, and failed usage cases can be identified and linked to audit data.

**Tests:**

```bash
npm test -- tests/newapi-bridge/admin-user-detail.test.ts
npm test
```

**Browser validation:**

- [ ] Open a user detail page with data.
- [ ] Open a user detail page with no New API binding.
- [ ] Execute a safe local/dev quota adjustment and verify ledger history.

**Acceptance:**

- [ ] Admin can inspect and rescue the required user-mvp failure classes without direct database access for routine cases.

## Task 8: End-to-End Smoke

**Purpose:** Prove the minimum user path works with a real or equivalent New API environment.

**Files:**

- Inspect or modify if needed: `scripts/smoke-mvp.ts`
- Inspect: `scripts/with-env.ts`
- Inspect: `.env` or local secret mechanism without committing secrets
- Inspect: `docs/07-runbook.md`

**Preconditions:**

- [ ] Local/dev DB migrated.
- [ ] `npm run catalog:init` has seeded or configured at least one provider/group/model/listing.
- [ ] The smoke group, typically `official`, has `newapiGroup` aligned with New API.
- [ ] Smoke user exists and can map to a New API user.
- [ ] Smoke model is callable.

**Commands:**

```bash
npm run catalog:init
npm run smoke:mvp
```

Live requirement:

```bash
APIPOOL_SMOKE_REQUIRE_LIVE=true npm run smoke:mvp
```

**Acceptance:**

- [ ] Smoke creates a group-bound API Key.
- [ ] Smoke makes a successful model call.
- [ ] Smoke observes usage and token split.
- [ ] Smoke disables the key and verifies it no longer works.
- [ ] Cleanup runs or leaves a documented, cleanable state.

## Task 9: True Browser Release Walkthrough

**Purpose:** Catch UI, i18n, and integration failures that static review and unit tests miss.

**Routes:**

- `/models`
- `/dashboard`
- `/dashboard/api-keys`
- `/dashboard/billing`
- `/dashboard/usage`
- `/admin/catalog/vendors`
- `/admin/catalog/groups`
- `/admin/catalog/categories`
- `/admin/catalog/capabilities`
- `/admin/catalog/statuses`
- `/admin/catalog/models`
- `/admin/settings/auth`
- `/admin/settings/email`
- `/admin/users`
- `/admin/users/[id]/detail`
- `/admin/apipool-adjustments`

**Checklist:**

- [ ] No raw i18n keys.
- [ ] No internal IDs or `newapiGroup` on public/user pages.
- [ ] Buttons are enabled/disabled according to state.
- [ ] Text does not overflow compact controls.
- [ ] Error and empty states are readable.
- [ ] Key creation, duplicate-name rejection, cleanup, disable, delete are clickable.
- [ ] Billing state labels distinguish payment and arrival.
- [ ] Usage logs do not show duplicate React key warnings.
- [ ] Screenshots are saved with route and timestamp.

**Acceptance:**

- [ ] Browser evidence covers every user and admin critical path.
- [ ] Any P0/P1 issue found here goes back to the relevant task, not to release notes.

## Task 10: Final Gate

**Purpose:** Decide whether user-mvp is ready for release.

**Commands:**

```bash
npm test
npm run smoke:mvp
APIPOOL_SMOKE_REQUIRE_LIVE=true npm run smoke:mvp
```

Use the live smoke command only when the live/sandbox New API credentials are available and intended for that run.

**Release checklist:**

- [ ] Requirements/design/review/plan are current.
- [ ] `npm test` passes.
- [ ] Smoke passes in local/equivalent environment.
- [ ] Live smoke passes if release depends on live New API evidence.
- [ ] Browser walkthrough screenshots are attached to the release record.
- [ ] OAuth, Resend, payment provider, and New API external dependency checks are complete.
- [ ] Runbook entries for failed Key cleanup, pending ledger, failed ledger, and usage sync failure are current.
- [ ] No business-code changes remain untested.

**Ship decision:**

- Ship only if all P0/P1 findings are closed.
- P2 findings may ship only when explicitly documented with owner and follow-up date.
- Deferred 12-month items must not be relabeled as user-mvp blockers.
