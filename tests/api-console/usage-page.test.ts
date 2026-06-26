import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('usage page renders model distribution from synced usage summary', async () => {
  const source = await readFile(
    'src/app/[locale]/(landing)/dashboard/usage/page.tsx',
    'utf8'
  );

  assert.match(source, /copy\.modelDistribution/);
  assert.match(source, /usage\.summary\.byModel/);
  assert.match(source, /model\.requests/);
  assert.match(source, /model\.tokens/);
  assert.match(source, /copy\.averageLatency/);
  assert.match(source, /log\.group/);
});
