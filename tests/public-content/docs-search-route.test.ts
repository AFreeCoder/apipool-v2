import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const layoutPath = 'src/app/[locale]/(docs)/layout.tsx';
const routePath = 'src/app/api/docs/search/route.ts';

test('docs layout points the search widget at an existing route', async () => {
  const layout = await readFile(layoutPath, 'utf8');
  const api = layout.match(/api:\s*'([^']+)'/)?.[1];

  assert.equal(api, '/api/docs/search');

  // 该路由必须真实存在，否则文档站搜索框每次查询都 404（对所有用户静默坏死）
  const route = await readFile(routePath, 'utf8');
  assert.match(route, /createFromSource/);
  assert.match(route, /export const \{[^}]*GET[^}]*\}|export async function GET/);
});

test('docs search indexes the docs source for both locales', async () => {
  const route = await readFile(routePath, 'utf8');

  assert.match(route, /docsSource/);
  // 文档是双语的；索引必须按 locale 分开，否则中文页搜不到
  assert.match(route, /localeMap/);
  assert.match(route, /zh/);
});
