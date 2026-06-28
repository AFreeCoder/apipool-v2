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
  const sitemap = await readFile(
    join(process.cwd(), 'public/sitemap.xml'),
    'utf8'
  );
  const locs = Array.from(sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)).map(
    (match) => match[1]
  );

  assert.match(sitemap, /https:\/\/apipool\.dev\//);
  assert.match(sitemap, /https:\/\/apipool\.dev\/models/);
  assert.match(sitemap, /https:\/\/apipool\.dev\/docs/);
  assert.doesNotMatch(sitemap, /your-domain\.com/);
  assert.deepEqual(
    locs.map((loc) => new URL(loc).origin),
    locs.map(() => 'https://apipool.dev')
  );
  for (const loc of locs) {
    assert.doesNotMatch(
      new URL(loc).pathname,
      /^\/(blog|showcases|dashboard|admin|api)(\/|$)/
    );
  }
});
