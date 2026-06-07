import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('landing hero keeps the quickstart panel compact on mobile', async () => {
  const source = await readFile(
    'src/app/[locale]/(landing)/page.tsx',
    'utf8'
  );

  assert.doesNotMatch(
    source,
    /className="[^"]*(^|\s)min-h-\[420px\][^"]*"/,
    'desktop quickstart height should not apply to mobile'
  );
  assert.match(
    source,
    /className="[^"]*lg:min-h-\[420px\][^"]*"/,
    'quickstart panel should keep the tall visual only on desktop'
  );
  assert.match(
    source,
    /max-h-\[260px\]/,
    'mobile quickstart code should have a bounded height'
  );
  assert.match(
    source,
    /grid-cols-1/,
    'landing hero should use an explicit single-column mobile grid'
  );
  assert.match(
    source,
    /className="[^"]*min-w-0[^"]*flex flex-col justify-center[^"]*"/,
    'copy column should be allowed to shrink inside the mobile grid'
  );
  assert.match(
    source,
    /className="[^"]*min-w-0[^"]*lg:min-h-\[420px\][^"]*"/,
    'quickstart column should be allowed to shrink inside the mobile grid'
  );
});

test('landing CTAs fit narrow screens without horizontal overflow', async () => {
  const source = await readFile(
    'src/app/[locale]/(landing)/page.tsx',
    'utf8'
  );

  assert.match(
    source,
    /className="[^"]*w-full[^"]*sm:w-auto[^"]*"/,
    'mobile CTA buttons should fill the narrow column and return to auto width on larger screens'
  );
});
