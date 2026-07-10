import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('admin root renders an operations overview open to every admin.access role', async () => {
  const source = await readFile(
    'src/app/[locale]/(admin)/admin/page.tsx',
    'utf8'
  );

  // Regression: `/admin` used to unconditionally redirect to the quota
  // adjustment page, which requires APIPOOL_QUOTA_ADJUST — so every low-power
  // admin.access role (viewer/editor) hit no-permission on the first screen,
  // and the "Admin" breadcrumb formed a self-loop. The landing must now be a
  // real overview, not a redirect into a permission-gated page.
  assert.doesNotMatch(
    source,
    /redirect\(\{\s*href:\s*['"]\/admin\/apipool-adjustments/,
    'admin root must not redirect into the quota-gated adjustments page'
  );
  // Open to all admin.access: the page itself must not requirePermission (the
  // layout already enforces admin.access). Per-card gating uses hasPermission.
  assert.doesNotMatch(
    source,
    /requirePermission|requireAnyPermission|requireAllPermissions/,
    'the overview must be reachable by any admin.access role'
  );
  // The overview signals must actually be wired in.
  assert.match(source, /getAdminOverviewSignals/);
  assert.match(source, /AdminOverview/);
});

test('legacy admin API key page redirects into APIPool operator flow', async () => {
  const source = await readFile(
    'src/app/[locale]/(admin)/admin/apikeys/page.tsx',
    'utf8'
  );

  assert.match(source, /redirect/);
  assert.match(source, /href:\s*['"]\/admin\/apipool-adjustments/);
  assert.doesNotMatch(source, /getApikeys|TableCard|APIKEYS_READ/);
});

test('admin sidebar does not expose the legacy template API key table', async () => {
  const files = [
    'src/config/locale/messages/en/admin/sidebar.json',
    'src/config/locale/messages/zh/admin/sidebar.json',
  ];

  const violations: string[] = [];
  for (const file of files) {
    const source = await readFile(file, 'utf8');
    if (/["']\/admin\/apikeys["']/.test(source)) {
      violations.push(file);
    }
  }

  assert.deepEqual(violations, []);
});

test('legacy admin content and credit routes redirect into APIPool operator flow', async () => {
  const redirects = [
    'src/app/[locale]/(admin)/admin/posts/page.tsx',
    'src/app/[locale]/(admin)/admin/posts/add/page.tsx',
    'src/app/[locale]/(admin)/admin/posts/[id]/edit/page.tsx',
    'src/app/[locale]/(admin)/admin/categories/add/page.tsx',
    'src/app/[locale]/(admin)/admin/categories/[id]/edit/page.tsx',
    'src/app/[locale]/(admin)/admin/users/[id]/grant-credits/page.tsx',
  ];

  for (const file of redirects) {
    const source = await readFile(file, 'utf8');

    assert.match(source, /redirect/, file);
    assert.match(source, /\/admin\/apipool-adjustments/, file);
    assert.doesNotMatch(
      source,
      /TableCard|FormCard|CREDITS_|POSTS_|CATEGORIES_|SETTINGS_/,
      file
    );
  }

  const categoriesSource = await readFile(
    'src/app/[locale]/(admin)/admin/categories/page.tsx',
    'utf8'
  );

  assert.match(categoriesSource, /redirect/);
  assert.match(categoriesSource, /\/admin\/catalog\/models/);
  assert.doesNotMatch(categoriesSource, /TableCard|FormCard|CATEGORIES_/);
});
