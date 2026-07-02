# Release Followups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the post-release New API option-map log error and GitHub Actions Node 20 deprecation annotations without mixing in broad, unrelated lint debt cleanup.

**Architecture:** Treat New API as an external runtime with a production data repair plus a repeatable guarded repair script in this repo. Treat GitHub Actions annotations as workflow dependency drift and upgrade action major versions to Node 24-compatible releases. Keep the 196 existing lint warnings out of this repair because they are wide template debt across UI, hooks, and legacy blocks; this plan only documents that boundary and keeps `pnpm lint` at 0 errors.

**Tech Stack:** Bash, SQLite CLI, GitHub Actions YAML, `node:test`, `tsx`, `pnpm`, New API upstream source reference.

---

## Analysis

Production New API logs repeatedly showed:

```text
syncing options from database
failed to update option map: unexpected end of JSON input
```

Read-only SQLite inspection of `/opt/apipool-v2/data/new-api/one-api.db` found:

```text
GroupGroupRatio=''
group_ratio_setting.group_special_usable_group=''
theme.frontend='default'
```

`theme.frontend='default'` is valid because upstream New API registers `theme.frontend` as a string setting. `GroupGroupRatio` is a legacy JSON map option loaded by `ratio_setting.UpdateGroupGroupRatioByJSONString`, so an empty string directly causes `unexpected end of JSON input`. `group_ratio_setting.group_special_usable_group` is a structured JSON map option whose upstream frontend default is `{}`; the current backend path silently ignores the bad empty value, but it should be repaired with the same data hygiene pass.

The GitHub Actions Node 20 annotation is not caused by `node-version: "22"`. It comes from JavaScript actions still pinned to Node 20 runtime majors:

```text
actions/checkout@v4
actions/setup-node@v4
pnpm/action-setup@v4
docker/login-action@v3
docker/metadata-action@v5
docker/build-push-action@v5
```

As of 2026-07-02, upstream latest releases are:

```text
actions/checkout@v7.0.0
actions/setup-node@v6.4.0
pnpm/action-setup@v6.0.9
docker/login-action@v4.2.0
docker/metadata-action@v6.1.0
docker/build-push-action@v7.3.0
```

`pnpm lint` currently exits 0 with 196 warnings. The warning distribution is broad: 152 unused vars, 29 hook dependency warnings, 10 `next/no-img-element`, 2 alt-text, and 3 unknown/unused eslint-disable warnings. Fixing all 196 in this release followup would touch many legacy/template UI files and create a mixed-scope branch. This plan leaves broad lint debt unchanged and avoids pretending it is fixed.

## File Map

- Create `deploy/repair-newapi-options.sh`: guarded dry-run/apply script for New API SQLite option map repairs.
- Create `tests/deploy/newapi-options-repair.test.ts`: TDD coverage for dry-run, apply, validation, and non-repairable invalid JSON.
- Modify `.github/workflows/docker-build.yaml`: upgrade checkout/docker action majors to Node 24-compatible versions.
- Modify `.github/workflows/mvp-verify.yaml`: upgrade checkout/setup-node/pnpm action majors to Node 24-compatible versions.
- Modify `tests/deploy/deploy-automation.test.ts`: guard workflow action versions, workflow semantics, and repair script presence.
- Modify `docs/07-runbook.md`: add operator playbook for New API option-map repair and explain why `theme.frontend=default` is not part of JSON validation.

## Task 1: New API Option Repair Script

**Files:**

- Create: `deploy/repair-newapi-options.sh`
- Create: `tests/deploy/newapi-options-repair.test.ts`
- Modify: `tests/deploy/deploy-automation.test.ts`
- Modify: `docs/07-runbook.md`

- [x] **Step 1: Write failing tests for dry-run and apply**

Create a temp SQLite DB with an `options(key text primary key, value text)` table. Insert `GroupGroupRatio=''`, `group_ratio_setting.group_special_usable_group=''`, valid `GroupRatio`, valid `TopupGroupRatio`, valid `UserUsableGroups`, valid `AutoGroups`, and `theme.frontend='default'`.

Expected behavior:

- `deploy/repair-newapi-options.sh --db <db>` exits 0, prints planned repairs, and leaves empty values unchanged.
- `deploy/repair-newapi-options.sh --db <db> --apply` exits 0 and changes the two empty object-map keys to `{}`.
- `theme.frontend='default'` is not reported as invalid JSON.
- valid non-empty operator values for both repair keys are preserved.
- running `--apply` twice is idempotent.

Run:

```bash
NODE_OPTIONS='--conditions react-server' pnpm exec tsx --test tests/deploy/newapi-options-repair.test.ts
```

Expected before implementation: FAIL because `deploy/repair-newapi-options.sh` does not exist.

- [x] **Step 2: Write failing tests for invalid non-repairable JSON**

Add a test case where `GroupRatio=''` exists. The repair script should leave `GroupRatio` untouched and exit non-zero with an invalid JSON/type report. This prevents the repair script from masking pricing/group configuration corruption outside the known empty optional maps.

Also cover:

- `GroupRatio='[]'` fails because it is valid JSON but the wrong type.
- `AutoGroups='{}'` fails because it must be a JSON array.
- missing repair keys are treated as repairable and are inserted as `{}` only with `--apply`.
- `NULL` repair-key values are treated like empty values.
- missing `options` table exits non-zero before writes.

Run the same targeted test command. Expected before implementation: FAIL.

- [x] **Step 3: Implement the repair script**

Implement `deploy/repair-newapi-options.sh` with:

- `set -Eeuo pipefail`
- `--db <path>` override
- `--apply` opt-in; default dry-run
- default DB path: `${APIPOOL_DEPLOY_DIR:-/opt/apipool-v2}/data/new-api/one-api.db`
- repair keys: `GroupGroupRatio`, `group_ratio_setting.group_special_usable_group`
- object JSON validation using both `json_valid(value)=1` and `json_type(value)='object'` for `GroupRatio`, `TopupGroupRatio`, `UserUsableGroups`, `GroupGroupRatio`, `group_ratio_setting.group_special_usable_group`
- array JSON validation using both `json_valid(value)=1` and `json_type(value)='array'` for `AutoGroups`
- explicit `theme.frontend` exclusion
- `command -v sqlite3` check
- DB readability and, for `--apply`, writability checks
- `options(key,value)` schema check before any mutation
- a non-blocking repair lock file `${APIPOOL_REPAIR_LOCK:-/run/apipool-v2-repair-newapi-options.lock}`
- non-blocking checks against existing deploy and backup locks, matching `/run/apipool-v2-deploy.lock` and `/run/apipool-v2-backup.lock`
- `PRAGMA busy_timeout=5000` and `BEGIN IMMEDIATE` for apply
- rollback SQL generation before writes, with file path and checksum printed
- explicit non-zero exit if non-repairable invalid JSON/type rows exist

For `--apply`, run a SQLite transaction that inserts missing repair keys as `{}` and updates only empty repair-key values to `{}`. Preserve any existing non-empty valid operator configuration.

- [x] **Step 4: Run targeted repair tests**

```bash
NODE_OPTIONS='--conditions react-server' pnpm exec tsx --test tests/deploy/newapi-options-repair.test.ts tests/deploy/deploy-automation.test.ts
```

Expected: PASS.

- [x] **Step 5: Update runbook**

Add a short section to `docs/07-runbook.md`:

- symptom: `failed to update option map: unexpected end of JSON input`
- read-only diagnosis command using `sqlite3 ... json_valid`
- safe dry-run command
- backup command before apply and a verification command showing the backup contains `data/new-api/one-api.db`
- apply command and the rollback SQL path/checksum emitted by the script
- DB readback command for both repaired keys
- log verification command
- health check command for `http://127.0.0.1:3001/api/status`
- fallback restart procedure: only if the next sync after repair still logs the same error, restart `new-api` only, then recheck `/api/status` and logs
- warning that `theme.frontend=default` is a valid string setting, not a JSON-map error

## Task 2: GitHub Actions Node 24 Runtime Update

**Files:**

- Modify: `.github/workflows/docker-build.yaml`
- Modify: `.github/workflows/mvp-verify.yaml`
- Modify: `tests/deploy/deploy-automation.test.ts`

- [x] **Step 1: Write failing workflow tests**

Extend `tests/deploy/deploy-automation.test.ts` to assert:

```text
actions/checkout@v7
actions/setup-node@v6
pnpm/action-setup@v6
docker/login-action@v4
docker/metadata-action@v6
docker/build-push-action@v7
```

Also assert:

- older majors are absent from `.github/workflows/*.yaml`
- `runs-on: ubuntu-latest` remains GitHub-hosted for Node 24-compatible action runtime support
- workflow triggers still target `main` and `dev`
- `pull_request` still does not push Docker images
- `deploy-production` remains gated to `push` on `refs/heads/main`
- Docker tag generation still includes `type=sha,format=long`
- deploy SSH command still runs `./deploy/deploy.sh '$IMAGE_TAG'`
- `node-version: "22"` remains unchanged

Run:

```bash
NODE_OPTIONS='--conditions react-server' pnpm exec tsx --test tests/deploy/deploy-automation.test.ts
```

Expected before implementation: FAIL because workflows still use older majors.

- [x] **Step 2: Update workflow action versions**

Update:

```text
actions/checkout@v4 -> actions/checkout@v7
actions/setup-node@v4 -> actions/setup-node@v6
pnpm/action-setup@v4 -> pnpm/action-setup@v6
docker/login-action@v3 -> docker/login-action@v4
docker/metadata-action@v5 -> docker/metadata-action@v6
docker/build-push-action@v5 -> docker/build-push-action@v7
```

Do not change workflow semantics, branch triggers, image tags, deploy SSH commands, or `node-version: "22"`.

- [x] **Step 3: Run targeted workflow tests**

```bash
NODE_OPTIONS='--conditions react-server' pnpm exec tsx --test tests/deploy/deploy-automation.test.ts
```

Expected: PASS.

## Task 3: Production Data Repair

**Files:**

- No repository file edits beyond Task 1/2.

Do not push this workflow-change branch directly to `main`. First validate branch/PR CI, because pushing `main` triggers `deploy-production`.

- [x] **Step 1: Dry-run production repair**

After script exists locally, copy it to a temp path on the VPS for the first manual repair. The script must not be wired into `deploy.sh`; the permanent copy enters `/opt/apipool-v2/deploy/` only after the branch is landed by the normal release flow.

```bash
scp deploy/repair-newapi-options.sh apipool_vps:/tmp/repair-newapi-options.sh
ssh apipool_vps 'chmod 700 /tmp/repair-newapi-options.sh && /tmp/repair-newapi-options.sh'
```

Expected: reports the two empty repair keys and no non-repairable invalid group-ratio JSON keys.

- [x] **Step 2: Backup production before apply**

```bash
ssh apipool_vps 'cd /opt/apipool-v2 && ./deploy/backup.sh pre-deploy'
```

Then verify the newest backup contains New API SQLite:

```bash
ssh apipool_vps 'tar -tzf "$(ls -t /opt/apipool-v2/backups/pre-deploy-*.tar.gz | head -1)" | grep -E "data/new-api/one-api.db$"'
```

Expected: prints a new backup archive path and the archive contains `data/new-api/one-api.db`.

- [x] **Step 3: Apply production repair**

```bash
ssh apipool_vps '/tmp/repair-newapi-options.sh --apply'
```

Expected: updates `GroupGroupRatio` and `group_ratio_setting.group_special_usable_group` to `{}` or confirms they are already valid, and prints rollback SQL path plus checksum.

- [x] **Step 4: Verify DB readback, health, and New API logs**

Read back repaired values:

```bash
ssh apipool_vps 'sqlite3 -header -column /opt/apipool-v2/data/new-api/one-api.db "select key, quote(value), json_valid(value), json_type(value) from options where key in (\"GroupGroupRatio\", \"group_ratio_setting.group_special_usable_group\");"'
```

Check health:

```bash
ssh apipool_vps 'curl -fsS http://127.0.0.1:3001/api/status >/dev/null'
```

Wait for the next options sync interval, then run:

```bash
ssh apipool_vps 'docker logs --since 3m apipool-v2-new-api-1 2>&1 | grep -E "syncing options|failed to update option map" | tail -40'
```

Expected: `syncing options from database` may remain; `failed to update option map: unexpected end of JSON input` should not recur after the repair timestamp.

If the same error recurs after a successful DB readback and one sync cycle, restart only New API and recheck health/logs:

```bash
ssh apipool_vps 'cd /opt/apipool-v2 && docker compose --env-file .env.deploy --env-file release.env -f docker-compose.prod.yml restart new-api && curl -fsS http://127.0.0.1:3001/api/status >/dev/null'
```

## Task 4: Verification

**Files:**

- All changed files.

- [x] **Step 1: Format changed files**

```bash
pnpm exec prettier --write tests/deploy/newapi-options-repair.test.ts tests/deploy/deploy-automation.test.ts docs/07-runbook.md docs/plan/release-followups/implementation-plan.md .github/workflows/docker-build.yaml .github/workflows/mvp-verify.yaml
bash -n deploy/repair-newapi-options.sh
```

- [x] **Step 2: Run targeted tests**

```bash
NODE_OPTIONS='--conditions react-server' pnpm exec tsx --test tests/deploy/newapi-options-repair.test.ts tests/deploy/deploy-automation.test.ts tests/deploy/mvp-deployment-runbook.test.ts
```

- [x] **Step 3: Run repository gates**

```bash
pnpm exec tsc --noEmit --pretty false
pnpm test
pnpm lint
pnpm exec eslint . --max-warnings=196
pnpm build
git diff --check
```

Expected:

- `tsc`, `test`, `build`, and `git diff --check` exit 0.
- `pnpm lint` exits 0. Existing broad warnings may remain; do not claim lint is clean unless warning count reaches 0.
- `pnpm exec eslint . --max-warnings=196` exits 0, proving this branch did not increase the current warning count.

## Out of Scope

- Full cleanup of all 196 existing lint warnings.
- Changing New API container image version.
- Changing New API group/pricing semantics beyond empty optional map repair.
- Pushing to `main` or deploying workflow changes without a separate push-deploy request.
