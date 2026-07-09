import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import {
  getRobotsDisallowRules,
  localizePathForLocale,
  shouldNoIndexPath,
} from '@/features/apipool-ui/lib/indexing';

test('indexing policy keeps authenticated and internal routes out of search', () => {
  const noIndexPaths = [
    '/admin/apipool-adjustments',
    '/zh/admin/apipool-adjustments',
    '/dashboard/api-keys',
    '/zh/dashboard/usage',
    '/settings/payments',
    '/zh/settings/billing',
    '/activity/chats',
    '/api/apipool/keys',
  ];

  for (const path of noIndexPaths) {
    assert.equal(shouldNoIndexPath(path), true, path);
  }

  const publicPaths = ['/', '/zh', '/models', '/zh/models', '/docs', '/zh/docs'];
  for (const path of publicPaths) {
    assert.equal(shouldNoIndexPath(path), false, path);
  }
});

test('locale path helper strips existing locale prefixes before applying the target locale', () => {
  assert.equal(localizePathForLocale('/zh', 'zh'), '/zh');
  assert.equal(
    localizePathForLocale('/zh/models?view=list', 'zh'),
    '/zh/models?view=list'
  );
  assert.equal(
    localizePathForLocale('/zh/models?view=list', 'en'),
    '/models?view=list'
  );
  assert.equal(
    localizePathForLocale('/models?view=list', 'zh'),
    '/zh/models?view=list'
  );
  assert.equal(
    localizePathForLocale('/models?view=list', 'en'),
    '/models?view=list'
  );
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
  // 原先是手工维护的 public/sitemap.xml（lastmod 停在 2026-05-24，必然漂移，
  // 而且静态文件会遮蔽 app/sitemap.ts）。改为断言动态生成的结果。
  const { default: sitemap } = await import('@/app/sitemap');
  const entries = sitemap();
  const locs = entries.map((entry) => entry.url);

  assert.ok(locs.includes('https://apipool.dev/'));
  assert.ok(locs.includes('https://apipool.dev/models'));
  assert.ok(locs.includes('https://apipool.dev/docs'));
  assert.ok(locs.includes('https://apipool.dev/zh/models'));

  assert.deepEqual(
    locs.map((loc) => new URL(loc).origin),
    locs.map(() => 'https://apipool.dev')
  );
  for (const loc of locs) {
    assert.doesNotMatch(loc, /your-domain\.com/);
    assert.doesNotMatch(
      new URL(loc).pathname,
      /^\/(zh\/)?(blog|showcases|dashboard|admin|api)(\/|$)/
    );
    // 法律页在 robots 的 disallow 列表里，两处口径必须一致
    assert.doesNotMatch(
      new URL(loc).pathname,
      /(privacy-policy|terms-of-service)/
    );
  }

  // lastModified 必须是动态的，不能又变成硬编码日期
  for (const entry of entries) {
    assert.ok(entry.lastModified instanceof Date);
  }
});
