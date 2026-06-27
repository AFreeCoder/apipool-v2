import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('usage page renders model distribution from synced usage summary', async () => {
  const source = await readFile(
    'src/app/[locale]/(landing)/dashboard/usage/page.tsx',
    'utf8'
  );

  assert.match(source, /Model distribution/);
  assert.match(source, /usage\.summary\.byModel/);
  assert.match(source, /model\.requests/);
  assert.match(source, /model\.tokens/);
});

test('usage page renders readable sync states and stable log keys', async () => {
  const source = await readFile(
    'src/app/[locale]/(landing)/dashboard/usage/page.tsx',
    'utf8'
  );

  assert.match(source, /getUsageSyncDescription/);
  assert.match(source, /getUsageLogRowKey/);
  assert.doesNotMatch(source, /key=\\{`\\$\\{log\\.id\\}-\\$\\{index\\}`\\}/);
});

test('dashboard overview renders readable usage sync state and stable log keys', async () => {
  const source = await readFile(
    'src/app/[locale]/(landing)/dashboard/page.tsx',
    'utf8'
  );

  assert.match(source, /getUsageSyncDescription/);
  assert.match(source, /getUsageLogRowKey/);
  assert.doesNotMatch(source, /Sync: \\$\\{usage\\.summary\\.status\\}/);
});
