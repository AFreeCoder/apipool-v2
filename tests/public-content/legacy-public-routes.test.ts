import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const legacyPublicRedirects = [
  {
    file: 'src/app/[locale]/(landing)/pricing/page.tsx',
    destination: '/models',
  },
  {
    file: 'src/app/[locale]/(landing)/blog/page.tsx',
    destination: '/models',
  },
  {
    file: 'src/app/[locale]/(landing)/blog/[slug]/page.tsx',
    destination: '/models',
  },
  {
    file: 'src/app/[locale]/(landing)/blog/category/[slug]/page.tsx',
    destination: '/models',
  },
  {
    file: 'src/app/[locale]/(landing)/showcases/page.tsx',
    destination: '/models',
  },
  {
    file: 'src/app/[locale]/(landing)/models/[slug]/page.tsx',
    destination: '/models',
  },
  {
    file: 'src/app/[locale]/(landing)/updates/page.tsx',
    destination: '/docs',
  },
];

test('legacy public marketing routes redirect with locale-aware navigation', async () => {
  for (const item of legacyPublicRedirects) {
    const source = await readFile(item.file, 'utf8');

    assert.match(source, /@\/core\/i18n\/navigation/, item.file);
    assert.doesNotMatch(source, /next\/navigation/, item.file);
    assert.match(source, /params:\s*Promise<\{\s*locale:\s*string/, item.file);
    assert.match(
      source,
      new RegExp(`href:\\s*['"]${item.destination}`),
      item.file
    );
    assert.doesNotMatch(
      source,
      /DynamicPage|StaticPage|shared\/models\/post|content\/posts|TableCard|FormCard/,
      item.file
    );
  }
});
