# New API Username Ledger Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 交付 Phase A：门户侧以规范化短邮箱同步 New API username，长邮箱可审计阻断，余额/ledger/API Key 继续以 New API 为执行事实源，并提供后台最小补偿闭环。

**Architecture:** 保持现有 `newapi-bridge` 方向，小步扩展 `portal.ts`、`client.ts` 和 SQLite/libSQL schema。所有自动 username 目标统一来自服务端邮箱规范化 helper；`<=20` 邮箱进入自动创建/更新路径，`>20` 邮箱进入 `username_sync_failed/newapi_username_too_long`，不生成 `pu_<hash>` 或其它技术名。后台只做用户列表筛选、详情状态、retry/confirm conflict/disable 三个最小动作；Phase B 的 New API 自管/patch 镜像与长邮箱自动同步不在本轮实现内。

**Tech Stack:** Next.js 16 App Router, TypeScript, Better Auth database hooks, Drizzle ORM, SQLite/libSQL migrations, node:test + tsx, New API admin/user HTTP API, next-intl message JSON.

---

## Scope Guardrails

- Phase A 只自动支持规范化邮箱长度 `<=20` 的用户。
- 规范化邮箱长度 `>20` 必须阻断为 binding `status='username_sync_failed'` 且 `lastSyncErrorCode='newapi_username_too_long'`，不得创建 `pu_<hash>`、hash 邮箱或截断邮箱。
- Phase B 才处理 New API 自管/patch 镜像放宽 `Username` / `DisplayName`，并重复 Update User spike；本计划不实现 Phase B。
- 本轮只改 sqlite/libsql：`src/config/db/schema.sqlite.ts` 与 `src/config/db/migrations_sqlite/*`。不要修改 `src/config/db/schema.mysql.ts` 或 `src/config/db/schema.postgres.ts`。
- `updateUserProfile()` 的 `role` 必须从远端用户回读后原样提交；调用方不得传入 `role`。
- 注册后 provision 是 best-effort：失败必须落状态和审计，但不得破坏 Better Auth 用户创建。
- 普通用户邮箱变更本轮不开放。后台短邮箱变更必须远端 username 成功后再提交本地 `user.email`；长邮箱默认不提交本地 email，只审计阻断。
- 用户侧 DTO、错误和页面响应不得暴露 `newapiUserId`、`newapiKeyId`、access token、admin token、内部 group、内部域名、密码、完整 Key、完整远端响应或原始 SQL/validation 细节。

## File Structure

- Modify: `src/config/db/schema.sqlite.ts`
  - 扩展 `newApiUserBinding` 字段、状态注释和索引。
- Create: `src/config/db/migrations_sqlite/0009_newapi_username_sync_status.sql`
  - 增加 sqlite/libsql 字段、索引和旧 binding 初始状态迁移。
- Modify: `src/config/db/migrations_sqlite/meta/_journal.json`
  - 登记 `0009_newapi_username_sync_status`。
- Create/Modify: `src/config/db/migrations_sqlite/meta/0009_snapshot.json`
  - 手工维护 Drizzle schema 快照，与 SQL 和 journal 对齐。
- Modify: `src/features/newapi-bridge/server/client.ts`
  - 新增 `updateUserProfile()`、远端用户回读/冲突检测、`newapi_username_too_long` 错误映射。
- Modify: `src/features/newapi-bridge/server/portal.ts`
  - 新增 `normalizeNewapiUsernameEmail()`、注册后 provision、邮箱同步 helper、binding 状态机、admin action 底层函数、Key/usage/ledger 前置阻断和审计。
- Modify: `src/core/auth/config.ts`
  - 在 `databaseHooks.user.create.after` 中 best-effort 调用 `provisionPortalUserAfterSignup()`。
- Modify: `src/shared/models/user.ts`
  - 保持 `updateUser()` 不允许 email；扩展后台用户列表查询的 New API binding 安全 DTO 和筛选条件。
- Modify: `src/app/[locale]/(admin)/admin/users/page.tsx`
  - 增加 `newApiBindingStatus`、`lastSyncErrorCode` 筛选和列表安全 DTO 字段。
- Modify: `src/app/[locale]/(admin)/admin/users/[id]/detail/page.tsx`
  - 增加 New API binding 状态卡片、retry/confirm conflict/disable action 表单入口。
- Create: `src/features/newapi-bridge/server/admin-user-binding-actions.ts`
  - 管理员 server action 层：权限检查、调用 bridge helper、返回去敏结果。
- Modify: `src/config/locale/messages/zh/admin/users.json`
  - 增加后台列表/详情/action 中文文案。
- Modify: `src/config/locale/messages/en/admin/users.json`
  - 增加后台列表/详情/action 英文文案。
- Modify: `tests/newapi-bridge/client.test.ts`
  - 覆盖 `updateUserProfile()` 成功、冲突、长 username validation、`role` 远端回读。
- Modify: `tests/newapi-bridge/portal.test.ts`
  - 覆盖 schema 字段、邮箱规范化、注册 best-effort、binding 状态、审计、usage/ledger 前置阻断和 DTO 去敏。
- Modify: `tests/newapi-bridge/create-portal-key.test.ts`
  - 覆盖 Key 创建前 binding 非 active、长邮箱阻断和不创建错误远端用户。

---

### Task 1: Schema + Migration + Types/Status 字段

**Files:**
- Modify: `tests/newapi-bridge/portal.test.ts`
- Modify: `src/config/db/schema.sqlite.ts`
- Create: `src/config/db/migrations_sqlite/0009_newapi_username_sync_status.sql`
- Modify: `src/config/db/migrations_sqlite/meta/_journal.json`
- Create/Modify: `src/config/db/migrations_sqlite/meta/0009_snapshot.json`

- [x] **Step 1: Write the failing migration/schema test**

In `tests/newapi-bridge/portal.test.ts`, extend `setupPortalDb()` imports to include `newApiUserBinding`, then add this test near the first binding-related tests:

```ts
test('newapi user binding sync fields survive sqlite migrations', async () => {
  const portalUser = await insertUser(
    'portal_user_binding_sync_schema',
    'a@b.co'
  );
  const attemptedAt = new Date(1782931200000);

  const [row] = await modules
    .db()
    .insert(modules.newApiUserBinding)
    .values({
      id: 'binding_sync_schema_row',
      portalUserId: portalUser.id,
      newapiUserId: 'pending:binding-sync-schema',
      status: 'username_sync_failed',
      newapiUsername: 'pu_legacy',
      targetNewapiUsername: 'a@b.co',
      lastSyncErrorCode: 'newapi_username_too_long',
      lastSyncError: 'New API username exceeds the Phase A limit',
      lastSyncAction: 'signup_provision',
      lastSyncAttemptedAt: attemptedAt,
      conflictNewapiUserId: 'remote_conflict_42',
    })
    .returning();

  assert.equal(row.targetNewapiUsername, 'a@b.co');
  assert.equal(row.lastSyncErrorCode, 'newapi_username_too_long');
  assert.equal(row.lastSyncAction, 'signup_provision');
  assert.equal(row.conflictNewapiUserId, 'remote_conflict_42');
  assert.equal(row.lastSyncAttemptedAt?.getTime(), attemptedAt.getTime());
});
```

Also add `newApiUserBinding` to the `modules = { ... }` object:

```ts
modules = {
  db,
  newApiBridgeAuditLog,
  newApiKeyBinding,
  newApiUserBinding,
  NewApiBridgeError,
  portal,
  catalogGroup,
  usageLogSnapshot,
  usageSnapshot,
  user,
};
```

- [x] **Step 2: Run the test and verify it fails**

Run:

```bash
NODE_OPTIONS='--conditions react-server' pnpm exec tsx --test tests/newapi-bridge/portal.test.ts --test-name-pattern 'newapi user binding sync fields survive sqlite migrations'
```

Expected: FAIL because `newApiUserBinding.targetNewapiUsername` and related fields are not present in `schema.sqlite.ts` or the SQLite table.

- [x] **Step 3: Update the SQLite schema**

In `src/config/db/schema.sqlite.ts`, update `newApiUserBinding`:

```ts
    status: text('status').notNull(), // pending, provisioning, active, username_sync_pending, username_sync_failed, conflict_requires_review, disabled
    newapiUsername: text('newapi_username'),
    targetNewapiUsername: text('target_newapi_username'),
    lastSyncErrorCode: text('last_sync_error_code'),
    lastSyncError: text('last_sync_error'),
    lastSyncAction: text('last_sync_action'),
    lastSyncedAt: integer('last_synced_at', { mode: 'timestamp_ms' }),
    lastSyncAttemptedAt: integer('last_sync_attempted_at', {
      mode: 'timestamp_ms',
    }),
    conflictNewapiUserId: text('conflict_newapi_user_id'),
    newapiPasswordEnc: text('newapi_password_enc'),
    newapiAccessTokenEnc: text('newapi_access_token_enc'),
```

Extend the index list:

```ts
    index('idx_newapi_user_binding_status').on(table.status),
    index('idx_newapi_user_binding_target_username').on(
      table.targetNewapiUsername
    ),
    index('idx_newapi_user_binding_sync_error_code').on(
      table.lastSyncErrorCode
    ),
```

- [x] **Step 4: Add the SQLite/libSQL migration**

Create `src/config/db/migrations_sqlite/0009_newapi_username_sync_status.sql` with these statements:

```sql
ALTER TABLE `newapi_user_binding` ADD `target_newapi_username` text;
--> statement-breakpoint
ALTER TABLE `newapi_user_binding` ADD `last_sync_error_code` text;
--> statement-breakpoint
ALTER TABLE `newapi_user_binding` ADD `last_sync_error` text;
--> statement-breakpoint
ALTER TABLE `newapi_user_binding` ADD `last_sync_action` text;
--> statement-breakpoint
ALTER TABLE `newapi_user_binding` ADD `last_synced_at` integer;
--> statement-breakpoint
ALTER TABLE `newapi_user_binding` ADD `last_sync_attempted_at` integer;
--> statement-breakpoint
ALTER TABLE `newapi_user_binding` ADD `conflict_newapi_user_id` text;
--> statement-breakpoint
UPDATE `newapi_user_binding`
SET `target_newapi_username` = (
  SELECT lower(trim(`user`.`email`))
  FROM `user`
  WHERE `user`.`id` = `newapi_user_binding`.`portal_user_id`
)
WHERE `target_newapi_username` IS NULL;
--> statement-breakpoint
UPDATE `newapi_user_binding`
SET
  `status` = CASE
    WHEN `target_newapi_username` IS NULL OR `target_newapi_username` = '' THEN 'username_sync_failed'
    WHEN length(`target_newapi_username`) > 20 THEN 'username_sync_failed'
    WHEN `status` = 'active'
      AND `newapi_username` IS NOT NULL
      AND `newapi_username` <> `target_newapi_username` THEN 'username_sync_pending'
    ELSE `status`
  END,
  `last_sync_error_code` = CASE
    WHEN `target_newapi_username` IS NULL OR `target_newapi_username` = '' THEN 'portal_user_email_missing'
    WHEN length(`target_newapi_username`) > 20 THEN 'newapi_username_too_long'
    ELSE `last_sync_error_code`
  END,
  `last_sync_error` = CASE
    WHEN `target_newapi_username` IS NULL OR `target_newapi_username` = '' THEN 'Portal user email is missing'
    WHEN length(`target_newapi_username`) > 20 THEN 'New API username exceeds the Phase A limit'
    ELSE `last_sync_error`
  END,
  `last_sync_action` = CASE
    WHEN `last_sync_action` IS NULL THEN 'migration_backfill'
    ELSE `last_sync_action`
  END;
--> statement-breakpoint
CREATE INDEX `idx_newapi_user_binding_target_username` ON `newapi_user_binding` (`target_newapi_username`);
--> statement-breakpoint
CREATE INDEX `idx_newapi_user_binding_sync_error_code` ON `newapi_user_binding` (`last_sync_error_code`);
```

- [x] **Step 5: Update migration metadata by hand**

This plan uses a stable hand-maintained migration name, not Drizzle's generated nickname. Do not run `pnpm db:generate` as the source of truth for the migration name. Update `src/config/db/migrations_sqlite/meta/_journal.json` and `src/config/db/migrations_sqlite/meta/0009_snapshot.json` manually so they match `schema.sqlite.ts` and `0009_newapi_username_sync_status.sql`.

In `_journal.json`, keep the top-level fields exactly aligned with the existing file: top-level `"version"` remains the current value already present in the repo, currently `"7"`, and `"dialect"` remains `"sqlite"`. Append an entry with `idx: 9`; the entry-level `"version"` should match the existing entries, currently `"6"`.

Expected appended `_journal.json` entry shape:

```json
{
  "idx": 9,
  "version": "6",
  "when": 1783017600000,
  "tag": "0009_newapi_username_sync_status",
  "breakpoints": true
}
```

Then copy `meta/0008_snapshot.json` to `meta/0009_snapshot.json` and update only the `newapi_user_binding` table definition and indexes to include:

```json
"target_newapi_username",
"last_sync_error_code",
"last_sync_error",
"last_sync_action",
"last_synced_at",
"last_sync_attempted_at",
"conflict_newapi_user_id",
"idx_newapi_user_binding_target_username",
"idx_newapi_user_binding_sync_error_code"
```

Run:

```bash
node -e "const fs=require('fs'); const j=JSON.parse(fs.readFileSync('src/config/db/migrations_sqlite/meta/_journal.json','utf8')); if (j.version !== '7' || j.dialect !== 'sqlite') process.exit(1); const e=j.entries.at(-1); if (!e || e.idx !== 9 || e.version !== '6' || e.tag !== '0009_newapi_username_sync_status') process.exit(1); JSON.parse(fs.readFileSync('src/config/db/migrations_sqlite/meta/0009_snapshot.json','utf8'));"
rg -n "target_newapi_username|last_sync_error_code|conflict_newapi_user_id|idx_newapi_user_binding_target_username|idx_newapi_user_binding_sync_error_code" src/config/db/migrations_sqlite/meta/0009_snapshot.json
```

Expected: both commands exit 0, proving journal metadata is valid JSON and the snapshot includes the new fields/indexes.

- [x] **Step 6: Run the focused test and full bridge migration-backed tests**

Run:

```bash
NODE_OPTIONS='--conditions react-server' pnpm exec tsx --test tests/newapi-bridge/portal.test.ts --test-name-pattern 'newapi user binding sync fields survive sqlite migrations'
NODE_OPTIONS='--conditions react-server' pnpm exec tsx --test tests/newapi-bridge/portal.test.ts tests/newapi-bridge/create-portal-key.test.ts
```

Expected: PASS. Existing bridge tests still apply migrations from `src/config/db/migrations_sqlite` into temporary SQLite DBs without missing-column errors.

- [x] **Step 7: Run phase check and record changed files**

Run:

```bash
git diff --check
git status --short
```

Expected: `git diff --check` exits 0. `git status --short` shows only Task 1 files plus any pre-existing untracked requirement/design context. Do not run `git add` or `git commit` unless the user explicitly authorizes staging/committing or a later ship workflow requires it.

---

### Task 2: New API Client `getUserProfile`、`updateUserProfile` 和错误映射测试

**Files:**
- Modify: `tests/newapi-bridge/client.test.ts`
- Modify: `src/features/newapi-bridge/server/client.ts`

- [x] **Step 1: Write the failing client success test**

Append this test in `tests/newapi-bridge/client.test.ts` after the `ensureUserGroup` tests:

```ts
test('updateUserProfile preserves remote role and sends a full user profile payload', async () => {
  let updateBody: any;
  const { client } = createMockedClient({
    'GET /api/user/search': (req) => {
      const keyword = new URL(req.url).searchParams.get('keyword');
      if (keyword === 'oldname') {
        return ok({
          items: [
            {
              id: 7,
              username: 'oldname',
              display_name: 'Old Name',
              group: 'old-group',
              role: 10,
              remark: 'apipool:portalUserId:user_7',
            },
          ],
        });
      }
      if (keyword === 'a@b.co') {
        return ok({
          items: [
            {
              id: 7,
              username: 'a@b.co',
              display_name: 'a@b.co',
              group: 'ng-official',
              role: 10,
              remark: 'apipool:portalUserId:user_7',
            },
          ],
        });
      }
      return ok({ items: [] });
    },
    'PUT /api/user/': async (req) => {
      updateBody = await req.json();
      return ok({ id: 7 });
    },
  });

  const result = await client.updateUserProfile({
    newapiUserId: '7',
    currentUsername: 'oldname',
    username: 'a@b.co',
    displayName: 'a@b.co',
    group: 'ng-official',
    remark: 'apipool:portalUserId:user_7',
  });

  assert.deepEqual(updateBody, {
    id: 7,
    username: 'a@b.co',
    display_name: 'a@b.co',
    group: 'ng-official',
    role: 10,
    remark: 'apipool:portalUserId:user_7',
  });
  assert.equal(result.newapiUserId, '7');
  assert.equal(result.username, 'a@b.co');
  assert.equal(result.role, 10);
});
```

This plan intentionally allows `currentUsername` for remote lookup, but does not allow callers to pass `role`.

- [x] **Step 2: Write the failing client error tests**

Append these tests in `tests/newapi-bridge/client.test.ts`:

```ts
test('updateUserProfile refuses to overwrite a different remote user with the target username', async () => {
  const { client } = createMockedClient({
    'GET /api/user/search': (req) => {
      const keyword = new URL(req.url).searchParams.get('keyword');
      if (keyword === 'oldname') {
        return ok({
          items: [
            {
              id: 7,
              username: 'oldname',
              display_name: 'Old Name',
              group: 'default',
              role: 1,
              remark: '',
            },
          ],
        });
      }
      if (keyword === 'a@b.co') {
        return ok({
          items: [
            {
              id: 8,
              username: 'a@b.co',
              display_name: 'a@b.co',
              group: 'default',
              role: 1,
              remark: '',
            },
          ],
        });
      }
      return ok({ items: [] });
    },
    'PUT /api/user/': () => ok({}),
  });

  await assert.rejects(
    client.updateUserProfile({
      newapiUserId: '7',
      currentUsername: 'oldname',
      username: 'a@b.co',
      displayName: 'a@b.co',
    }),
    (error: any) =>
      error instanceof NewApiBridgeError &&
      error.code === 'conflict_requires_review'
  );
});

test('updateUserProfile maps New API max validation failures to newapi_username_too_long', async () => {
  const { client } = createMockedClient({
    'GET /api/user/search': (req) => {
      const keyword = new URL(req.url).searchParams.get('keyword');
      if (keyword === 'oldname') {
        return ok({
          items: [
            {
              id: 7,
              username: 'oldname',
              display_name: 'Old Name',
              group: 'default',
              role: 1,
              remark: '',
            },
          ],
        });
      }
      return ok({ items: [] });
    },
    'PUT /api/user/': () =>
      fail("Key: 'User.Username' Error:Field validation for 'Username' failed on the 'max' tag"),
  });

  await assert.rejects(
    client.updateUserProfile({
      newapiUserId: '7',
      currentUsername: 'oldname',
      username: 'very-long-email@example.com',
      displayName: 'very-long-email@example.com',
    }),
    (error: any) =>
      error instanceof NewApiBridgeError &&
      error.code === 'newapi_username_too_long'
  );
});

test('getUserProfile confirms a remote user by username and id without returning credentials', async () => {
  const { client } = createMockedClient({
    'GET /api/user/search': (req) => {
      const keyword = new URL(req.url).searchParams.get('keyword');
      assert.equal(keyword, 'a@b.co');
      return ok({
        items: [
          {
            id: 7,
            username: 'a@b.co',
            display_name: 'a@b.co',
            group: 'ng-official',
            role: 1,
            remark: 'apipool:portalUserId:user_7',
          },
        ],
      });
    },
  });

  const profile = await client.getUserProfile({
    newapiUserId: '7',
    username: 'a@b.co',
  });

  assert.equal(profile.newapiUserId, '7');
  assert.equal(profile.username, 'a@b.co');
  assert.equal(profile.group, 'ng-official');
  assert.equal(Object.hasOwn(profile as any, 'accessToken'), false);
  assert.equal(Object.hasOwn(profile as any, 'password'), false);
});
```

- [x] **Step 3: Run tests and verify they fail**

Run:

```bash
NODE_OPTIONS='--conditions react-server' pnpm exec tsx --test tests/newapi-bridge/client.test.ts --test-name-pattern 'updateUserProfile'
```

Expected: FAIL because `client.getUserProfile`, `client.updateUserProfile` and new error codes do not exist.

- [x] **Step 4: Implement client types and error codes**

In `src/features/newapi-bridge/server/client.ts`, extend `NewApiBridgeErrorCode`:

```ts
  | 'conflict_requires_review'
  | 'newapi_username_too_long';
```

Add exported profile types near `RemoteProvisionedUser`:

```ts
export type RemoteUserProfile = {
  newapiUserId: string;
  username: string;
  displayName: string;
  group: string;
  role: number;
  remark: string;
};

export type NewApiUserProfileUpdateInput = {
  newapiUserId: string;
  currentUsername?: string;
  username: string;
  displayName?: string;
  group?: string;
  remark?: string;
};
```

- [x] **Step 5: Implement remote user lookup helpers**

Replace the inline return shape inside `findUserByUsername()` with a reusable parser:

```ts
function toRemoteUserProfile(item: any, fallbackUsername: string): RemoteUserProfile | undefined {
  if (!item?.id) return undefined;
  const username = String(item.username || fallbackUsername);
  return {
    newapiUserId: String(item.id),
    username,
    displayName:
      typeof item.display_name === 'string'
        ? item.display_name
        : username,
    group: typeof item.group === 'string' ? item.group : '',
    role: typeof item.role === 'number' ? item.role : 1,
    remark: typeof item.remark === 'string' ? item.remark : '',
  };
}
```

Then make `findUserByUsername()` return `toRemoteUserProfile(match, username)`.

- [x] **Step 6: Implement `updateUserProfile()`**

Add these methods to the object returned by `createNewApiClient()` near `ensureUserGroup()`. `getUserProfile()` is read-only and is used by admin conflict confirmation; it must not return credentials:

```ts
async getUserProfile(input: {
  newapiUserId: string;
  username: string;
}): Promise<RemoteUserProfile> {
  const found = await findUserByUsername(input.username);
  if (!found || found.newapiUserId !== input.newapiUserId) {
    throw new NewApiBridgeError({
      code: 'remote_error',
      message: `New API user profile was not confirmed: ${input.username}`,
    });
  }
  return found;
},
```

Then add `updateUserProfile()`:

```ts
async updateUserProfile(
  input: NewApiUserProfileUpdateInput
): Promise<RemoteUserProfile> {
  const current = input.currentUsername
    ? await findUserByUsername(input.currentUsername)
    : undefined;
  const target = await findUserByUsername(input.username);

  if (target && target.newapiUserId !== input.newapiUserId) {
    throw new NewApiBridgeError({
      code: 'conflict_requires_review',
      message: `New API username belongs to another user: ${input.username}`,
    });
  }

  const remote = current ?? target;
  if (!remote || remote.newapiUserId !== input.newapiUserId) {
    throw new NewApiBridgeError({
      code: 'remote_error',
      message: `New API user not found for profile update: ${input.newapiUserId}`,
    });
  }

  const displayName = input.displayName || input.username;
  try {
    await request('/api/user/', {
      method: 'PUT',
      body: {
        id: toRemoteUserId(input.newapiUserId),
        username: input.username,
        display_name: displayName,
        group: input.group ?? remote.group,
        role: remote.role,
        remark: input.remark ?? remote.remark,
      },
    });
  } catch (error: any) {
    const message = String(error?.message || '');
    if (/\bmax\b/i.test(message) && /username|display/i.test(message)) {
      throw new NewApiBridgeError({
        code: 'newapi_username_too_long',
        message,
        status: error?.status,
      });
    }
    throw error;
  }

  const confirmed = await findUserByUsername(input.username);
  if (!confirmed || confirmed.newapiUserId !== input.newapiUserId) {
    throw new NewApiBridgeError({
      code: 'remote_error',
      message: `New API profile update was not confirmed: ${input.username}`,
    });
  }
  return confirmed;
},
```

Use the exact remote `role` from `remote.role`; do not add `role` to `NewApiUserProfileUpdateInput`.

- [x] **Step 7: Run focused and full client tests**

Run:

```bash
NODE_OPTIONS='--conditions react-server' pnpm exec tsx --test tests/newapi-bridge/client.test.ts --test-name-pattern 'updateUserProfile'
NODE_OPTIONS='--conditions react-server' pnpm exec tsx --test tests/newapi-bridge/client.test.ts
```

Expected: PASS. Existing `ensureUserGroup()` and quota tests remain green.

- [x] **Step 8: Run phase check and record changed files**

Run:

```bash
git diff --check
git status --short
```

Expected: `git diff --check` exits 0. `git status --short` shows the Task 2 files changed. Do not stage or commit unless the user explicitly authorizes it or a later ship workflow requires it.

---

### Task 3: Portal Binding Normalization、状态、审计、注册 Best-Effort、Key 和余额前置阻断

**Files:**
- Modify: `tests/newapi-bridge/portal.test.ts`
- Modify: `tests/newapi-bridge/create-portal-key.test.ts`
- Modify: `src/features/newapi-bridge/server/portal.ts`
- Modify: `src/core/auth/config.ts`

- [x] **Step 1: Write failing tests for email normalization**

In `tests/newapi-bridge/portal.test.ts`, add:

```ts
test('normalizeNewapiUsernameEmail lowercases trims and blocks Phase A long emails', async () => {
  assert.deepEqual(
    modules.portal.normalizeNewapiUsernameEmail(' User@Example.COM '),
    { ok: true, username: 'user@example.com' }
  );
  assert.deepEqual(modules.portal.normalizeNewapiUsernameEmail('   '), {
    ok: false,
    code: 'portal_user_email_missing',
    message: 'Portal user email is missing',
  });
  assert.deepEqual(
    modules.portal.normalizeNewapiUsernameEmail('very-long-user@example.com'),
    {
      ok: false,
      code: 'newapi_username_too_long',
      normalizedEmail: 'very-long-user@example.com',
      message: 'New API username exceeds the Phase A limit',
    }
  );
});
```

- [x] **Step 2: Write failing tests for short-email provision and long-email blocking**

In `tests/newapi-bridge/portal.test.ts`, add:

```ts
test('ensurePortalUserBinding provisions short normalized email usernames without pu hash', async () => {
  const portalUser = await insertUser(
    'portal_user_short_email_binding',
    ' A@B.CO '
  );
  const provisionInputs: any[] = [];
  const fakeRemote = {
    provisionUser: async (input: any) => {
      provisionInputs.push(input);
      return { newapiUserId: 'remote_short_email', accessToken: 'token' };
    },
    ensureUserGroup: async () => {},
  };

  const binding = await modules.portal.ensurePortalUserBinding(
    portalUser,
    fakeRemote
  );

  assert.equal(provisionInputs[0].username, 'a@b.co');
  assert.equal(provisionInputs[0].displayName, 'a@b.co');
  assert.equal(binding.status, 'active');
  assert.equal(binding.newapiUsername, 'a@b.co');
  assert.equal(binding.targetNewapiUsername, 'a@b.co');
  assert.equal(/^pu_/.test(binding.newapiUsername || ''), false);
});

test('ensurePortalUserBinding blocks long emails with audit instead of creating technical usernames', async () => {
  const portalUser = await insertUser(
    'portal_user_long_email_binding',
    'very-long-user@example.com'
  );
  let remoteCalled = false;
  const fakeRemote = {
    provisionUser: async () => {
      remoteCalled = true;
      throw new Error('remote should not be called');
    },
    ensureUserGroup: async () => {},
  };

  await assert.rejects(
    modules.portal.ensurePortalUserBinding(portalUser, fakeRemote),
    /Phase A limit/
  );

  const binding = await modules.portal.getPortalUserBinding(portalUser.id);
  assert.equal(binding.status, 'username_sync_failed');
  assert.equal(binding.targetNewapiUsername, 'very-long-user@example.com');
  assert.equal(binding.lastSyncErrorCode, 'newapi_username_too_long');
  assert.equal(/^pu_/.test(binding.newapiUsername || ''), false);
  assert.equal(remoteCalled, false);
});
```

- [x] **Step 3: Write failing tests for legacy binding username sync**

In `tests/newapi-bridge/portal.test.ts`, add a test that creates an active binding through the public helper, rewrites only `newapiUsername` to a legacy `pu_` value, then calls the helper again:

```ts
test('ensurePortalUserBinding syncs legacy active pu usernames before reuse', async () => {
  const portalUser = await insertUser(
    'portal_user_legacy_binding_sync',
    'a@b.co'
  );
  const updates: any[] = [];
  const fakeRemote = {
    provisionUser: async () => ({
      newapiUserId: '7',
      accessToken: 'token',
    }),
    ensureUserGroup: async () => {},
    updateUserProfile: async (input: any) => {
      updates.push(input);
      return {
        newapiUserId: input.newapiUserId,
        username: input.username,
        displayName: input.displayName,
        group: input.group || '',
        role: 1,
        remark: input.remark || '',
      };
    },
  };

  const first = await modules.portal.ensurePortalUserBinding(
    portalUser,
    fakeRemote
  );
  await modules
    .db()
    .update(modules.newApiUserBinding)
    .set({ newapiUsername: 'pu_legacy_user' })
    .where(eq(modules.newApiUserBinding.id, first.id));

  const synced = await modules.portal.ensurePortalUserBinding(
    portalUser,
    fakeRemote
  );

  assert.equal(updates[0].newapiUserId, '7');
  assert.equal(updates[0].currentUsername, 'pu_legacy_user');
  assert.equal(updates[0].username, 'a@b.co');
  assert.equal(synced.status, 'active');
  assert.equal(synced.newapiUsername, 'a@b.co');
});
```

- [x] **Step 4: Write failing tests for best-effort signup provision**

In `tests/newapi-bridge/portal.test.ts`, add:

```ts
test('provisionPortalUserAfterSignup records failures without throwing to auth', async () => {
  const portalUser = await insertUser(
    'portal_user_signup_long_email',
    'very-long-user@example.com'
  );
  let remoteCalled = false;

  await modules.portal.provisionPortalUserAfterSignup(portalUser, {
    provisionUser: async () => {
      remoteCalled = true;
      throw new Error('remote should not be called');
    },
    ensureUserGroup: async () => {},
  });

  const binding = await modules.portal.getPortalUserBinding(portalUser.id);
  assert.equal(binding.status, 'username_sync_failed');
  assert.equal(binding.lastSyncAction, 'signup_provision');
  assert.equal(binding.lastSyncErrorCode, 'newapi_username_too_long');
  assert.equal(remoteCalled, false);
});
```

- [x] **Step 5: Write failing Key/ledger precondition tests**

In `tests/newapi-bridge/create-portal-key.test.ts`, add:

```ts
test('createPortalApiKey blocks Phase A long emails before remote key creation', async () => {
  const portalUser = await insertUser(
    'create_key_long_email_user',
    'very-long-user@example.com'
  );
  const remote = createRecordingRemoteClient();

  await assert.rejects(
    modules.portal.createPortalApiKey(
      portalUser,
      { name: 'Long email key', groupSlug: 'official' },
      remote.client
    ),
    /Phase A limit/
  );

  assert.equal(remote.getProvisionUserInputs().length, 0);
  assert.equal(remote.getCreateKeyInputs().length, 0);
});
```

In `tests/newapi-bridge/portal.test.ts`, add:

```ts
test('adjustPortalQuota does not create applied ledger entries when binding cannot become active', async () => {
  const portalUser = await insertUser(
    'portal_user_long_email_quota',
    'very-long-user@example.com'
  );
  const operator = await insertUser('operator_long_email_quota', 'ops@b.co');

  await assert.rejects(
    modules.portal.adjustPortalQuota({
      portalUser,
      operatorUserId: operator.id,
      amountUsd: 10,
      reason: 'long email blocked',
      idempotencyKey: 'long-email-quota-blocked',
      client: createSuccessfulRemoteClient(),
    }),
    /Phase A limit/
  );

  const rows = await modules.portal.listAdjustmentLedgerByPortalUser(
    portalUser.id
  );
  assert.equal(rows.some((row: any) => row.status === 'applied'), false);
});
```

- [x] **Step 6: Run tests and verify they fail**

Run:

```bash
NODE_OPTIONS='--conditions react-server' pnpm exec tsx --test tests/newapi-bridge/portal.test.ts --test-name-pattern 'normalizeNewapiUsernameEmail|short normalized email|long emails|legacy active pu|provisionPortalUserAfterSignup|adjustPortalQuota does not create applied'
NODE_OPTIONS='--conditions react-server' pnpm exec tsx --test tests/newapi-bridge/create-portal-key.test.ts --test-name-pattern 'blocks Phase A long emails'
```

Expected: FAIL because helper functions, status fields and long-email blocking are not implemented.

- [x] **Step 7: Implement normalization and binding state helpers**

In `src/features/newapi-bridge/server/portal.ts`, add:

```ts
const NEWAPI_USERNAME_PHASE_A_MAX_LENGTH = 20;

type NewapiUsernameEmailDiagnosis =
  | { ok: true; username: string }
  | {
      ok: false;
      code: 'portal_user_email_missing' | 'newapi_username_too_long';
      normalizedEmail?: string;
      message: string;
    };

export function normalizeNewapiUsernameEmail(
  email: string | null | undefined
): NewapiUsernameEmailDiagnosis {
  const normalizedEmail = String(email || '').trim().toLowerCase();
  if (!normalizedEmail) {
    return {
      ok: false,
      code: 'portal_user_email_missing',
      message: 'Portal user email is missing',
    };
  }
  if (normalizedEmail.length > NEWAPI_USERNAME_PHASE_A_MAX_LENGTH) {
    return {
      ok: false,
      code: 'newapi_username_too_long',
      normalizedEmail,
      message: 'New API username exceeds the Phase A limit',
    };
  }
  return { ok: true, username: normalizedEmail };
}
```

Add a helper that upserts failed binding rows without remote calls:

```ts
async function recordUsernameSyncBlocked(input: {
  portalUserId: string;
  targetNewapiUsername?: string;
  code: 'portal_user_email_missing' | 'newapi_username_too_long';
  message: string;
  action: string;
  idempotencyKey: string;
}) {
  const existing = await getPortalUserBinding(input.portalUserId);
  const values = {
    status: 'username_sync_failed',
    targetNewapiUsername: input.targetNewapiUsername,
    lastSyncErrorCode: input.code,
    lastSyncError: input.message,
    lastSyncAction: input.action,
    lastSyncAttemptedAt: new Date(),
  };
  const [row] = existing
    ? await db()
        .update(newApiUserBinding)
        .set(values)
        .where(eq(newApiUserBinding.id, existing.id))
        .returning()
    : await db()
        .insert(newApiUserBinding)
        .values({
          id: getUuid(),
          portalUserId: input.portalUserId,
          newapiUserId: `pending:${getUuid()}`,
          ...values,
        })
        .returning();

  await recordAudit({
    portalUserId: input.portalUserId,
    action: 'newapi.user.username_sync',
    targetType: 'newapi_user',
    status: 'failed',
    idempotencyKey: input.idempotencyKey,
    requestBody: { targetNewapiUsername: input.targetNewapiUsername },
    errorMessage: input.message,
  });

  return row;
}
```

- [x] **Step 8: Replace `deriveNewapiUsername()` use in `ensurePortalUserBinding()`**

In `ensurePortalUserBinding()`:

```ts
const diagnosis = normalizeNewapiUsernameEmail(user.email);
if (!diagnosis.ok) {
  await recordUsernameSyncBlocked({
    portalUserId: user.id,
    targetNewapiUsername: diagnosis.normalizedEmail,
    code: diagnosis.code,
    message: diagnosis.message,
    action: 'lazy_provision',
    idempotencyKey: `portal-user:${user.id}:username-sync`,
  });
  throw new NewApiBridgeError({
    code: diagnosis.code,
    message: diagnosis.message,
  });
}
const username = diagnosis.username;
```

For existing active binding:

```ts
if (existing && existing.status === 'active' && existing.newapiAccessTokenEnc) {
  if (existing.newapiUsername !== username) {
    await db()
      .update(newApiUserBinding)
      .set({
        status: 'username_sync_pending',
        targetNewapiUsername: username,
        lastSyncAction: 'lazy_provision',
        lastSyncAttemptedAt: new Date(),
      })
      .where(eq(newApiUserBinding.id, existing.id));

    try {
      const remote = await client.updateUserProfile({
        newapiUserId: existing.newapiUserId,
        currentUsername: existing.newapiUsername || undefined,
        username,
        displayName: username,
        group: options.requiredNewapiGroup,
        remark: `apipool:portalUserId:${user.id}`,
      });
      const [synced] = await db()
        .update(newApiUserBinding)
        .set({
          status: 'active',
          newapiUsername: remote.username,
          targetNewapiUsername: username,
          lastSyncErrorCode: null,
          lastSyncError: null,
          lastSyncAction: 'lazy_provision',
          lastSyncedAt: new Date(),
        })
        .where(eq(newApiUserBinding.id, existing.id))
        .returning();
      return synced;
    } catch (error: any) {
      const status =
        error?.code === 'conflict_requires_review'
          ? 'conflict_requires_review'
          : 'username_sync_failed';
      const [failed] = await db()
        .update(newApiUserBinding)
        .set({
          status,
          targetNewapiUsername: username,
          lastSyncErrorCode: error?.code || 'remote_error',
          lastSyncError: error?.message || 'New API username sync failed',
          lastSyncAction: 'lazy_provision',
          lastSyncAttemptedAt: new Date(),
        })
        .where(eq(newApiUserBinding.id, existing.id))
        .returning();
      await recordAudit({
        portalUserId: user.id,
        action: 'newapi.user.username_sync',
        targetType: 'newapi_user',
        targetId: existing.newapiUserId,
        status: 'failed',
        idempotencyKey: `portal-user:${user.id}:username-sync`,
        requestBody: { targetNewapiUsername: username },
        errorMessage: error?.message || 'New API username sync failed',
      });
      throw new NewApiBridgeError({
        code: error?.code || 'remote_error',
        message: failed.lastSyncError || 'New API username sync failed',
      });
    }
  }
  if (options.requiredNewapiGroup) {
    await client.ensureUserGroup({
      newapiUserId: existing.newapiUserId,
      username,
      group: options.requiredNewapiGroup,
    });
  }
  return existing;
}
```

When inserting/updating pending rows for provision, set `status: 'provisioning'`, `newapiUsername: username`, `targetNewapiUsername: username`, `lastSyncAction`, and `lastSyncAttemptedAt`.

- [x] **Step 9: Update provision success/failure persistence**

On successful `client.provisionUser()`, set:

```ts
{
  newapiUserId: remote.newapiUserId,
  newapiAccessTokenEnc: encryptCredential(remote.accessToken),
  status: 'active',
  newapiUsername: username,
  targetNewapiUsername: username,
  lastSyncErrorCode: null,
  lastSyncError: null,
  lastSyncAction: options.requiredNewapiGroup ? 'lazy_provision' : 'signup_provision',
  lastSyncedAt: new Date(),
}
```

On failure, update the binding row:

```ts
{
  status:
    error?.code === 'conflict_requires_review'
      ? 'conflict_requires_review'
      : 'username_sync_failed',
  targetNewapiUsername: username,
  lastSyncErrorCode: error?.code || 'remote_error',
  lastSyncError: error?.message || 'New API user provision failed',
  lastSyncAction: 'lazy_provision',
  lastSyncAttemptedAt: new Date(),
}
```

Keep `recordAudit()` request/response bodies free of passwords and access tokens.

- [x] **Step 10: Implement signup helper and hook**

In `src/features/newapi-bridge/server/portal.ts`:

```ts
export async function provisionPortalUserAfterSignup(
  user: Pick<User, 'id' | 'email'>,
  client: NewApiClient = createNewApiClient()
): Promise<void> {
  const diagnosis = normalizeNewapiUsernameEmail(user.email);
  if (!diagnosis.ok) {
    await recordUsernameSyncBlocked({
      portalUserId: user.id,
      targetNewapiUsername: diagnosis.normalizedEmail,
      code: diagnosis.code,
      message: diagnosis.message,
      action: 'signup_provision',
      idempotencyKey: `portal-user:${user.id}:signup-provision`,
    });
    return;
  }

  try {
    await ensurePortalUserBinding(user, client);
  } catch {
    // ensurePortalUserBinding already writes status and audit.
  }
}
```

In `src/core/auth/config.ts`, import it:

```ts
import { provisionPortalUserAfterSignup } from '@/features/newapi-bridge/server/portal';
```

Then call it inside `databaseHooks.user.create.after` after credit/role grants:

```ts
try {
  await provisionPortalUserAfterSignup(user);
} catch (e) {
  console.log('provision New API user after signup failed', e);
}
```

This catch is still best-effort, but the helper records binding state and audit before returning or throwing.

- [x] **Step 11: Run focused tests**

Run:

```bash
NODE_OPTIONS='--conditions react-server' pnpm exec tsx --test tests/newapi-bridge/portal.test.ts --test-name-pattern 'normalizeNewapiUsernameEmail|short normalized email|long emails|legacy active pu|provisionPortalUserAfterSignup|adjustPortalQuota does not create applied'
NODE_OPTIONS='--conditions react-server' pnpm exec tsx --test tests/newapi-bridge/create-portal-key.test.ts --test-name-pattern 'blocks Phase A long emails'
```

Expected: PASS. No remote calls are made for long-email users.

- [x] **Step 12: Run bridge regression tests**

Run:

```bash
NODE_OPTIONS='--conditions react-server' pnpm exec tsx --test tests/newapi-bridge/client.test.ts tests/newapi-bridge/portal.test.ts tests/newapi-bridge/create-portal-key.test.ts
```

Expected: PASS. Existing usage snapshot, ledger, API Key lifecycle and DTO tests remain green.

- [x] **Step 13: Run phase check and record changed files**

Run:

```bash
git diff --check
git status --short
```

Expected: `git diff --check` exits 0. `git status --short` shows the Task 3 files changed. Do not stage or commit unless the user explicitly authorizes it or a later ship workflow requires it.

---

### Task 4: 邮箱变更 Helper 和后台 Admin Actions

**Files:**
- Modify: `tests/newapi-bridge/portal.test.ts`
- Create: `tests/newapi-bridge/admin-user-binding-actions.test.ts`
- Modify: `src/features/newapi-bridge/server/portal.ts`
- Create: `src/features/newapi-bridge/server/admin-user-binding-actions.ts`

- [x] **Step 1: Write failing tests for controlled email changes**

In `tests/newapi-bridge/portal.test.ts`, add:

```ts
test('updatePortalUserEmailWithNewapiSync updates local email only after remote username succeeds', async () => {
  const portalUser = await insertUser('portal_user_email_change_short', 'a@b.co');
  const operator = await insertUser('operator_email_change_short', 'ops@b.co');
  const updates: any[] = [];
  const fakeRemote = {
    provisionUser: async () => ({ newapiUserId: '7', accessToken: 'token' }),
    ensureUserGroup: async () => {},
    updateUserProfile: async (input: any) => {
      updates.push(input);
      return {
        newapiUserId: input.newapiUserId,
        username: input.username,
        displayName: input.displayName,
        group: input.group || '',
        role: 1,
        remark: input.remark || '',
      };
    },
  };
  await modules.portal.ensurePortalUserBinding(portalUser, fakeRemote);

  const result = await modules.portal.updatePortalUserEmailWithNewapiSync({
    portalUserId: portalUser.id,
    newEmail: ' C@D.CO ',
    operatorUserId: operator.id,
    client: fakeRemote,
  });

  const updated = await modules.db().query.user.findFirst({
    where: eq(modules.user.id, portalUser.id),
  });
  const binding = await modules.portal.getPortalUserBinding(portalUser.id);

  assert.equal(result.status, 'active');
  assert.equal(updates[0].username, 'c@d.co');
  assert.equal(updated.email, 'c@d.co');
  assert.equal(binding.newapiUsername, 'c@d.co');
  assert.equal(binding.lastSyncAction, 'email_change');
});

test('updatePortalUserEmailWithNewapiSync blocks long emails without committing local email', async () => {
  const portalUser = await insertUser('portal_user_email_change_long', 'a@b.co');
  const operator = await insertUser('operator_email_change_long', 'ops2@b.co');

  const result = await modules.portal.updatePortalUserEmailWithNewapiSync({
    portalUserId: portalUser.id,
    newEmail: 'very-long-user@example.com',
    operatorUserId: operator.id,
    client: createSuccessfulRemoteClient(),
  });

  const updated = await modules.db().query.user.findFirst({
    where: eq(modules.user.id, portalUser.id),
  });
  const binding = await modules.portal.getPortalUserBinding(portalUser.id);

  assert.equal(result.status, 'username_sync_failed');
  assert.equal(updated.email, 'a@b.co');
  assert.equal(binding.targetNewapiUsername, 'very-long-user@example.com');
  assert.equal(binding.lastSyncErrorCode, 'newapi_username_too_long');
});

test('updatePortalUserEmailWithNewapiSync records local_commit_failed when remote update succeeds but local transaction fails', async () => {
  const portalUser = await insertUser(
    'portal_user_email_change_local_fail',
    'a@b.co'
  );
  const operator = await insertUser(
    'operator_email_change_local_fail',
    'ops3@b.co'
  );
  await insertUser('portal_user_email_change_conflicting_email', 'c@d.co');
  const updates: any[] = [];
  const fakeRemote = {
    provisionUser: async () => ({ newapiUserId: '9', accessToken: 'token' }),
    ensureUserGroup: async () => {},
    updateUserProfile: async (input: any) => {
      updates.push(input);
      return {
        newapiUserId: input.newapiUserId,
        username: input.username,
        displayName: input.displayName,
        group: input.group || '',
        role: 1,
        remark: input.remark || '',
      };
    },
  };
  await modules.portal.ensurePortalUserBinding(portalUser, fakeRemote);

  const result = await modules.portal.updatePortalUserEmailWithNewapiSync({
    portalUserId: portalUser.id,
    newEmail: 'c@d.co',
    operatorUserId: operator.id,
    client: fakeRemote,
  });

  const updated = await modules.db().query.user.findFirst({
    where: eq(modules.user.id, portalUser.id),
  });
  const binding = await modules.portal.getPortalUserBinding(portalUser.id);
  const audits = await modules
    .db()
    .select()
    .from(modules.newApiBridgeAuditLog)
    .where(eq(modules.newApiBridgeAuditLog.portalUserId, portalUser.id));

  assert.equal(updates.length, 1);
  assert.equal(result.status, 'username_sync_failed');
  assert.equal(updated.email, 'a@b.co');
  assert.equal(binding.status, 'username_sync_failed');
  assert.equal(binding.targetNewapiUsername, 'c@d.co');
  assert.equal(binding.lastSyncErrorCode, 'local_commit_failed');
  assert.match(binding.lastSyncError || '', /remote username may already be updated/i);
  assert.equal(
    audits.some(
      (row: any) =>
        row.action === 'newapi.user.username_sync' &&
        row.status === 'failed' &&
        /local_commit_failed/.test(row.errorMessage || '')
    ),
    true
  );
});
```

- [x] **Step 2: Write failing tests for admin action behavior**

Create `tests/newapi-bridge/admin-user-binding-actions.test.ts` with a minimal DB setup copied from `portal.test.ts`, then add:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';

test('disableNewapiUserBindingForAdmin stores disabled state and redacted audit', async () => {
  const portalUser = await insertUser('portal_user_admin_disable', 'a@b.co');
  await modules.portal.ensurePortalUserBinding(portalUser, createSuccessfulRemoteClient());

  const result = await modules.portal.disableNewapiUserBindingForAdmin({
    portalUserId: portalUser.id,
    reason: 'security review',
  });

  const binding = await modules.portal.getPortalUserBinding(portalUser.id);
  assert.equal(result.status, 'disabled');
  assert.equal(binding.status, 'disabled');
  assert.equal(Object.hasOwn(result, 'newapiUserId'), false);
  assert.equal(Object.hasOwn(result, 'newapiAccessTokenEnc'), false);
});

test('confirmNewapiUserConflictForAdmin refuses a remote user already bound to another portal user', async () => {
  const first = await insertUser('portal_user_conflict_owner', 'a@b.co');
  const second = await insertUser('portal_user_conflict_candidate', 'c@d.co');
  await modules.db().insert(modules.newApiUserBinding).values({
    id: 'binding_conflict_owner',
    portalUserId: first.id,
    newapiUserId: 'remote_42',
    status: 'active',
    newapiUsername: 'a@b.co',
    targetNewapiUsername: 'a@b.co',
  });
  await modules.db().insert(modules.newApiUserBinding).values({
    id: 'binding_conflict_candidate',
    portalUserId: second.id,
    newapiUserId: 'pending:conflict',
    status: 'conflict_requires_review',
    targetNewapiUsername: 'c@d.co',
    conflictNewapiUserId: 'remote_42',
  });

  await assert.rejects(
    modules.portal.confirmNewapiUserConflictForAdmin({
      portalUserId: second.id,
      newapiUserId: 'remote_42',
    }),
    /already bound/
  );
});

test('confirmNewapiUserConflictForAdmin activates a reviewed conflict and writes audit', async () => {
  const portalUser = await insertUser(
    'portal_user_conflict_confirm_success',
    'c@d.co'
  );
  await modules.db().insert(modules.newApiUserBinding).values({
    id: 'binding_conflict_confirm_success',
    portalUserId: portalUser.id,
    newapiUserId: 'pending:conflict-confirm',
    status: 'conflict_requires_review',
    targetNewapiUsername: 'c@d.co',
    lastSyncErrorCode: 'conflict_requires_review',
    lastSyncError: 'Remote username requires admin review',
    conflictNewapiUserId: 'remote_42',
  });
  const profileReads: any[] = [];
  const fakeRemote = {
    getUserProfile: async (input: any) => {
      profileReads.push(input);
      return {
        newapiUserId: 'remote_42',
        username: 'c@d.co',
        displayName: 'c@d.co',
        group: 'ng-official',
        role: 1,
        remark: 'apipool:portalUserId:portal_user_conflict_confirm_success',
      };
    },
  };

  const result = await modules.portal.confirmNewapiUserConflictForAdmin({
    portalUserId: portalUser.id,
    newapiUserId: 'remote_42',
    client: fakeRemote,
  });

  const binding = await modules.portal.getPortalUserBinding(portalUser.id);
  const audits = await modules
    .db()
    .select()
    .from(modules.newApiBridgeAuditLog)
    .where(eq(modules.newApiBridgeAuditLog.portalUserId, portalUser.id));

  assert.deepEqual(profileReads[0], {
    newapiUserId: 'remote_42',
    username: 'c@d.co',
  });
  assert.equal(result.status, 'active');
  assert.equal(Object.hasOwn(result, 'newapiAccessTokenEnc'), false);
  assert.equal(binding.status, 'active');
  assert.equal(binding.newapiUserId, 'remote_42');
  assert.equal(binding.newapiUsername, 'c@d.co');
  assert.equal(binding.targetNewapiUsername, 'c@d.co');
  assert.equal(binding.lastSyncErrorCode, null);
  assert.equal(binding.lastSyncError, null);
  assert.equal(binding.conflictNewapiUserId, null);
  assert.equal(
    audits.some(
      (row: any) =>
        row.action === 'newapi.user.conflict_confirm' &&
        row.status === 'success'
    ),
    true
  );
});
```

- [x] **Step 3: Run tests and verify they fail**

Run:

```bash
NODE_OPTIONS='--conditions react-server' pnpm exec tsx --test tests/newapi-bridge/portal.test.ts --test-name-pattern 'updatePortalUserEmailWithNewapiSync'
NODE_OPTIONS='--conditions react-server' pnpm exec tsx --test tests/newapi-bridge/admin-user-binding-actions.test.ts
```

Expected: FAIL because the email helper and admin binding actions do not exist.

- [x] **Step 4: Keep generic user email writes closed**

Do not add a generic `updateUserEmailUnsafeAfterNewapiSync()` helper. `src/shared/models/user.ts` must keep `UpdateUser = Partial<Omit<NewUser, 'id' | 'createdAt' | 'email'>>`, and the existing admin edit page must continue to show email as disabled. The only local email write in this feature is the inline `tx.update(userTable).set({ email: diagnosis.username })` inside `updatePortalUserEmailWithNewapiSync()` after remote `updateUserProfile()` succeeds and is confirmed.

```ts
// src/shared/models/user.ts remains intentionally email-closed:
export type UpdateUser = Partial<Omit<NewUser, 'id' | 'createdAt' | 'email'>>;
```

Expected: no new shared model helper exists that can update email outside the New API sync transaction.

- [x] **Step 5: Implement `updatePortalUserEmailWithNewapiSync()`**

In `src/features/newapi-bridge/server/portal.ts`, import `findUserById` and the `user` table as `userTable`. First refactor `recordAudit()` so it can write through the current transaction:

```ts
async function recordAudit(
  input: AuditInput,
  writer: ReturnType<typeof db> = db()
) {
  await writer.insert(newApiBridgeAuditLog).values({
    id: getUuid(),
    portalUserId: input.portalUserId,
    operatorUserId: input.operatorUserId,
    action: input.action,
    targetType: input.targetType,
    targetId: input.targetId,
    status: input.status,
    idempotencyKey: input.idempotencyKey,
    requestBody: input.requestBody
      ? JSON.stringify(sanitizeAuditBody(input.requestBody))
      : null,
    responseBody: input.responseBody
      ? JSON.stringify(sanitizeAuditBody(input.responseBody))
      : null,
    errorMessage: input.errorMessage,
  });
}
```

Then add:

```ts
export async function updatePortalUserEmailWithNewapiSync(input: {
  portalUserId: string;
  newEmail: string;
  operatorUserId: string;
  client?: NewApiClient;
}): Promise<{
  status: 'active' | 'username_sync_failed' | 'conflict_requires_review';
}> {
  const portalUser = await findUserById(input.portalUserId);
  if (!portalUser) throw new Error('portal user not found');

  const diagnosis = normalizeNewapiUsernameEmail(input.newEmail);
  if (!diagnosis.ok) {
    await recordUsernameSyncBlocked({
      portalUserId: input.portalUserId,
      targetNewapiUsername: diagnosis.normalizedEmail,
      code: diagnosis.code,
      message: diagnosis.message,
      action: 'email_change',
      idempotencyKey: `portal-user:${input.portalUserId}:email-change`,
    });
    return { status: 'username_sync_failed' };
  }

  const client = input.client || createNewApiClient();
  const binding = await ensurePortalUserBinding(portalUser, client);
  await db()
    .update(newApiUserBinding)
    .set({
      status: 'username_sync_pending',
      targetNewapiUsername: diagnosis.username,
      lastSyncAction: 'email_change',
      lastSyncAttemptedAt: new Date(),
    })
    .where(eq(newApiUserBinding.id, binding.id));

  try {
    const remote = await client.updateUserProfile({
      newapiUserId: binding.newapiUserId,
      currentUsername: binding.newapiUsername || undefined,
      username: diagnosis.username,
      displayName: diagnosis.username,
      remark: `apipool:portalUserId:${input.portalUserId}`,
    });

    try {
      await db().transaction(async (tx) => {
        await tx
          .update(userTable)
          .set({ email: diagnosis.username })
          .where(eq(userTable.id, input.portalUserId));

        await tx
          .update(newApiUserBinding)
          .set({
            status: 'active',
            newapiUserId: remote.newapiUserId,
            newapiUsername: remote.username,
            targetNewapiUsername: diagnosis.username,
            lastSyncErrorCode: null,
            lastSyncError: null,
            lastSyncAction: 'email_change',
            lastSyncedAt: new Date(),
            lastSyncAttemptedAt: new Date(),
            conflictNewapiUserId: null,
          })
          .where(eq(newApiUserBinding.id, binding.id));

        await recordAudit(
          {
            portalUserId: input.portalUserId,
            operatorUserId: input.operatorUserId,
            action: 'newapi.user.username_sync',
            targetType: 'newapi_user',
            targetId: binding.newapiUserId,
            status: 'success',
            idempotencyKey: `portal-user:${input.portalUserId}:email-change`,
            requestBody: {
              previousEmail: portalUser.email,
              newEmail: diagnosis.username,
            },
            responseBody: {
              username: remote.username,
              displayName: remote.displayName,
              group: remote.group,
              role: remote.role,
              remark: remote.remark,
            },
          },
          tx
        );
      });
    } catch (localError: any) {
      const message =
        'local_commit_failed: remote username may already be updated; local email/binding commit requires admin compensation';
      await db()
        .update(newApiUserBinding)
        .set({
          status: 'username_sync_failed',
          targetNewapiUsername: diagnosis.username,
          lastSyncErrorCode: 'local_commit_failed',
          lastSyncError: message,
          lastSyncAction: 'email_change',
          lastSyncAttemptedAt: new Date(),
        })
        .where(eq(newApiUserBinding.id, binding.id));
      await recordAudit({
        portalUserId: input.portalUserId,
        operatorUserId: input.operatorUserId,
        action: 'newapi.user.username_sync',
        targetType: 'newapi_user',
        targetId: binding.newapiUserId,
        status: 'failed',
        idempotencyKey: `portal-user:${input.portalUserId}:email-change`,
        requestBody: {
          previousEmail: portalUser.email,
          newEmail: diagnosis.username,
        },
        responseBody: { remoteUpdatedUsername: remote.username },
        errorMessage: `${message}: ${localError?.message || 'local commit failed'}`,
      });
      return { status: 'username_sync_failed' };
    }
    return { status: 'active' };
  } catch (error: any) {
    const status =
      error?.code === 'conflict_requires_review'
        ? 'conflict_requires_review'
        : 'username_sync_failed';
    await db()
      .update(newApiUserBinding)
      .set({
        status,
        targetNewapiUsername: diagnosis.username,
        lastSyncErrorCode: error?.code || 'remote_error',
        lastSyncError: error?.message || 'New API username sync failed',
        lastSyncAction: 'email_change',
        lastSyncAttemptedAt: new Date(),
      })
      .where(eq(newApiUserBinding.id, binding.id));
    await recordAudit({
      portalUserId: input.portalUserId,
      operatorUserId: input.operatorUserId,
      action: 'newapi.user.username_sync',
      targetType: 'newapi_user',
      targetId: binding.newapiUserId,
      status: 'failed',
      idempotencyKey: `portal-user:${input.portalUserId}:email-change`,
      requestBody: { targetNewapiUsername: diagnosis.username },
      errorMessage: error?.message || 'New API username sync failed',
    });
    return { status };
  }
}
```

- [x] **Step 6: Implement pure admin helpers and server actions**

Create `src/features/newapi-bridge/server/admin-user-binding-actions.ts`:

```ts
'use server';

import { PERMISSIONS, requirePermission } from '@/core/rbac';
import { getUserInfo } from '@/shared/models/user';
import {
  confirmNewapiUserConflictForAdmin,
  disableNewapiUserBindingForAdmin,
  retryNewapiUserBindingForAdmin,
} from './portal';

async function getCurrentAdminUser() {
  const currentUser = await getUserInfo();
  if (!currentUser?.id) {
    throw new Error('admin user session required');
  }
  return currentUser;
}

export async function retryNewapiUserBindingAction(input: {
  portalUserId: string;
}) {
  await requirePermission({ code: PERMISSIONS.USERS_WRITE });
  const currentUser = await getCurrentAdminUser();
  return retryNewapiUserBindingForAdmin({
    ...input,
    operatorUserId: currentUser.id,
  });
}

export async function confirmNewapiUserConflictAction(input: {
  portalUserId: string;
  newapiUserId: string;
}) {
  await requirePermission({ code: PERMISSIONS.USERS_WRITE });
  const currentUser = await getCurrentAdminUser();
  return confirmNewapiUserConflictForAdmin({
    ...input,
    operatorUserId: currentUser.id,
  });
}

export async function disableNewapiUserBindingAction(input: {
  portalUserId: string;
  reason: string;
}) {
  await requirePermission({ code: PERMISSIONS.USERS_WRITE });
  const currentUser = await getCurrentAdminUser();
  return disableNewapiUserBindingForAdmin({
    ...input,
    operatorUserId: currentUser.id,
  });
}
```

In `portal.ts`, implement pure helpers:

```ts
export async function retryNewapiUserBindingForAdmin(input: {
  portalUserId: string;
  operatorUserId?: string;
  client?: NewApiClient;
}) {
  const portalUser = await findUserById(input.portalUserId);
  if (!portalUser) throw new Error('portal user not found');
  const binding = await ensurePortalUserBinding(
    portalUser,
    input.client || createNewApiClient()
  );
  return toAdminBindingDto(binding);
}

export async function disableNewapiUserBindingForAdmin(input: {
  portalUserId: string;
  reason: string;
  operatorUserId?: string;
}) {
  const existing = await getPortalUserBinding(input.portalUserId);
  if (!existing) throw new Error('New API user binding not found');
  const [binding] = await db()
    .update(newApiUserBinding)
    .set({
      status: 'disabled',
      lastSyncAction: 'admin_disable',
      lastSyncError: input.reason,
    })
    .where(eq(newApiUserBinding.id, existing.id))
    .returning();
  await recordAudit({
    portalUserId: input.portalUserId,
    operatorUserId: input.operatorUserId,
    action: 'newapi.user.binding_disable',
    targetType: 'newapi_user',
    targetId: existing.newapiUserId,
    status: 'success',
    requestBody: { reason: input.reason },
  });
  return toAdminBindingDto(binding);
}
```

Add the full positive `confirmNewapiUserConflictForAdmin()` flow. It must verify the local conflict state before reading remote data, confirm the remote user through the client, write active binding, clear error/conflict fields, write `newapi.user.conflict_confirm` audit, and return only the admin-safe DTO:

```ts
export async function confirmNewapiUserConflictForAdmin(input: {
  portalUserId: string;
  newapiUserId: string;
  operatorUserId?: string;
  client?: Pick<NewApiClient, 'getUserProfile'>;
}) {
  const existing = await getPortalUserBinding(input.portalUserId);
  if (!existing) throw new Error('New API user binding not found');
  if (existing.status !== 'conflict_requires_review') {
    throw new Error('New API user binding is not waiting for conflict review');
  }
  if (existing.conflictNewapiUserId !== input.newapiUserId) {
    throw new Error('New API conflict candidate does not match this binding');
  }
  if (!existing.targetNewapiUsername) {
    throw new Error('New API conflict target username is missing');
  }

  const [owner] = await db()
    .select({
      id: newApiUserBinding.id,
      portalUserId: newApiUserBinding.portalUserId,
    })
    .from(newApiUserBinding)
    .where(eq(newApiUserBinding.newapiUserId, input.newapiUserId))
    .limit(1);
  if (owner && owner.portalUserId !== input.portalUserId) {
    throw new Error('New API user is already bound to another portal user');
  }

  const client = input.client || createNewApiClient();
  const remote = await client.getUserProfile({
    newapiUserId: input.newapiUserId,
    username: existing.targetNewapiUsername,
  });

  let activeBinding: typeof newApiUserBinding.$inferSelect | undefined;
  await db().transaction(async (tx) => {
    const [updated] = await tx
      .update(newApiUserBinding)
      .set({
        newapiUserId: remote.newapiUserId,
        status: 'active',
        newapiUsername: remote.username,
        targetNewapiUsername: remote.username,
        lastSyncErrorCode: null,
        lastSyncError: null,
        lastSyncAction: 'admin_confirm_conflict',
        lastSyncedAt: new Date(),
        lastSyncAttemptedAt: new Date(),
        conflictNewapiUserId: null,
      })
      .where(eq(newApiUserBinding.id, existing.id))
      .returning();
    activeBinding = updated;

    await recordAudit(
      {
        portalUserId: input.portalUserId,
        operatorUserId: input.operatorUserId,
        action: 'newapi.user.conflict_confirm',
        targetType: 'newapi_user',
        targetId: remote.newapiUserId,
        status: 'success',
        idempotencyKey: `portal-user:${input.portalUserId}:conflict-confirm:${remote.newapiUserId}`,
        requestBody: {
          targetNewapiUsername: existing.targetNewapiUsername,
          conflictNewapiUserId: input.newapiUserId,
        },
        responseBody: {
          username: remote.username,
          displayName: remote.displayName,
          group: remote.group,
          role: remote.role,
          remark: remote.remark,
        },
      },
      tx
    );
  });

  if (!activeBinding) throw new Error('New API conflict confirmation failed');
  return toAdminBindingDto(activeBinding);
}
```

Return `toAdminBindingDto(binding)` only; do not return encrypted credentials.

- [x] **Step 7: Add admin binding DTO helper**

In `portal.ts`, add:

```ts
export function toAdminBindingDto(binding: typeof newApiUserBinding.$inferSelect) {
  return {
    portalUserId: binding.portalUserId,
    status: binding.status,
    newapiUsername: binding.newapiUsername,
    targetNewapiUsername: binding.targetNewapiUsername,
    lastSyncErrorCode: binding.lastSyncErrorCode,
    lastSyncError: binding.lastSyncError,
    lastSyncAction: binding.lastSyncAction,
    lastSyncAttemptedAt: binding.lastSyncAttemptedAt,
    lastSyncedAt: binding.lastSyncedAt,
    conflictNewapiUserId: binding.conflictNewapiUserId,
  };
}
```

Use this DTO only in admin pages/actions. User-facing code must not call it.

- [x] **Step 8: Run focused tests**

Run:

```bash
NODE_OPTIONS='--conditions react-server' pnpm exec tsx --test tests/newapi-bridge/portal.test.ts --test-name-pattern 'updatePortalUserEmailWithNewapiSync'
NODE_OPTIONS='--conditions react-server' pnpm exec tsx --test tests/newapi-bridge/admin-user-binding-actions.test.ts
```

Expected: PASS. Short email changes update local email after remote success; long emails keep local email unchanged.

- [x] **Step 9: Run phase check and record changed files**

Run:

```bash
git diff --check
git status --short
```

Expected: `git diff --check` exits 0. `git status --short` shows the Task 4 files changed. Do not stage or commit unless the user explicitly authorizes it or a later ship workflow requires it.

---

### Task 5: 后台用户列表/详情最小闭环与 DTO 去敏

**Files:**
- Modify: `src/app/[locale]/(admin)/admin/users/page.tsx`
- Modify: `src/app/[locale]/(admin)/admin/users/[id]/detail/page.tsx`
- Modify: `src/config/locale/messages/zh/admin/users.json`
- Modify: `src/config/locale/messages/en/admin/users.json`
- Modify: `src/shared/models/user.ts`
- Modify: `tests/newapi-bridge/portal.test.ts`
- Create/Modify: `tests/newapi-bridge/admin-user-detail.test.ts`

- [x] **Step 1: Write failing tests for admin list filtering data access**

In `tests/newapi-bridge/portal.test.ts`, add:

```ts
test('getUsers can filter by New API binding status and sync error without exposing credentials', async () => {
  const userA = await insertUser('portal_user_filter_status', 'a@b.co');
  const userB = await insertUser('portal_user_filter_other', 'c@d.co');
  await modules.db().insert(modules.newApiUserBinding).values([
    {
      id: 'binding_filter_status',
      portalUserId: userA.id,
      newapiUserId: 'pending:filter-status',
      status: 'username_sync_failed',
      targetNewapiUsername: 'a@b.co',
      lastSyncErrorCode: 'newapi_username_too_long',
      newapiAccessTokenEnc: 'secret-token',
      newapiPasswordEnc: 'secret-password',
    },
    {
      id: 'binding_filter_other',
      portalUserId: userB.id,
      newapiUserId: 'remote_other',
      status: 'active',
      targetNewapiUsername: 'c@d.co',
    },
  ]);

  const rows = await modules.userModel.getUsers({
    newApiBindingStatus: 'username_sync_failed',
    lastSyncErrorCode: 'newapi_username_too_long',
    limit: 30,
  });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, userA.id);
  assert.equal(rows[0].newApiBinding?.status, 'username_sync_failed');
  assert.equal(rows[0].newApiBinding?.lastSyncErrorCode, 'newapi_username_too_long');
  assert.equal(Object.hasOwn(rows[0].newApiBinding || {}, 'newapiUserId'), false);
  assert.equal(Object.hasOwn(rows[0].newApiBinding || {}, 'newapiAccessTokenEnc'), false);
  assert.equal(Object.hasOwn(rows[0].newApiBinding || {}, 'newapiPasswordEnc'), false);
});
```

Extend `setupPortalDb()` to import `@/shared/models/user` as `userModel`.

- [x] **Step 2: Run the filtering test and verify it fails**

Run:

```bash
NODE_OPTIONS='--conditions react-server' pnpm exec tsx --test tests/newapi-bridge/portal.test.ts --test-name-pattern 'getUsers can filter by New API binding status'
```

Expected: FAIL because `getUsers()` does not accept `newApiBindingStatus` or return a safe binding DTO.

- [x] **Step 3: Write failing static tests for admin detail UI, actions and locale keys**

Create or update `tests/newapi-bridge/admin-user-detail.test.ts` with static checks. This avoids needing a Server Component render harness while still preventing the Phase A admin loop from being omitted.

```ts
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const detailPagePath =
  'src/app/[locale]/(admin)/admin/users/[id]/detail/page.tsx';
const listPagePath = 'src/app/[locale]/(admin)/admin/users/page.tsx';
const actionPath =
  'src/features/newapi-bridge/server/admin-user-binding-actions.ts';

function getByPath(obj: any, path: string) {
  return path.split('.').reduce((current, key) => current?.[key], obj);
}

test('admin user detail page renders New API binding card and recovery actions', async () => {
  const source = await readFile(detailPagePath, 'utf8');

  assert.match(source, /getPortalUserBinding/);
  assert.match(source, /toAdminBindingDto/);
  assert.match(source, /detail\.binding\.title/);
  assert.match(source, /detail\.binding\.fields\.target_username/);
  assert.match(source, /detail\.binding\.fields\.confirmed_username/);
  assert.match(source, /detail\.binding\.fields\.error_code/);
  assert.match(source, /retryNewapiUserBindingAction/);
  assert.match(source, /confirmNewapiUserConflictAction/);
  assert.match(source, /disableNewapiUserBindingAction/);
  assert.match(source, /conflict_requires_review/);
  assert.doesNotMatch(source, /newapiAccessTokenEnc/);
  assert.doesNotMatch(source, /newapiPasswordEnc/);
});

test('admin user list exposes server-side binding filters and safe columns', async () => {
  const source = await readFile(listPagePath, 'utf8');

  assert.match(source, /newApiBindingStatus/);
  assert.match(source, /lastSyncErrorCode/);
  assert.match(source, /fields\.newapi_binding_status/);
  assert.match(source, /fields\.newapi_sync_error/);
  assert.match(source, /list\.filters\.username_sync_failed/);
  assert.match(source, /list\.filters\.newapi_username_too_long/);
  assert.doesNotMatch(source, /newapiAccessTokenEnc/);
  assert.doesNotMatch(source, /newapiPasswordEnc/);
});

test('admin binding actions are exported with USERS_WRITE permission checks', async () => {
  const source = await readFile(actionPath, 'utf8');

  assert.match(source, /export async function retryNewapiUserBindingAction/);
  assert.match(source, /export async function confirmNewapiUserConflictAction/);
  assert.match(source, /export async function disableNewapiUserBindingAction/);
  assert.match(source, /PERMISSIONS\.USERS_WRITE/);
  assert.match(source, /getUserInfo/);
  assert.match(source, /admin user session required/);
  assert.equal((source.match(/operatorUserId:\s*currentUser\.id/g) || []).length, 3);
  assert.equal((source.match(/await requirePermission/g) || []).length, 3);
});

test('admin users locale files contain all New API binding keys used by pages', async () => {
  const requiredKeys = [
    'fields.newapi_binding_status',
    'fields.newapi_sync_error',
    'list.filters.username_sync_failed',
    'list.filters.conflict_requires_review',
    'list.filters.newapi_username_too_long',
    'detail.errors.binding',
    'detail.binding.title',
    'detail.binding.description',
    'detail.binding.fields.status',
    'detail.binding.fields.target_username',
    'detail.binding.fields.confirmed_username',
    'detail.binding.fields.error_code',
    'detail.binding.fields.last_attempted',
    'detail.binding.fields.last_synced',
    'detail.binding.actions.retry',
    'detail.binding.actions.confirm_conflict',
    'detail.binding.actions.disable',
    'detail.status.binding.pending',
    'detail.status.binding.provisioning',
    'detail.status.binding.active',
    'detail.status.binding.username_sync_pending',
    'detail.status.binding.username_sync_failed',
    'detail.status.binding.conflict_requires_review',
    'detail.status.binding.disabled',
  ];

  for (const locale of ['zh', 'en']) {
    const json = JSON.parse(
      await readFile(
        `src/config/locale/messages/${locale}/admin/users.json`,
        'utf8'
      )
    );
    for (const key of requiredKeys) {
      assert.equal(
        typeof getByPath(json, key),
        'string',
        `${locale} missing ${key}`
      );
      assert.equal(
        getByPath(json, key).includes('admin.users.'),
        false,
        `${locale} ${key} must not be a raw translation key`
      );
    }
  }
});
```

Run:

```bash
NODE_OPTIONS='--conditions react-server' pnpm exec tsx --test tests/newapi-bridge/admin-user-detail.test.ts
```

Expected: FAIL because the detail page, list page, server action exports and locale keys have not been implemented yet.

- [x] **Step 4: Extend user model list/count queries safely**

In `src/shared/models/user.ts`, extend `User`:

```ts
export type UserNewApiBindingSummary = {
  status: string | null;
  targetNewapiUsername: string | null;
  newapiUsername: string | null;
  lastSyncErrorCode: string | null;
  lastSyncAttemptedAt: Date | null;
  lastSyncedAt: Date | null;
};

export type User = typeof user.$inferSelect & {
  isAdmin?: boolean;
  credits?: UserCredits;
  roles?: Role[];
  permissions?: Permission[];
  newApiBinding?: UserNewApiBindingSummary | null;
};
```

Extend `getUsers()` and `getUsersCount()` input types:

```ts
  newApiBindingStatus?: string;
  lastSyncErrorCode?: string;
```

Use a left join to `newApiUserBinding` and return only safe fields:

```ts
const conditions = [
  email ? eq(user.email, email) : undefined,
  newApiBindingStatus
    ? eq(newApiUserBinding.status, newApiBindingStatus)
    : undefined,
  lastSyncErrorCode
    ? eq(newApiUserBinding.lastSyncErrorCode, lastSyncErrorCode)
    : undefined,
].filter(Boolean);
```

Use Drizzle `and(...conditions)` when conditions exist. Do not select `newapiUserId`, `newapiAccessTokenEnc`, `newapiPasswordEnc` or `conflictNewapiUserId` in list rows.

- [x] **Step 5: Update `src/app/[locale]/(admin)/admin/users/page.tsx`**

Add `newApiBindingStatus` and `lastSyncErrorCode` to `searchParams`:

```ts
searchParams: Promise<{
  page?: number;
  pageSize?: number;
  email?: string;
  newApiBindingStatus?: string;
  lastSyncErrorCode?: string;
}>;
```

Pass them to `getUsersCount()` and `getUsers()`:

```ts
const { page: pageNum, pageSize, email, newApiBindingStatus, lastSyncErrorCode } =
  await searchParams;

const userFilters = { email, newApiBindingStatus, lastSyncErrorCode };
const total = await getUsersCount(userFilters);
const users = await getUsers({ ...userFilters, page, limit });
```

Add list columns:

```ts
{
  name: 'newApiBinding',
  title: t('fields.newapi_binding_status'),
  callback: (item: User) => (
    <Badge variant={statusVariant(item.newApiBinding?.status)}>
      {translateStatus(t, 'detail.status.binding', item.newApiBinding?.status, '-')}
    </Badge>
  ),
},
{
  name: 'newApiBindingError',
  title: t('fields.newapi_sync_error'),
  callback: (item: User) =>
    item.newApiBinding?.lastSyncErrorCode || '-',
},
```

Keep the existing email search and add simple filter links above the table using the current UI primitives. The required filters are server-side query params:

```tsx
<a href={`/admin/users?newApiBindingStatus=username_sync_failed`}>
  {t('list.filters.username_sync_failed')}
</a>
<a href={`/admin/users?lastSyncErrorCode=newapi_username_too_long`}>
  {t('list.filters.newapi_username_too_long')}
</a>
```

- [x] **Step 6: Update `src/app/[locale]/(admin)/admin/users/[id]/detail/page.tsx`**

Import:

```ts
import {
  confirmNewapiUserConflictAction,
  disableNewapiUserBindingAction,
  retryNewapiUserBindingAction,
} from '@/features/newapi-bridge/server/admin-user-binding-actions';
import { getPortalUserBinding, toAdminBindingDto } from '@/features/newapi-bridge/server/portal';
```

Load binding:

```ts
const bindingResult = await loadOrFallback(
  async () => {
    const binding = await getPortalUserBinding(targetUser.id);
    return binding ? toAdminBindingDto(binding) : null;
  },
  null
);
```

Add a binding card before the balance card:

```tsx
<Card>
  <CardHeader>
    <CardTitle>{t('detail.binding.title')}</CardTitle>
    <CardDescription>{t('detail.binding.description')}</CardDescription>
  </CardHeader>
  <CardContent className="space-y-4">
    {bindingResult.failed ? (
      <DataNotice>{t('detail.errors.binding')}</DataNotice>
    ) : null}
    <dl className="grid gap-4 md:grid-cols-3">
      <Metric
        label={t('detail.binding.fields.status')}
        value={translateStatus(
          t,
          'detail.status.binding',
          bindingResult.data?.status,
          emptyValue
        )}
      />
      <Metric
        label={t('detail.binding.fields.target_username')}
        value={bindingResult.data?.targetNewapiUsername || emptyValue}
      />
      <Metric
        label={t('detail.binding.fields.confirmed_username')}
        value={bindingResult.data?.newapiUsername || emptyValue}
      />
      <Metric
        label={t('detail.binding.fields.error_code')}
        value={bindingResult.data?.lastSyncErrorCode || emptyValue}
      />
      <Metric
        label={t('detail.binding.fields.last_attempted')}
        value={formatDateTime(
          bindingResult.data?.lastSyncAttemptedAt,
          locale,
          t('detail.empty.never_synced')
        )}
      />
      <Metric
        label={t('detail.binding.fields.last_synced')}
        value={formatDateTime(
          bindingResult.data?.lastSyncedAt,
          locale,
          t('detail.empty.never_synced')
        )}
      />
    </dl>
    {bindingResult.data?.lastSyncError ? (
      <DataNotice>{bindingResult.data.lastSyncError}</DataNotice>
    ) : null}
    <div className="flex flex-wrap gap-2">
      <form action={async () => {
        'use server';
        await retryNewapiUserBindingAction({ portalUserId: targetUser.id });
      }}>
        <button type="submit">{t('detail.binding.actions.retry')}</button>
      </form>
      {bindingResult.data?.status === 'conflict_requires_review' &&
      bindingResult.data.conflictNewapiUserId ? (
        <form action={async () => {
          'use server';
          await confirmNewapiUserConflictAction({
            portalUserId: targetUser.id,
            newapiUserId: bindingResult.data!.conflictNewapiUserId!,
          });
        }}>
          <button type="submit">{t('detail.binding.actions.confirm_conflict')}</button>
        </form>
      ) : null}
      <form action={async () => {
        'use server';
        await disableNewapiUserBindingAction({
          portalUserId: targetUser.id,
          reason: 'admin detail action',
        });
      }}>
        <button type="submit">{t('detail.binding.actions.disable')}</button>
      </form>
    </div>
  </CardContent>
</Card>
```

Use the repo's existing button/form component style if available on this page; keep visible text from locale messages.

- [x] **Step 7: Add locale messages**

In `src/config/locale/messages/zh/admin/users.json`, add:

```json
"newapi_binding_status": "New API 绑定",
"newapi_sync_error": "同步错误"
```

under `fields`, plus:

```json
"filters": {
  "username_sync_failed": "同步失败",
  "conflict_requires_review": "需人工确认",
  "newapi_username_too_long": "长邮箱阻断"
}
```

under `list`, plus `detail.binding` and `detail.status.binding`:

```json
"errors": {
  "usage": "用量数据暂时不可用。",
  "keys": "API Key 数据暂时不可用。",
  "ledger": "调额历史暂时不可用。",
  "binding": "New API 绑定状态暂时不可用。"
}
```

```json
"binding": {
  "title": "New API 绑定",
  "description": "该用户与 New API 用户名、状态和补偿动作。",
  "fields": {
    "status": "状态",
    "target_username": "目标用户名",
    "confirmed_username": "已确认用户名",
    "error_code": "错误码",
    "last_attempted": "最后尝试",
    "last_synced": "最后成功"
  },
  "actions": {
    "retry": "重试",
    "confirm_conflict": "确认冲突归属",
    "disable": "停用绑定"
  }
}
```

```json
"binding": {
  "pending": "待处理",
  "provisioning": "创建中",
  "active": "已启用",
  "username_sync_pending": "用户名同步中",
  "username_sync_failed": "用户名同步失败",
  "conflict_requires_review": "需人工确认",
  "disabled": "已停用"
}
```

Mirror the same keys in `src/config/locale/messages/en/admin/users.json`.

- [x] **Step 8: Run focused tests and type/lint checks**

Run:

```bash
NODE_OPTIONS='--conditions react-server' pnpm exec tsx --test tests/newapi-bridge/portal.test.ts --test-name-pattern 'getUsers can filter by New API binding status'
NODE_OPTIONS='--conditions react-server' pnpm exec tsx --test tests/newapi-bridge/admin-user-detail.test.ts
pnpm lint
```

Expected: PASS. The static admin detail test proves the binding card, retry/confirm/disable action references, USERS_WRITE permission checks, server-side list filters and locale keys exist. Lint should not report raw missing locale keys or unsafe server action imports.

- [x] **Step 9: Run phase check and record changed files**

Run:

```bash
git diff --check
git status --short
```

Expected: `git diff --check` exits 0. `git status --short` shows the Task 5 files changed. Do not stage or commit unless the user explicitly authorizes it or a later ship workflow requires it.

---

### Task 6: Usage/Ledger/API Key 回归与整体验证

**Files:**
- Modify: `tests/newapi-bridge/portal.test.ts`
- Modify: `tests/newapi-bridge/create-portal-key.test.ts`
- Modify: `tests/newapi-bridge/client.test.ts`
- No production code unless a regression test fails and points to a defect introduced by Tasks 1-5.

- [x] **Step 1: Add DTO redaction regression tests**

In `tests/newapi-bridge/portal.test.ts`, add:

```ts
test('public usage and key DTOs do not expose New API user binding internals after username sync changes', async () => {
  const portalUser = await insertUser('portal_user_redaction_regression', 'a@b.co');
  const created = await modules.portal.createPortalApiKey(
    portalUser,
    portalKeyInput('Redaction regression'),
    createSuccessfulRemoteClient()
  );
  const keys = await modules.portal.listPortalApiKeys(portalUser.id);
  const usage = await modules.portal.getPortalUsage(
    portalUser,
    createSuccessfulRemoteClient()
  );

  assertNoFields(created.binding, [
    'newapiUserId',
    'newapiKeyId',
    'newapiGroup',
    'newapiAccessTokenEnc',
    'newapiPasswordEnc',
  ]);
  assertNoFields(keys[0], [
    'newapiUserId',
    'newapiKeyId',
    'newapiGroup',
    'newapiAccessTokenEnc',
    'newapiPasswordEnc',
  ]);
  assertNoFields(usage.summary as any, ['newapiUserId', 'newapiGroup']);
});
```

Adjust fake remote client with `getQuota`, `getUsageSummary` and `listUsageLogs` methods if the existing helper lacks them.

- [x] **Step 2: Add ledger and API Key long-email regression tests**

In `tests/newapi-bridge/portal.test.ts`, add:

```ts
test('long-email quota adjustment leaves no applied ledger and records sync audit', async () => {
  const portalUser = await insertUser(
    'portal_user_long_email_ledger_regression',
    'very-long-user@example.com'
  );
  const operator = await insertUser('operator_long_email_ledger_regression', 'ops@b.co');

  await assert.rejects(
    modules.portal.adjustPortalQuota({
      portalUser,
      operatorUserId: operator.id,
      amountUsd: 20,
      reason: 'regression guard',
      idempotencyKey: 'long-email-ledger-regression',
      client: createSuccessfulRemoteClient(),
    }),
    /Phase A limit/
  );

  const ledger = await modules.portal.listAdjustmentLedgerByPortalUser(
    portalUser.id
  );
  const audits = await modules
    .db()
    .select()
    .from(modules.newApiBridgeAuditLog)
    .where(eq(modules.newApiBridgeAuditLog.portalUserId, portalUser.id));

  assert.equal(ledger.some((row: any) => row.status === 'applied'), false);
  assert.equal(
    audits.some((row: any) => row.action === 'newapi.user.username_sync'),
    true
  );
});
```

In `tests/newapi-bridge/create-portal-key.test.ts`, keep the Task 3 long-email Key test and add this active short-email regression:

```ts
test('createPortalApiKey uses normalized email username for first-time short-email users', async () => {
  const portalUser = await insertUser(
    'create_key_short_email_user',
    ' A@B.CO '
  );
  const remote = createRecordingRemoteClient();

  await modules.portal.createPortalApiKey(
    portalUser,
    { name: 'Short email key', groupSlug: 'official' },
    remote.client
  );

  assert.equal(remote.getProvisionUserInputs()[0].username, 'a@b.co');
  assert.equal(/^pu_/.test(remote.getProvisionUserInputs()[0].username), false);
});
```

- [x] **Step 3: Run the added regression tests and verify they pass**

Run:

```bash
NODE_OPTIONS='--conditions react-server' pnpm exec tsx --test tests/newapi-bridge/portal.test.ts --test-name-pattern 'public usage and key DTOs|long-email quota adjustment'
NODE_OPTIONS='--conditions react-server' pnpm exec tsx --test tests/newapi-bridge/create-portal-key.test.ts --test-name-pattern 'normalized email username|blocks Phase A long emails'
```

Expected: PASS. Failures here indicate a regression in binding status, DTO redaction or ledger preconditions and must be fixed before moving on.

- [x] **Step 4: Run all New API bridge tests**

Run:

```bash
NODE_OPTIONS='--conditions react-server' pnpm exec tsx --test tests/newapi-bridge/client.test.ts tests/newapi-bridge/portal.test.ts tests/newapi-bridge/create-portal-key.test.ts tests/newapi-bridge/admin-user-binding-actions.test.ts
```

Expected: PASS. This validates client API, portal binding, Key lifecycle, ledger, usage snapshot and admin actions together.

- [x] **Step 5: Run full project test and lint gates**

Run:

```bash
pnpm test
pnpm lint
pnpm build
```

Expected:
- `pnpm test`: PASS for all `tests/**/*.test.ts`.
- `pnpm lint`: PASS with no missing imports, unsafe unused variables or locale JSON syntax errors.
- `pnpm build`: PASS. If build fails because external environment variables for live integrations are intentionally absent, record the exact missing variable and rerun the narrow bridge test suite; do not classify environment-gate failures as implementation failures.

- [x] **Step 6: Verify changed file scope**

Run:

```bash
git diff --name-only
```

Expected: changed files are limited to the files named in this plan. There are no edits to `src/config/db/schema.mysql.ts`, `src/config/db/schema.postgres.ts`, requirements docs, design docs, New API deployment images or production secrets.

- [x] **Step 7: Run final phase check and record changed files**

Run:

```bash
git diff --check
git status --short
```

Expected: `git diff --check` exits 0. `git status --short` shows Task 6 tests and any defect-fix files from this plan. Do not stage or commit unless the user explicitly authorizes it or a later ship workflow requires it.

- [x] **Step 8: Request review after implementation**

Use a fresh review agent after all six tasks complete. Review prompt:

```text
请只读评审本分支的 New API username/ledger sync Phase A 实现。重点检查：
1. 长邮箱是否始终阻断为 username_sync_failed/newapi_username_too_long，且没有生成 pu_<hash> 或技术名。
2. updateUserProfile() 是否远端回读 role 并原样提交，调用方是否无法传 role。
3. 邮箱变更是否普通用户不开放，后台短邮箱远端成功并回读确认后，是否把本地 user.email、binding active/last synced 字段和 success audit 放在同一个 db().transaction(...) 内提交。
4. 远端 username 已更新但本地事务失败时，是否写 username_sync_failed + lastSyncErrorCode='local_commit_failed' 和失败 audit，明确提示需要人工补偿。
5. confirm conflict 正向路径是否校验 conflict_requires_review、候选 newapiUserId、唯一占用、远端摘要，并写 active binding、清空 conflict 字段和 newapi.user.conflict_confirm audit。
6. 后台用户列表/详情是否包含筛选、状态、retry/confirm conflict/disable，且 DTO 去敏。
7. sqlite/libsql 迁移是否完整，mysql/postgres 是否保持未改。
8. usage/ledger/API Key 是否仍以 active binding 为前置，失败不显示成功。
```

Expected: reviewer returns no Blocker/Major before merge or deploy.

---

## Implementation Order

1. Task 1 locks the storage contract before business logic.
2. Task 2 gives portal code a safe New API username update primitive.
3. Task 3 changes the bridge behavior and signup hook while preserving existing Key/usage/ledger paths.
4. Task 4 adds controlled email-change and admin recovery mutations.
5. Task 5 exposes the minimal admin UI and safe list/detail DTOs at `src/app/[locale]/(admin)/admin/users/page.tsx` and `src/app/[locale]/(admin)/admin/users/[id]/detail/page.tsx`.
6. Task 6 runs cross-path regressions and review.

## Self-Review

- Spec coverage: Phase A boundary, short-email auto path, long-email fail-closed, sqlite/libsql-only migration, remote `role` preservation, signup best-effort, email-change transaction order, admin minimal loop, DTO redaction, usage/ledger/API Key regressions are all mapped to Tasks 1-6.
- NO-GO remediation coverage:
  - 邮箱变更 Blocker 已在 Task 4 补为远端 `updateUserProfile()` 成功并回读确认后，`user.email`、binding active/last synced 字段和 success audit 同一个 `db().transaction(...)` 提交；本地事务失败写 `username_sync_failed`、`lastSyncErrorCode='local_commit_failed'` 和失败 audit。
  - `confirm conflict` Blocker 已在 Task 4 补正向测试和实现：校验 `conflict_requires_review`、候选 ID、唯一占用、远端摘要，写 active binding、清空错误/conflict 字段并写 `newapi.user.conflict_confirm` audit。
  - 审计操作者 Major 已处理：Task 4 的 admin server actions 先 `requirePermission()`，再通过 `getUserInfo()` 获取当前管理员，校验 session 存在，并把 `operatorUserId: currentUser.id` 传给 retry / confirm conflict / disable helper；Task 5 静态测试断言 action 源码包含 `getUserInfo`、session 缺失错误和 3 处 `operatorUserId: currentUser.id`。
  - commit Major 已处理：所有默认 `git commit` 步骤均改为 `git diff --check` / `git status --short` 阶段检查，并注明仅在用户明确授权或后续 ship 流程要求时才 staging/commit。
  - Task 5 TDD Major 已处理：新增 `tests/newapi-bridge/admin-user-detail.test.ts` 静态测试，覆盖详情 binding 卡片、retry/confirm/disable action 引用、USERS_WRITE 权限检查、列表筛选和 locale key 完整性。
  - migration Minor 已处理：Task 1 改为手工维护稳定 `0009_newapi_username_sync_status.sql`，明确 `_journal.json` 顶层 `version` 保持当前 `"7"`，entry `version` 参考现有 `"6"`，并用 node/rg 验证 metadata。
- 空洞内容扫描：本计划没有开放式填充标记，也没有未命名的实现槽位。
- Type consistency: `targetNewapiUsername`, `lastSyncErrorCode`, `lastSyncError`, `lastSyncAction`, `lastSyncedAt`, `lastSyncAttemptedAt`, `conflictNewapiUserId`, `updateUserProfile()`, `normalizeNewapiUsernameEmail()`, `provisionPortalUserAfterSignup()`, `updatePortalUserEmailWithNewapiSync()`, `retryNewapiUserBindingAction()`, `confirmNewapiUserConflictAction()` and `disableNewapiUserBindingAction()` are introduced before later tasks reference them.
