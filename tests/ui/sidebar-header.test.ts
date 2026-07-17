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

test('默认头像菜单图标随组件同步加载，不在首次打开菜单时补帧', async () => {
  const [iconSource, signUserSource, sidebarUserSource] = await Promise.all([
    readFile(
      join(process.cwd(), 'src/shared/blocks/common/user-menu-icon.tsx'),
      'utf8'
    ),
    readFile(
      join(process.cwd(), 'src/shared/blocks/sign/sign-user.tsx'),
      'utf8'
    ),
    readFile(
      join(process.cwd(), 'src/shared/blocks/dashboard/sidebar-user.tsx'),
      'utf8'
    ),
  ]);

  for (const icon of ['KeyRound', 'BarChart3', 'ReceiptText']) {
    assert.match(iconSource, new RegExp(`\\b${icon}\\b`));
  }
  assert.match(signUserSource, /<UserMenuIcon/);
  assert.match(sidebarUserSource, /<UserMenuIcon/);
});
