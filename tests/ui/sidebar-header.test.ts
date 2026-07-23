import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

async function listSourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const path = join(dir, entry.name);

      if (entry.isDirectory()) {
        return listSourceFiles(path);
      }

      return entry.isFile() && /\.(?:ts|tsx)$/.test(entry.name) ? [path] : [];
    })
  );

  return files.flat();
}

function extractSourceIconNames(source: string): string[] {
  return Array.from(
    source.matchAll(/\bicon:\s*['"]([A-Za-z0-9]+)['"]/g),
    (match) => match[1]
  );
}

function extractJsonIconNames(value: unknown, names = new Set<string>()) {
  if (Array.isArray(value)) {
    value.forEach((item) => extractJsonIconNames(item, names));
    return names;
  }

  if (!value || typeof value !== 'object') {
    return names;
  }

  for (const [key, item] of Object.entries(value)) {
    if (key === 'icon' && typeof item === 'string') {
      names.add(item);
    } else {
      extractJsonIconNames(item, names);
    }
  }

  return names;
}

test('admin sidebar header keeps brand and version inside the menu button', async () => {
  const source = await readFile(
    join(process.cwd(), 'src/shared/blocks/dashboard/sidebar-header.tsx'),
    'utf8'
  );

  assert.doesNotMatch(source, /absolute\s+-top-0\s+-right-16/);
  assert.match(source, /min-w-0/);
  assert.match(source, /truncate/);
});

test('所有延迟挂载的交互菜单都使用同步图标，不在首次打开时补帧', async () => {
  const consumerPaths = [
    'src/shared/blocks/sign/sign-user.tsx',
    'src/shared/blocks/dashboard/sidebar-user.tsx',
    'src/shared/blocks/table/dropdown.tsx',
    'src/shared/blocks/dashboard/nav.tsx',
    'src/shared/blocks/dashboard/sidebar-buttons.tsx',
    'src/shared/blocks/dashboard/sidebar-footer.tsx',
    'src/shared/blocks/console/layout.tsx',
    'src/themes/default/blocks/header.tsx',
  ];
  const [iconSource, siteShellSource, ...consumerSources] = await Promise.all([
    readFile(
      join(process.cwd(), 'src/shared/blocks/common/menu-icon.tsx'),
      'utf8'
    ),
    readFile(
      join(process.cwd(), 'src/features/apipool-ui/site-shell.tsx'),
      'utf8'
    ),
    ...consumerPaths.map((path) => readFile(join(process.cwd(), path), 'utf8')),
  ]);

  for (const source of consumerSources) {
    assert.match(source, /<MenuIcon/);
    assert.doesNotMatch(source, /<(?:SmartIcon|UserMenuIcon)\b/);
  }

  assert.doesNotMatch(iconSource, /from ['"].*smart-icon|<SmartIcon\b/);
  assert.match(iconSource, /menuIcons\[name\]\s*\?\?\s*HelpCircle/);

  const registry = iconSource.match(
    /const menuIcons:[\s\S]*?=\s*\{([\s\S]*?)\n\};/
  )?.[1];
  assert.ok(registry, '应能读取同步菜单图标注册表');

  const requiredIcons = new Set(extractSourceIconNames(siteShellSource));
  const localeConfigPaths = [
    'src/config/locale/messages/zh/landing.json',
    'src/config/locale/messages/zh/admin/sidebar.json',
    'src/config/locale/messages/zh/settings/sidebar.json',
    'src/config/locale/messages/zh/activity/sidebar.json',
    'src/config/locale/messages/zh/ai/chat.json',
  ];

  for (const path of localeConfigPaths) {
    const config = JSON.parse(
      await readFile(join(process.cwd(), path), 'utf8')
    );
    extractJsonIconNames(config).forEach((name) => requiredIcons.add(name));
  }

  const appSources = await Promise.all(
    (await listSourceFiles(join(process.cwd(), 'src/app'))).map((path) =>
      readFile(path, 'utf8')
    )
  );
  for (const source of appSources.filter((item) =>
    /\btype:\s*['"]dropdown['"]/.test(item)
  )) {
    extractSourceIconNames(source).forEach((name) => requiredIcons.add(name));
  }

  for (const icon of requiredIcons) {
    assert.match(
      registry,
      new RegExp(`\\b${icon}\\b`),
      `交互菜单图标 ${icon} 必须同步注册`
    );
  }
});
