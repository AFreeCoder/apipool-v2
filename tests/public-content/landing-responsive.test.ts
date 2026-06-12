import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('landing hero stays single-column on mobile and shrinks gracefully', async () => {
  const source = await readFile('src/app/[locale]/(landing)/page.tsx', 'utf8');

  assert.match(
    source,
    /lg:grid-cols-\[/,
    'hero two-column layout must be desktop-only (lg: prefix)'
  );
  assert.doesNotMatch(
    source,
    /className="[^"]*(^|\s)min-h-\[/,
    'no unprefixed fixed heights that would break narrow screens'
  );
  assert.match(
    source,
    /min-w-0/,
    'hero quickstart column should be allowed to shrink inside the grid'
  );
  assert.match(
    source,
    /overflow-x-auto/,
    'code and table content must scroll horizontally instead of overflowing'
  );
});

test('landing CTAs and tables fit narrow screens without horizontal overflow', async () => {
  const source = await readFile('src/app/[locale]/(landing)/page.tsx', 'utf8');

  assert.match(
    source,
    /flex-wrap/,
    'CTA rows should wrap on narrow screens'
  );
  assert.match(
    source,
    /overflow-x-auto rounded-xl border/,
    'pricing table should be wrapped in a horizontal scroll container'
  );
});
