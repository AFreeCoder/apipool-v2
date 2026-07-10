import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';

const root = process.cwd();
const catalogRoot = join(root, 'src/app/[locale]/(admin)/admin/catalog');

// 递归收集 catalog 管理后台下所有 page.tsx
function collectPageFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectPageFiles(fullPath));
    } else if (entry.isFile() && entry.name === 'page.tsx') {
      files.push(fullPath);
    }
  }
  return files;
}

// 守卫针对的是代码，不是散文。剥掉注释后再扫，注释里才能自由地把
// 被禁止的东西叫出名字（否则解释「为什么不能用 passby」本身会踩红灯）。
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

test('catalog admin pages must not throw business errors from server actions', () => {
  const pages = collectPageFiles(catalogRoot);

  // 目录结构变动导致一个页面都收集不到时，测试应失败而不是空转全绿。
  assert.ok(pages.length > 0, `no page.tsx found under ${catalogRoot}`);

  for (const page of pages) {
    const source = stripComments(readFileSync(page, 'utf8'));
    assert.ok(
      !source.includes('throw new Error('),
      `${page} 含有 "throw new Error(": 业务错误必须 return {status:'error', message}，` +
        `生产环境 server action 抛错会被 Next.js 脱敏成通用英文错误，` +
        `删除保护/重复售卖项/无效价格等翻译文案将对用户不可见。` +
        `业务校验请改抛 FormValidationError 并在 action 内捕获转 return。`
    );
  }
});

test('catalog admin server actions must not trust client-supplied record snapshots', () => {
  const pages = collectPageFiles(catalogRoot);
  assert.ok(pages.length > 0, `no page.tsx found under ${catalogRoot}`);

  for (const page of pages) {
    const source = stripComments(readFileSync(page, 'utf8'));
    assert.ok(
      !source.includes('passby'),
      `${page} 使用了 "passby": Form 是客户端组件，passby 会作为 server action 的` +
        `实参往返，可被伪造（例如把 pricePolicy 改成 listing_multiplier 让公开价` +
        `按 discountRateBps 缩放，而 New API 仍按分组倍率计费），也可能是过期页面` +
        `的陈旧快照。请改为在 action 内按路由参数重查记录并校验归属。`
    );
  }
});
