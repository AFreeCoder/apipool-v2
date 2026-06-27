import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

test('admin sidebar header keeps brand and version inside the menu button', async () => {
  const source = await readFile(
    join(process.cwd(), 'src/shared/blocks/dashboard/sidebar-header.tsx'),
    'utf8'
  );

  assert.doesNotMatch(source, /absolute\s+-top-0\s+-right-16/);
  assert.match(source, /min-w-0/);
  assert.match(source, /truncate/);
});
