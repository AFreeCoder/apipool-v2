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

test('safeDecodedInternalPath decodes once before validating', async () => {
  const { safeDecodedInternalPath } = await import('@/shared/lib/safe-path');

  assert.equal(safeDecodedInternalPath('%2Fdashboard'), '/dashboard');
  assert.equal(safeDecodedInternalPath('/dashboard'), '/dashboard');
});

test('safeDecodedInternalPath rejects url-encoded protocol-relative urls', async () => {
  const { safeDecodedInternalPath } = await import('@/shared/lib/safe-path');

  // verify-email 只判断 decodeURIComponent 之后 startsWith('/')，
  // `%2F%2Fevil.com` 解码成 `//evil.com` 就放行了，随后 location.assign 离站。
  assert.equal(safeDecodedInternalPath('%2F%2Fevil.com'), '/');
  assert.equal(safeDecodedInternalPath('//evil.com'), '/');
  assert.equal(safeDecodedInternalPath('%2F%5Cevil.com'), '/');
  assert.equal(safeDecodedInternalPath('https://evil.com'), '/');
  assert.equal(safeDecodedInternalPath('%09//evil.com'), '/');
});

test('safeDecodedInternalPath survives malformed encodings', async () => {
  const { safeDecodedInternalPath } = await import('@/shared/lib/safe-path');

  assert.equal(safeDecodedInternalPath('%E0%A4%A'), '/');
  assert.equal(safeDecodedInternalPath(undefined), '/');
  assert.equal(safeDecodedInternalPath(''), '/');
});
