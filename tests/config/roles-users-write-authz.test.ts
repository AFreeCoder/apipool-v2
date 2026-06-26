import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

type AuthzTarget = {
  path: string;
  permission: 'ROLES_WRITE' | 'USERS_WRITE';
};

const targets: AuthzTarget[] = [
  {
    path: 'src/app/[locale]/(admin)/admin/roles/[id]/edit/page.tsx',
    permission: 'ROLES_WRITE',
  },
  {
    path: 'src/app/[locale]/(admin)/admin/roles/[id]/edit-permissions/page.tsx',
    permission: 'ROLES_WRITE',
  },
  {
    path: 'src/app/[locale]/(admin)/admin/users/[id]/edit/page.tsx',
    permission: 'USERS_WRITE',
  },
];

const editRolesTarget =
  'src/app/[locale]/(admin)/admin/users/[id]/edit-roles/page.tsx';

function serverActionWritePermissionPattern(permission: AuthzTarget['permission']) {
  return new RegExp(
    String.raw`['"]use server['"];\s*(?:(?://[^\n]*|/\*[\s\S]*?\*/)\s*)*await\s+requirePermission\(\s*\{\s*code:\s*PERMISSIONS\.${permission}\s*,?\s*\}\s*\);`
  );
}

function serverActionAllWritePermissionsPattern() {
  return new RegExp(
    String.raw`['"]use server['"];\s*(?:(?://[^\n]*|/\*[\s\S]*?\*/)\s*)*await\s+requireAllPermissions\(\s*\{\s*codes:\s*\[(?=[^\]]*PERMISSIONS\.USERS_WRITE)(?=[^\]]*PERMISSIONS\.ROLES_WRITE)[^\]]*\]\s*,?\s*\}\s*\);`
  );
}

for (const target of targets) {
  test(`${target.path} authorizes the server action with ${target.permission}`, async () => {
    const source = await readFile(join(process.cwd(), target.path), 'utf8');

    const pageAuthzCalls =
      source.match(/\bawait\s+require(?:All)?Permission(?:s)?\s*\(/g) ?? [];

    assert.ok(
      pageAuthzCalls.length >= 2,
      `${target.path} should keep page-level authz and add handler-level authz`
    );
    assert.match(
      source,
      serverActionWritePermissionPattern(target.permission),
      `${target.path} should call requirePermission(${target.permission}) immediately after 'use server'`
    );
  });
}

test(`${editRolesTarget} authorizes the server action with USERS_WRITE and ROLES_WRITE`, async () => {
  const source = await readFile(join(process.cwd(), editRolesTarget), 'utf8');

  const pageAuthzCalls =
    source.match(/\bawait\s+require(?:All)?Permission(?:s)?\s*\(/g) ?? [];

  assert.ok(
    pageAuthzCalls.length >= 2,
    `${editRolesTarget} should keep page-level authz and add handler-level authz`
  );
  assert.match(
    source,
    serverActionAllWritePermissionsPattern(),
    `${editRolesTarget} should call requireAllPermissions([USERS_WRITE, ROLES_WRITE]) immediately after 'use server'`
  );
});
