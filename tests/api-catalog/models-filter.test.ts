import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import {
  buildModelFilterHref,
  formatMicroUsdPerMillion,
  parseModelFilters,
} from '@/features/api-catalog/lib/catalog';

test('buildModelFilterHref builds slug-based model filter links', () => {
  assert.equal(
    buildModelFilterHref({}, { vendor: 'openai' }),
    '/models?vendor=openai'
  );

  assert.equal(
    buildModelFilterHref(
      { vendor: 'openai', group: 'official', category: 'llm' },
      { capability: 'vision', status: 'available' }
    ),
    '/models?vendor=openai&group=official&category=llm&capability=vision&status=available'
  );

  assert.equal(
    buildModelFilterHref(
      { vendor: 'openai', status: 'available' },
      { status: undefined }
    ),
    '/models?vendor=openai'
  );
});

test('parseModelFilters accepts loose slug filters', () => {
  assert.deepEqual(
    parseModelFilters({ vendor: 'openai', group: 'official', category: 'llm' }),
    {
      vendor: 'openai',
      group: 'official',
      category: 'llm',
    }
  );

  assert.deepEqual(parseModelFilters({}), {});
});

test('models page exposes category as a public filter dimension', async () => {
  const source = await readFile(
    join(process.cwd(), 'src/app/[locale]/(landing)/models/page.tsx'),
    'utf8'
  );

  assert.match(
    source,
    /label:\s*['"]Category['"][\s\S]*?key:\s*['"]category['"]/
  );
});

test('formatMicroUsdPerMillion formats integer micro-USD prices', () => {
  assert.equal(formatMicroUsdPerMillion(150000), '$0.15');
  assert.equal(formatMicroUsdPerMillion(2500000), '$2.50');
  assert.equal(formatMicroUsdPerMillion(0), '$0.00');
});
