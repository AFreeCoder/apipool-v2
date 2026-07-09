import assert from 'node:assert/strict';
import test from 'node:test';

import {
  formatConsoleDateTime,
  formatConsoleNumber,
} from '@/features/api-console/lib/datetime';

const SAMPLE = new Date('2026-07-09T06:35:00.000Z');

test('console timestamps are formatted per page locale, pinned to UTC', () => {
  // 裸 toLocaleString() 会跟随 Node 运行时（容器里通常 en-US / UTC），
  // 中文页面因此显示美式日期，且时间随部署环境漂移。
  const en = formatConsoleDateTime(SAMPLE, 'en');
  const zh = formatConsoleDateTime(SAMPLE, 'zh');

  assert.match(en, /07\/09\/2026/);
  assert.match(zh, /2026\/07\/09/);
  for (const formatted of [en, zh]) {
    assert.match(formatted, /06:35/, 'must render the UTC wall clock');
  }
});

test('console timestamps degrade to a dash instead of Invalid Date', () => {
  assert.equal(formatConsoleDateTime(null, 'en'), '—');
  assert.equal(formatConsoleDateTime('not-a-date', 'en'), '—');
  assert.equal(formatConsoleDateTime(undefined, 'zh'), '—');
});

test('console numbers use the page locale grouping', () => {
  assert.equal(formatConsoleNumber(1234567, 'en'), '1,234,567');
  assert.equal(formatConsoleNumber(0, 'en'), '0');
  assert.equal(formatConsoleNumber(null, 'en'), '—');
});
