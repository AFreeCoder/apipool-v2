import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('dashboard layout requires a signed-in portal user', async () => {
  const source = await readFile(
    'src/app/[locale]/(landing)/dashboard/layout.tsx',
    'utf8'
  );

  assert.match(source, /getUserInfo/);
  assert.match(source, /redirect/);
  assert.match(source, /\/sign-in/);
  assert.match(source, /if \(!user\)/);
});
