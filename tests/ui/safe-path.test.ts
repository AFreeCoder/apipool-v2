import assert from 'node:assert/strict';
import test from 'node:test';

import { safeInternalPath } from '@/shared/lib/safe-path';

test('safeInternalPath keeps ordinary internal paths', () => {
  assert.equal(safeInternalPath('/dashboard/api-keys'), '/dashboard/api-keys');
  assert.equal(safeInternalPath('/zh/dashboard?tab=1'), '/zh/dashboard?tab=1');
});

test('safeInternalPath falls back to root for empty or absolute urls', () => {
  assert.equal(safeInternalPath(undefined), '/');
  assert.equal(safeInternalPath(''), '/');
  assert.equal(safeInternalPath('https://evil.com'), '/');
  assert.equal(safeInternalPath('dashboard'), '/');
});

test('safeInternalPath rejects protocol-relative urls that would leave the site', () => {
  // `//evil.com` 以 `/` 开头，只判断首字符会让登录回跳变成开放重定向
  assert.equal(safeInternalPath('//evil.com'), '/');
  assert.equal(safeInternalPath('//evil.com/path'), '/');
  // 部分浏览器把反斜杠等同于斜杠
  assert.equal(safeInternalPath('/\\evil.com'), '/');
  assert.equal(safeInternalPath('/\t/evil.com'), '/');
});

test('safeInternalPath rejects header-splitting characters', () => {
  assert.equal(safeInternalPath('/dashboard\nSet-Cookie: x=1'), '/');
  assert.equal(safeInternalPath('/dashboard\r\nLocation: //evil.com'), '/');
});
