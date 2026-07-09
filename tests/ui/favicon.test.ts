import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import test from 'node:test';

async function exists(path: string) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

test('the app ships a favicon so the browser tab carries the brand', async () => {
  // 旧模板 logo 已删除且未补替代：app_favicon 默认空 → <link rel="icon"> 根本不渲染，
  // /favicon.ico 返回 404。App Router 的 icon 文件约定会自动注入 <link>。
  assert.ok(
    await exists('src/app/icon.svg'),
    'src/app/icon.svg must exist (App Router icon convention)'
  );
  assert.ok(
    await exists('src/app/apple-icon.png'),
    'src/app/apple-icon.png must exist for iOS home-screen bookmarks'
  );
});

test('the favicon uses the brand primary color', async () => {
  const icon = await readFile('src/app/icon.svg', 'utf8');
  const primary = (await readFile('src/config/style/theme.css', 'utf8')).match(
    /--primary:\s*(#[0-9a-fA-F]{6})/
  )?.[1];

  assert.ok(primary, 'theme.css must define --primary');
  assert.match(icon, new RegExp(primary, 'i'));
});
