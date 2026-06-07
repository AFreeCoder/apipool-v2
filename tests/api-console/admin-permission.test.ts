import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

test('quota adjustment uses a dedicated APIPool operator permission', async () => {
  const files = {
    permission: await readFile(
      join(process.cwd(), 'src/core/rbac/permission.ts'),
      'utf8'
    ),
    route: await readFile(
      join(process.cwd(), 'src/app/api/apipool/admin/adjust-quota/route.ts'),
      'utf8'
    ),
    page: await readFile(
      join(
        process.cwd(),
        'src/app/[locale]/(admin)/admin/apipool-adjustments/page.tsx'
      ),
      'utf8'
    ),
    usersPage: await readFile(
      join(process.cwd(), 'src/app/[locale]/(admin)/admin/users/page.tsx'),
      'utf8'
    ),
    rbac: await readFile(join(process.cwd(), 'scripts/init-rbac.ts'), 'utf8'),
  };

  assert.match(
    files.permission,
    /APIPOOL_QUOTA_ADJUST:\s*'admin\.apipool\.quota\.adjust'/
  );
  assert.match(files.route, /PERMISSIONS\.APIPOOL_QUOTA_ADJUST/);
  assert.match(files.page, /PERMISSIONS\.APIPOOL_QUOTA_ADJUST/);
  assert.match(
    files.usersPage,
    /hasPermission\([\s\S]*PERMISSIONS\.APIPOOL_QUOTA_ADJUST/
  );
  assert.match(files.usersPage, /canAdjustApipoolQuota[\s\S]*adjust-quota/);
  assert.match(files.rbac, /admin\.apipool\.quota\.adjust/);
  assert.match(files.rbac, /admin\.apipool\.\*/);
});

test('quota adjustment page copy hides backend gateway branding', async () => {
  const page = await readFile(
    join(
      process.cwd(),
      'src/app/[locale]/(admin)/admin/apipool-adjustments/page.tsx'
    ),
    'utf8'
  );

  assert.match(page, /internal quota executor/i);
  assert.doesNotMatch(page, /New API|newapi/);
});

test('RBAC seed includes a narrow APIPool operator role for manual quota work', async () => {
  const rbac = await readFile(join(process.cwd(), 'scripts/init-rbac.ts'), 'utf8');
  const operatorRole = rbac.match(
    /name:\s*'operator'[\s\S]*?permissions:\s*\[([\s\S]*?)\],/
  );

  assert.ok(operatorRole, 'operator role should be seeded');

  const permissions = operatorRole[1];
  const required = [
    'admin.access',
    'admin.users.read',
    'admin.apipool.*',
  ];
  const forbidden = [
    'admin.posts',
    'admin.categories',
    'admin.payments',
    'admin.subscriptions',
    'admin.credits',
    'admin.apikeys',
    'admin.settings',
    'admin.ai-tasks',
  ];

  for (const permission of required) {
    assert.match(permissions, new RegExp(`['"]${escapeRegExp(permission)}['"]`));
  }

  for (const permission of forbidden) {
    assert.doesNotMatch(permissions, new RegExp(escapeRegExp(permission)));
  }
  assert.doesNotMatch(permissions, /['"]\*['"]/);
});
