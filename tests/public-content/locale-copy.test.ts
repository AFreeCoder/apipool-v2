import assert from 'node:assert/strict';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

const PUBLIC_LOCALE_ROOTS = [
  join(process.cwd(), 'src/config/locale/messages/en/landing.json'),
  join(process.cwd(), 'src/config/locale/messages/zh/landing.json'),
  join(process.cwd(), 'src/config/locale/messages/en/pages'),
  join(process.cwd(), 'src/config/locale/messages/zh/pages'),
  join(process.cwd(), 'content/docs'),
  join(process.cwd(), 'content/pages'),
];

const FORBIDDEN_JSON_COPY = [
  /boilerplate/i,
  /demo site/i,
  /template/i,
  /purchase/i,
  /buy APIPool/i,
  /AI Image Generator/i,
  /AI Music Generator/i,
  /AI Video Generator/i,
  /Stripe/i,
  /PayPal/i,
  /购买 APIPool/,
  /模板/,
  /演示站点/,
  /AI 图片生成器/,
  /AI 音乐生成器/,
  /AI 视频生成器/,
  /支付/,
];

const FORBIDDEN_PUBLIC_INTERNAL_COPY = [
  /\bbridge\b/i,
  /New API/i,
  /newapi/i,
  /internal service/i,
];

async function collectPublicCopyFiles(path: string): Promise<string[]> {
  const entry = await stat(path).catch(() => null);
  if (!entry) return [];
  if (entry.isFile()) {
    return /\.(json|mdx)$/.test(path) ? [path] : [];
  }

  const children = await readdir(path);
  const nested = await Promise.all(
    children.map((child) => collectPublicCopyFiles(join(path, child)))
  );
  return nested.flat();
}

test('public locale seeds do not expose template, AI demo, or payment copy', async () => {
  const files = (await Promise.all(PUBLIC_LOCALE_ROOTS.map(collectPublicCopyFiles)))
    .flat()
    .sort();

  assert.ok(files.length > 0, 'expected public locale files to scan');

  const violations: string[] = [];
  for (const file of files) {
    const content = await readFile(file, 'utf8');
    const patterns = [
      ...FORBIDDEN_PUBLIC_INTERNAL_COPY,
      ...(file.endsWith('.json') ? FORBIDDEN_JSON_COPY : []),
    ];
    for (const pattern of patterns) {
      if (pattern.test(content)) {
        violations.push(`${file}: ${pattern}`);
      }
    }
  }

  assert.deepEqual(violations, []);
});
