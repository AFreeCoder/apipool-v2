import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

type AuthzTarget = {
  path: string;
  permission: 'CATALOG_WRITE' | 'SETTINGS_WRITE';
};

const targets: AuthzTarget[] = [
  {
    path: 'src/app/[locale]/(admin)/admin/catalog/vendors/new/page.tsx',
    permission: 'CATALOG_WRITE',
  },
  {
    path: 'src/app/[locale]/(admin)/admin/catalog/vendors/[id]/edit/page.tsx',
    permission: 'CATALOG_WRITE',
  },
  {
    path: 'src/app/[locale]/(admin)/admin/catalog/capabilities/new/page.tsx',
    permission: 'CATALOG_WRITE',
  },
  {
    path: 'src/app/[locale]/(admin)/admin/catalog/capabilities/[id]/edit/page.tsx',
    permission: 'CATALOG_WRITE',
  },
  {
    path: 'src/app/[locale]/(admin)/admin/catalog/statuses/new/page.tsx',
    permission: 'CATALOG_WRITE',
  },
  {
    path: 'src/app/[locale]/(admin)/admin/catalog/statuses/[id]/edit/page.tsx',
    permission: 'CATALOG_WRITE',
  },
  {
    path: 'src/app/[locale]/(admin)/admin/catalog/groups/new/page.tsx',
    permission: 'CATALOG_WRITE',
  },
  {
    path: 'src/app/[locale]/(admin)/admin/catalog/groups/[id]/edit/page.tsx',
    permission: 'CATALOG_WRITE',
  },
  {
    path: 'src/app/[locale]/(admin)/admin/catalog/models/new/page.tsx',
    permission: 'CATALOG_WRITE',
  },
  {
    path: 'src/app/[locale]/(admin)/admin/catalog/models/[id]/edit/page.tsx',
    permission: 'CATALOG_WRITE',
  },
  {
    path: 'src/app/[locale]/(admin)/admin/catalog/models/[id]/capabilities/page.tsx',
    permission: 'CATALOG_WRITE',
  },
  {
    path: 'src/app/[locale]/(admin)/admin/catalog/models/[id]/listings/new/page.tsx',
    permission: 'CATALOG_WRITE',
  },
  {
    path: 'src/app/[locale]/(admin)/admin/catalog/models/[id]/listings/[listingId]/edit/page.tsx',
    permission: 'CATALOG_WRITE',
  },
  {
    path: 'src/app/[locale]/(admin)/admin/settings/[tab]/page.tsx',
    permission: 'SETTINGS_WRITE',
  },
];

function serverActionWritePermissionPattern(
  permission: AuthzTarget['permission']
) {
  if (permission === 'SETTINGS_WRITE') {
    return new RegExp(
      String.raw`['"]use server['"];\s*(?:(?://[^\n]*|/\*[\s\S]*?\*/)\s*)*await\s+requireAllPermissions\(\s*\{\s*codes:\s*\[(?=[^\]]*PERMISSIONS\.SETTINGS_READ)(?=[^\]]*PERMISSIONS\.SETTINGS_WRITE)[^\]]*\]\s*,?\s*\}\s*\);`
    );
  }

  return new RegExp(
    String.raw`['"]use server['"];\s*(?:(?://[^\n]*|/\*[\s\S]*?\*/)\s*)*await\s+requirePermission\(\s*\{\s*code:\s*PERMISSIONS\.${permission}\s*,?\s*\}\s*\);`
  );
}

for (const target of targets) {
  test(`${target.path} authorizes the server action with ${target.permission}`, async () => {
    const source = await readFile(join(process.cwd(), target.path), 'utf8');

    const requirePermissionCalls =
      source.match(/\bawait\s+require(?:All)?Permission(?:s)?\s*\(/g) ?? [];

    assert.ok(
      requirePermissionCalls.length >= 2,
      `${target.path} should keep page-level authz and add handler-level authz`
    );
    assert.match(
      source,
      serverActionWritePermissionPattern(target.permission),
      `${target.path} should authorize ${target.permission} immediately after 'use server'`
    );
  });
}
