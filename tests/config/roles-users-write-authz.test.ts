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

function serverActionWritePermissionPattern(
  permission: AuthzTarget['permission']
) {
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

test('admin role and user server actions re-read target records on the server', async () => {
  const expectations = [
    {
      file: 'src/app/[locale]/(admin)/admin/roles/[id]/edit/page.tsx',
      lookup: /const\s+targetRole\s*=\s*await\s+getRoleById\(id\)/,
      forbidden: /const\s+\{\s*role\s*\}\s*=\s*passby/,
    },
    {
      file: 'src/app/[locale]/(admin)/admin/roles/[id]/edit-permissions/page.tsx',
      lookup: /const\s+targetRole\s*=\s*await\s+getRoleById\(id\)/,
      forbidden: /const\s+\{\s*role\s*\}\s*=\s*passby/,
    },
    {
      file: 'src/app/[locale]/(admin)/admin/users/[id]/edit/page.tsx',
      lookup: /const\s+targetUser\s*=\s*await\s+findUserById\(id\)/,
      forbidden: /const\s+\{\s*user\s*\}\s*=\s*passby/,
    },
    {
      file: editRolesTarget,
      lookup: /const\s+targetUser\s*=\s*await\s+findUserById\(id\)/,
      forbidden: /const\s+\{\s*user\s*\}\s*=\s*passby/,
    },
  ];

  for (const expectation of expectations) {
    const source = await readFile(
      join(process.cwd(), expectation.file),
      'utf8'
    );
    assert.match(source, expectation.lookup, expectation.file);
    assert.doesNotMatch(source, expectation.forbidden, expectation.file);
  }
});

test('role assignment actions validate submitted IDs against server-side allowlists', async () => {
  const editRolesSource = await readFile(
    join(process.cwd(), editRolesTarget),
    'utf8'
  );
  assert.match(editRolesSource, /Array\.isArray\(roles\)/);
  assert.match(editRolesSource, /allowedRoleIds/);
  assert.match(editRolesSource, /await\s+getRoles\(\)/);
  assert.match(editRolesSource, /!allowedRoleIds\.has\(roleId\)/);

  const editPermissionsSource = await readFile(
    join(
      process.cwd(),
      'src/app/[locale]/(admin)/admin/roles/[id]/edit-permissions/page.tsx'
    ),
    'utf8'
  );
  assert.match(editPermissionsSource, /Array\.isArray\(permissions\)/);
  assert.match(editPermissionsSource, /allowedPermissionIds/);
  assert.match(editPermissionsSource, /await\s+getPermissions\(\)/);
  assert.match(
    editPermissionsSource,
    /!allowedPermissionIds\.has\(permissionId\)/
  );
});
