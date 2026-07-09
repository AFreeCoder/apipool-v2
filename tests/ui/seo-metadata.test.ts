import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('the models page declares its own canonical url and metadata', async () => {
  const page = await readFile(
    'src/app/[locale]/(landing)/models/page.tsx',
    'utf8'
  );

  // 没有页面级 metadata 时，canonical 回退到站点根：/models 是唯一核心可索引
  // 的营销页，会被搜索引擎归并到首页，社交分享也没有页面标题。
  assert.match(page, /generateMetadata/);
  assert.match(page, /canonicalUrl: '\/models'/);
  assert.match(page, /pages\.models\.metadata/);

  for (const locale of ['en', 'zh']) {
    const messages = JSON.parse(
      await readFile(
        `src/config/locale/messages/${locale}/pages/models.json`,
        'utf8'
      )
    );
    assert.ok(messages.metadata?.title, `${locale} metadata.title`);
    assert.ok(messages.metadata?.description, `${locale} metadata.description`);
  }
});

test('hreflang alternates point at the current path, not always the home page', async () => {
  const layout = await readFile('src/app/layout.tsx', 'utf8');

  // 手写的 <link rel="alternate"> 对每个页面都声明「另一语言版本是首页」，
  // 错误的 hreflang 比没有更糟。
  assert.doesNotMatch(layout, /hrefLang=\{loc\}/);
});

test('the sitemap is generated instead of a hand-maintained static file', async () => {
  const sitemap = await readFile('src/app/sitemap.ts', 'utf8');
  assert.match(sitemap, /MetadataRoute\.Sitemap/);
  assert.match(sitemap, /\/models/);
  assert.match(sitemap, /\/docs/);
});

test('social sharing has an image by default', async () => {
  const { access } = await import('node:fs/promises');

  await access('public/og.png');

  // 不改 app_preview_image 默认值（brand-assets 守卫要求默认配置不指向占位图），
  // 也不能用 opengraph-image 文件约定——[locale]/layout 的 generateMetadata
  // 定义了 openGraph，会整体覆盖文件约定注入的图片。
  const seo = await readFile('src/shared/lib/seo.ts', 'utf8');
  assert.match(seo, /DEFAULT_PREVIEW_IMAGE = '\/og\.png'/);
  assert.match(seo, /envConfigs\.app_preview_image \|\| DEFAULT_PREVIEW_IMAGE/);
});
