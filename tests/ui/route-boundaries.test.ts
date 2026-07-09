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

test('the dashboard route has loading and error boundaries', async () => {
  // dashboard 各页是同步 RSC 且串远端调用；没有边界就是白屏 + Next 默认英文错误页
  assert.ok(await exists('src/app/[locale]/(landing)/dashboard/loading.tsx'));
  assert.ok(await exists('src/app/[locale]/(landing)/dashboard/error.tsx'));

  const errorPage = await readFile(
    'src/app/[locale]/(landing)/dashboard/error.tsx',
    'utf8'
  );
  assert.match(errorPage, /^'use client';/);
  assert.match(errorPage, /useTranslations\('pages\.errors\.error'\)/);
  assert.match(errorPage, /reset/);
});

test('404 renders inside the localized shell instead of the bare English root page', async () => {
  assert.ok(await exists('src/app/[locale]/not-found.tsx'));

  const page = await readFile('src/app/[locale]/not-found.tsx', 'utf8');
  assert.match(page, /SiteShell/);
  assert.match(page, /getTranslations\('pages\.errors\.notFound'\)/);
});

test('the errors namespace is registered so its messages actually load', async () => {
  // 历史坑：翻译 JSON 齐全但漏注册 localeMessagesPaths，页面渲染裸 key
  const config = await readFile('src/config/locale/index.ts', 'utf8');
  assert.match(config, /'pages\/errors'/);

  for (const locale of ['en', 'zh']) {
    const messages = JSON.parse(
      await readFile(
        `src/config/locale/messages/${locale}/pages/errors.json`,
        'utf8'
      )
    );
    for (const key of ['title', 'description', 'backHome']) {
      assert.ok(messages.notFound?.[key], `${locale} notFound.${key}`);
    }
    for (const key of ['title', 'description', 'retry']) {
      assert.ok(messages.error?.[key], `${locale} error.${key}`);
    }
  }
});

test('unauthenticated console access preserves the requested destination', async () => {
  const layout = await readFile(
    'src/app/[locale]/(landing)/dashboard/layout.tsx',
    'utf8'
  );
  assert.match(layout, /callbackUrl=/);
  assert.match(layout, /x-pathname/);
  assert.match(layout, /safeInternalPath/);
  assert.doesNotMatch(layout, /redirect\(\{ href: '\/sign-in', locale \}\)/);
});

test('sign-in and sign-up hand the destination to each other', async () => {
  for (const file of [
    'src/shared/blocks/sign/sign-in.tsx',
    'src/shared/blocks/sign/sign-up.tsx',
  ]) {
    const source = await readFile(file, 'utf8');
    assert.match(source, /callbackUrl=\$\{encodeURIComponent\(callbackUrl\)\}/);
  }
});

test('auth pages sanitize the callback url through the shared helper', async () => {
  for (const file of [
    'src/app/[locale]/(auth)/sign-in/page.tsx',
    'src/app/[locale]/(auth)/sign-up/page.tsx',
  ]) {
    const source = await readFile(file, 'utf8');
    assert.match(source, /from '@\/shared\/lib\/safe-path'/);
    // 传给客户端组件的 callbackUrl 也必须先净化：登录成功后由它决定跳哪
    assert.doesNotMatch(source, /callbackUrl=\{callbackUrl \|\| '\/'\}/);
    assert.doesNotMatch(source, /function safeInternalPath/);
  }
});
