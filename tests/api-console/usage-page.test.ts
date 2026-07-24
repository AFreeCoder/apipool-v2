import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('usage page renders model distribution from synced usage summary', async () => {
  const source = await readFile(
    'src/app/[locale]/(landing)/dashboard/usage/page.tsx',
    'utf8'
  );

  assert.match(source, /sections\.modelDistribution\.title/);
  assert.match(source, /usage\.summary\.byModel/);
  assert.match(source, /model\.requests/);
  // 模型分布按设计改为条形图，展示「调用数 · 花费」，token 明细仍在下方请求日志表。
  assert.match(source, /model\.spendUsd/);
  assert.doesNotMatch(source, /tokens:\s*0/);
  assert.doesNotMatch(source, /keyMasked:\s*['"]—['"]/);
});

test('usage page renders readable sync states and stable log keys', async () => {
  const source = await readFile(
    'src/app/[locale]/(landing)/dashboard/usage/page.tsx',
    'utf8'
  );

  assert.match(source, /getUsageSyncDescription/);
  assert.match(source, /common\.raw\('usageSync'\)/);
  assert.match(source, /getUsageLogRowKey/);
  assert.doesNotMatch(source, /key=\\{`\\$\\{log\\.id\\}-\\$\\{index\\}`\\}/);
});

test('dashboard overview renders readable usage sync state and stable log keys', async () => {
  const source = await readFile(
    'src/app/[locale]/(landing)/dashboard/page.tsx',
    'utf8'
  );

  assert.match(source, /getUsageSyncDescription/);
  assert.match(source, /common\.raw\('usageSync'\)/);
  assert.match(source, /getUsageLogRowKey/);
  assert.doesNotMatch(source, /Sync: \\$\\{usage\\.summary\\.status\\}/);
});
