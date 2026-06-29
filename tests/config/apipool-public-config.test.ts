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
    /NEXT_PUBLIC_APIPOOL_API_BASE_URL\s*=\s*"https:\/\/api2\.apipool\.dev"/
  );
  assert.doesNotMatch(source, /api2\.apipool\.dev\/v1/);
  assert.doesNotMatch(envExample, /api2\.apipool\.dev\/v1/);
});
