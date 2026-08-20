import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const docsRoot = 'content/docs';
const pagePaths = {
  common: `${docsRoot}/common/image-tasks.mdx`,
  commonZh: `${docsRoot}/common/image-tasks.zh.mdx`,
  official: `${docsRoot}/official/gpt-image-2.mdx`,
  officialZh: `${docsRoot}/official/gpt-image-2.zh.mdx`,
  discount: `${docsRoot}/discount/gpt-image-2.mdx`,
  discountZh: `${docsRoot}/discount/gpt-image-2.zh.mdx`,
} as const;

async function readJson(path: string) {
  return JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
}

async function readPages(paths: string[]) {
  return Promise.all(paths.map((path) => readFile(path, 'utf8')));
}

test('文档 source URL 与站点按需 locale 前缀一致', async () => {
  const [{ createGetUrl }, source] = await Promise.all([
    import('fumadocs-core/source'),
    readFile('src/core/docs/source.ts', 'utf8'),
  ]);
  const i18n = {
    defaultLanguage: 'en',
    languages: ['en', 'zh'],
    hideLocale: 'default-locale' as const,
  };
  const getUrl = createGetUrl('/docs', i18n);

  assert.match(source, /hideLocale: 'default-locale'/);
  assert.equal(
    getUrl(['official', 'gpt-image-2'], 'en'),
    '/docs/official/gpt-image-2'
  );
  assert.equal(
    getUrl(['discount', 'gpt-image-2'], 'en'),
    '/docs/discount/gpt-image-2'
  );
  assert.equal(
    getUrl(['official', 'gpt-image-2'], 'zh'),
    '/zh/docs/official/gpt-image-2'
  );
  assert.equal(
    getUrl(['discount', 'gpt-image-2'], 'zh'),
    '/zh/docs/discount/gpt-image-2'
  );
});

test('GPT Image 2 侧边栏按官方、特惠和通用参考编排且双语一致', async () => {
  const [
    root,
    rootZh,
    official,
    officialZh,
    discount,
    discountZh,
    common,
    commonZh,
  ] = await Promise.all([
    readJson(`${docsRoot}/meta.json`),
    readJson(`${docsRoot}/meta.zh.json`),
    readJson(`${docsRoot}/official/meta.json`),
    readJson(`${docsRoot}/official/meta.zh.json`),
    readJson(`${docsRoot}/discount/meta.json`),
    readJson(`${docsRoot}/discount/meta.zh.json`),
    readJson(`${docsRoot}/common/meta.json`),
    readJson(`${docsRoot}/common/meta.zh.json`),
  ]);

  assert.deepEqual(root.pages, ['index', 'official', 'discount', 'common']);
  assert.deepEqual(rootZh.pages, root.pages);
  assert.equal(root.title, 'API Documentation');
  assert.equal(rootZh.title, 'API 文档');

  assert.deepEqual(official.pages, ['gpt-image-2']);
  assert.deepEqual(officialZh.pages, official.pages);
  assert.equal(official.title, 'Official Group');
  assert.equal(officialZh.title, '官方分组');
  assert.equal(official.defaultOpen, true);
  assert.equal(officialZh.defaultOpen, true);

  assert.deepEqual(discount.pages, ['gpt-image-2']);
  assert.deepEqual(discountZh.pages, discount.pages);
  assert.equal(discount.title, 'Discount Group');
  assert.equal(discountZh.title, '特惠分组');
  assert.equal(discount.defaultOpen, true);
  assert.equal(discountZh.defaultOpen, true);

  assert.deepEqual(common.pages, ['image-tasks']);
  assert.deepEqual(commonZh.pages, common.pages);
  assert.equal(common.title, 'Common Reference');
  assert.equal(commonZh.title, '通用参考');
});

test('GPT Image 2 六个主题页面存在并只暴露统一公开模型 ID', async () => {
  const pages = await readPages(Object.values(pagePaths));
  const publicDocs = pages.join('\n');

  for (const page of pages) {
    assert.match(page, /^---\ntitle:/);
    assert.match(page, /gpt-image-2/);
  }

  const forbidden = [
    'gpt-image-2-official',
    'gpt-image-2-ext',
    'official_fallback',
    '/v1/images/async/generations',
    'codex特惠',
  ];
  for (const value of forbidden) {
    assert.doesNotMatch(publicDocs, new RegExp(value));
  }
  assert.doesNotMatch(publicDocs, /["']group["']\s*:/);
});

test('公共图片任务页覆盖提交、轮询、所有权、状态和临时结果契约', async () => {
  const [en, zh] = await readPages([pagePaths.common, pagePaths.commonZh]);

  for (const page of [en, zh]) {
    assert.match(page, /POST \/v1\/images\/generations/);
    assert.match(page, /POST \/v1\/images\/edits/);
    assert.match(page, /202 Accepted/);
    assert.match(page, /Location: \/v1\/tasks\/imgtask_01/);
    assert.match(page, /GET \/v1\/tasks\/\{task_id\}|\/v1\/tasks\/\$TASK_ID/);
    assert.match(page, /submission_unknown/);
    assert.match(page, /submitted/);
    assert.match(page, /processing/);
    assert.match(page, /meter_pending/);
    assert.match(page, /completed/);
    assert.match(page, /failed/);
    assert.match(page, /expires_at/);
    assert.match(page, /result_expires_at/);
    assert.match(page, /result_url_refresh_failed/);
  }

  assert.match(en, /same API key that submitted the task/);
  assert.match(zh, /提交任务时的同一个 API Key/);
  assert.match(en, /receives `404`/);
  assert.match(zh, /返回 `404`/);
});

test('两个分组页面保持同一模型但公开不同计费证据和 n 边界', async () => {
  const [official, officialZh, discount, discountZh] = await readPages([
    pagePaths.official,
    pagePaths.officialZh,
    pagePaths.discount,
    pagePaths.discountZh,
  ]);

  for (const page of [official, officialZh, discount, discountZh]) {
    assert.match(page, /model[:=][^\n]*gpt-image-2|"model": "gpt-image-2"/);
    assert.match(page, /202 Accepted/);
    assert.match(page, /\/v1\/images\/generations/);
    assert.match(page, /\/v1\/images\/edits/);
    assert.match(page, /\/v1\/tasks\/\$TASK_ID/);
    assert.match(page, /resolution/);
  }

  assert.match(official, /Token billing/);
  assert.match(officialZh, /Token 计费/);
  assert.match(official, /Number of requested images, `1`–`4`/);
  assert.match(officialZh, /请求图片数量，`1`–`4`/);
  assert.match(official, /"usage":/);
  assert.match(officialZh, /"usage":/);

  assert.match(discount, /Per-delivered-image billing/);
  assert.match(discountZh, /按实际交付张数计费/);
  assert.match(discount, /Currently supported value: `1`/);
  assert.match(discountZh, /当前公开支持值为 `1`/);
  assert.doesNotMatch(discount, /1.?128|fan-out|partial success/i);
  assert.doesNotMatch(discountZh, /1.?128|扇出|部分成功/);
  assert.doesNotMatch(discount, /"usage":/);
  assert.doesNotMatch(discountZh, /"usage":/);
  assert.match(discount, /successfully delivered `data` items/);
  assert.match(discountZh, /`data` 中成功交付的图片数量/);
});

test('Quickstart 链接两个分组与公共任务页且不再概括所有图片按张计费', async () => {
  const [en, zh] = await readPages([
    `${docsRoot}/index.mdx`,
    `${docsRoot}/index.zh.mdx`,
  ]);

  assert.match(en, /\/docs\/official\/gpt-image-2/);
  assert.match(en, /\/docs\/discount\/gpt-image-2/);
  assert.match(en, /\/docs\/common\/image-tasks/);
  assert.match(zh, /\/zh\/docs\/official\/gpt-image-2/);
  assert.match(zh, /\/zh\/docs\/discount\/gpt-image-2/);
  assert.match(zh, /\/zh\/docs\/common\/image-tasks/);

  for (const page of [en, zh]) {
    assert.match(page, /202 Accepted/);
    assert.match(page, /"resolution":"1k"/);
    assert.doesNotMatch(page, /per returned image/i);
    assert.doesNotMatch(page, /所有图片模型|图片模型按.*实际返回张数/);
  }
});
