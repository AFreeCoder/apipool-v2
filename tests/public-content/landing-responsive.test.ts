import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('landing hero stays single-column on mobile and shrinks gracefully', async () => {
  const source = await readFile('src/app/[locale]/(landing)/page.tsx', 'utf8');

  assert.match(
    source,
    /lg:grid-cols-\[/,
    'hero two-column layout must be desktop-only (lg: prefix)'
  );
  assert.doesNotMatch(
    source,
    /className="[^"]*(^|\s)min-h-\[/,
    'no unprefixed fixed heights that would break narrow screens'
  );
  assert.match(
    source,
    /min-w-0/,
    'hero terminal column should be allowed to shrink inside the grid'
  );
  // 终端已抽成 HeroTerminal 组件，自身以 whitespace-pre-wrap 换行处理溢出，
  // 页面层不再需要 overflow-x-auto；此处改守卫其它宽内容（跑马灯）不横溢。
  assert.match(
    source,
    /overflow-hidden/,
    'wide marquee content must be clipped instead of overflowing the page'
  );
});

test('landing CTAs and scenario grid fit narrow screens without horizontal overflow', async () => {
  const source = await readFile('src/app/[locale]/(landing)/page.tsx', 'utf8');

  assert.match(source, /flex-wrap/, 'CTA rows should wrap on narrow screens');
  assert.match(
    source,
    /grid gap-5 sm:grid-cols-2 lg:grid-cols-3/,
    'feature cards should collapse to a single column on mobile'
  );
});
