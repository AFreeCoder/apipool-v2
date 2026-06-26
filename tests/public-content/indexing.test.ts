import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import {
  getRobotsDisallowRules,
  shouldNoIndexPath,
} from '@/features/apipool-ui/lib/indexing';

test('indexing policy keeps authenticated and internal routes out of search', () => {
  const noIndexPaths = [
    '/admin/apipool-adjustments',
    '/zh/admin/apipool-adjustments',
    '/zh-CN/admin/apipool-adjustments',
    '/zh-TW/admin/apipool-adjustments',
    '/en/admin/apipool-adjustments',
    '/dashboard/api-keys',
    '/zh/dashboard/usage',
    '/zh-CN/dashboard/usage',
    '/zh-TW/dashboard/usage',
    '/en/dashboard/usage',
    '/settings/payments',
    '/zh/settings/billing',
    '/zh-CN/settings/billing',
    '/zh-TW/settings/billing',
    '/en/settings/billing',
    '/activity/chats',
    '/api/apipool/keys',
  ];

  for (const path of noIndexPaths) {
    assert.equal(shouldNoIndexPath(path), true, path);
  }

  const publicPaths = [
    '/',
    '/zh',
    '/zh-CN',
    '/zh-TW',
    '/en',
    '/models',
    '/zh/models',
    '/zh-CN/models',
    '/zh-TW/models',
    '/en/models',
    '/docs',
    '/zh/docs',
    '/zh-CN/docs',
    '/zh-TW/docs',
    '/en/docs',
  ];
  for (const path of publicPaths) {
    assert.equal(shouldNoIndexPath(path), false, path);
  }
});

test('robots disallow rules include dashboard and internal routes', () => {
  const rules = getRobotsDisallowRules();

  assert.ok(rules.includes('/dashboard/*'));
  assert.ok(rules.includes('/admin/*'));
  assert.ok(rules.includes('/api/*'));
});

test('robots sitemap uses the centralized APIPool site URL', async () => {
  const robotsSource = await readFile(
    join(process.cwd(), 'src/app/robots.ts'),
    'utf8'
  );

  assert.match(robotsSource, /APIPOOL_CONFIG/);
  assert.match(robotsSource, /APIPOOL_CONFIG\.siteUrl/);
  assert.doesNotMatch(robotsSource, /envConfigs\.app_url/);
});

test('public sitemap only exposes APIPool MVP public entrypoints', async () => {
  const sitemap = await readFile(
    join(process.cwd(), 'public/sitemap.xml'),
    'utf8'
  );
  const locs = Array.from(sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)).map(
    (match) => match[1]
  );
  const expectedLocales = ['zh-CN', 'zh-TW', 'en'];

  assert.match(sitemap, /https:\/\/apipool\.dev\//);
  assert.doesNotMatch(sitemap, /your-domain\.com/);
  assert.deepEqual(
    locs.map((loc) => new URL(loc).origin),
    locs.map(() => 'https://apipool.dev')
  );
  for (const locale of expectedLocales) {
    assert.ok(locs.includes(`https://apipool.dev/${locale}`), locale);
    assert.ok(locs.includes(`https://apipool.dev/${locale}/models`), locale);
    assert.ok(locs.includes(`https://apipool.dev/${locale}/docs`), locale);
  }
  for (const loc of locs) {
    assert.doesNotMatch(
      new URL(loc).pathname,
      /^\/(blog|showcases|dashboard|admin|api)(\/|$)/
    );
  }
});
