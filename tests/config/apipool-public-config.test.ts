import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('APIPool public config owns brand and canonical site URL', async () => {
  const source = await readFile('src/config/apipool/public.ts', 'utf8');
  const envExample = await readFile('.env.example', 'utf8');

  assert.match(source, /NEXT_PUBLIC_APIPOOL_BRAND_NAME/);
  assert.match(source, /NEXT_PUBLIC_APIPOOL_SITE_URL/);
  assert.doesNotMatch(source, /brandName:[^\n]*NEXT_PUBLIC_APP_NAME/);
  assert.doesNotMatch(source, /siteUrl:[^\n]*NEXT_PUBLIC_APP_URL/);

  assert.match(envExample, /NEXT_PUBLIC_APIPOOL_BRAND_NAME\s*=\s*"APIPool"/);
  assert.match(
    envExample,
    /NEXT_PUBLIC_APIPOOL_SITE_URL\s*=\s*"https:\/\/apipool\.dev"/
  );
  assert.match(
    envExample,
    /NEXT_PUBLIC_APIPOOL_API_BASE_URL\s*=\s*"https:\/\/app\.apipool\.dev"/
  );
  assert.match(source, /https:\/\/app\.apipool\.dev/);
  assert.doesNotMatch(source, /app\.apipool\.dev\/v1/);
});

test('landing keeps the public API Endpoint protocol-neutral', async () => {
  const [pageSource, zhHomeSource, enHomeSource, zhDocs, enDocs] =
    await Promise.all([
      readFile('src/app/[locale]/(landing)/page.tsx', 'utf8'),
      readFile('src/config/locale/messages/zh/pages/home.json', 'utf8'),
      readFile('src/config/locale/messages/en/pages/home.json', 'utf8'),
      readFile('content/docs/index.zh.mdx', 'utf8'),
      readFile('content/docs/index.mdx', 'utf8'),
    ]);
  const zhHome = JSON.parse(zhHomeSource);
  const enHome = JSON.parse(enHomeSource);

  assert.match(pageSource, /replace\('\{baseUrl\}', apiEndpoint\)/);
  assert.doesNotMatch(pageSource, /apiBaseWithV1|endsWith\('\/v1'\)/);
  assert.doesNotMatch(JSON.stringify(zhHome), /base_url/);
  assert.doesNotMatch(JSON.stringify(enHome), /base_url/);
  assert.doesNotMatch(zhHome.faq.items[0].a, /\/v1/);
  assert.doesNotMatch(enHome.faq.items[0].a, /\/v1/);
  assert.match(zhDocs, /Base URL 只包含协议中立的 endpoint/);
  assert.match(enDocs, /Base URL contains only the provider-neutral endpoint/);

  for (const docs of [zhDocs, enDocs]) {
    assert.match(
      docs,
      /## Base URL\n\n```text\nhttps:\/\/app\.apipool\.dev\n```/
    );
    assert.match(docs, /curl "\$APIPOOL_ENDPOINT\/v1\/chat\/completions"/);
    assert.match(docs, /baseURL: `\$\{APIPOOL_ENDPOINT\}\/v1`/);
    assert.match(docs, /base_url=f"\{APIPOOL_ENDPOINT\}\/v1"/);
    assert.match(docs, /curl "\$APIPOOL_ENDPOINT\/v1\/messages"/);
  }
});
