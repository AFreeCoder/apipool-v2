# User MVP Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` when executing business-code implementation tasks from this plan. Use `superpowers:verification-before-completion` before marking any task complete.

**Goal:** Bring APIPool_v2 user-mvp to the 2026-06-26 requirements baseline: a user can log in, recharge or receive quota, browse model listings, create a group-bound API Key, make a real or equivalent model call, and see balance/usage/Key state; an admin can maintain catalog/configuration and rescue key, billing, and usage failures.

**Architecture:** Next.js App Router + RSC pages; sqlite/libsql via Drizzle as the user-mvp database boundary; server-only New API bridge; catalog cache via `unstable_cache` + `catalog` tag; `/dashboard` for current-user self-service; `/admin` for RBAC-protected operations.

**Tech Stack:** Next.js 16, React 19, TypeScript, Drizzle ORM, sqlite/libsql, Better Auth, Resend, existing payment provider integration, New API bridge, `node:test`, `tsx`, true browser dogfood for UI/i18n/integration validation.

## Canonical Plan

The canonical, repository-local implementation plan is:

- `docs/design/user-mvp/PLAN.md`

This file exists at the standard `superpowers:writing-plans` path so future agents can discover the plan through the skill convention without creating a second divergent checklist.

## Execution Order

Follow the canonical plan tasks in order:

- [ ] Task 0: Freeze the current design baseline.
- [ ] Task 1: Catalog data model and public boundary audit.
- [ ] Task 2: Admin catalog operations.
- [ ] Task 3: Authentication and email configuration.
- [ ] Task 4: API Key lifecycle and cleanup.
- [ ] Task 5: Billing, ledger, and low balance UX.
- [ ] Task 6: Usage synchronization and dashboard metrics.
- [ ] Task 7: Admin user detail and exception handling.
- [ ] Task 8: End-to-end smoke.
- [ ] Task 9: True browser release walkthrough.
- [ ] Task 10: Final gate.

## Required Commands

```bash
npm test
npm run smoke:mvp
APIPOOL_SMOKE_REQUIRE_LIVE=true npm run smoke:mvp
```

Use the live smoke command only when real or sandbox New API credentials are configured for that run.

## Final Acceptance

- Requirements, design, review log, and plan are current.
- All “必须修改” review findings are closed or intentionally represented as executable tasks.
- Public/user pages do not expose internal IDs or `newapiGroup`.
- `/admin` owns all management and recovery workflows.
- Automated tests pass.
- Smoke validates the group-bound key path.
- True browser walkthrough covers UI, i18n, and integration states with screenshots.
