import assert from 'node:assert/strict';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

const PUBLIC_LOCALE_ROOTS = [
  join(process.cwd(), 'src/config/locale/messages/en/landing.json'),
  join(process.cwd(), 'src/config/locale/messages/zh/landing.json'),
  join(process.cwd(), 'src/config/locale/messages/zh-CN/landing.json'),
  join(process.cwd(), 'src/config/locale/messages/zh-TW/landing.json'),
  join(process.cwd(), 'src/config/locale/messages/en/pages'),
  join(process.cwd(), 'src/config/locale/messages/zh/pages'),
  join(process.cwd(), 'src/config/locale/messages/zh-CN/pages'),
  join(process.cwd(), 'src/config/locale/messages/zh-TW/pages'),
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

const PUBLIC_MDX_LOCALE_GROUPS = [
  [
    'content/docs/index.mdx',
    [
      'content/docs/index.zh-CN.mdx',
      'content/docs/index.zh.mdx',
      'content/docs/index.zh-TW.mdx',
    ],
  ],
  [
    'content/pages/privacy-policy.mdx',
    [
      'content/pages/privacy-policy.zh-CN.mdx',
      'content/pages/privacy-policy.zh.mdx',
      'content/pages/privacy-policy.zh-TW.mdx',
    ],
  ],
  [
    'content/pages/terms-of-service.mdx',
    [
      'content/pages/terms-of-service.zh-CN.mdx',
      'content/pages/terms-of-service.zh.mdx',
      'content/pages/terms-of-service.zh-TW.mdx',
    ],
  ],
] as const;

const ZH_TW_MDX_EXPECTATIONS = [
  {
    file: 'content/docs/index.zh-TW.mdx',
    includes: ['幾分鐘內建立 API Key', '儲值', '餘額永不過期'],
    excludes: ['几分钟内创建', '充值', '余额永不过期'],
  },
  {
    file: 'content/pages/privacy-policy.zh-TW.mdx',
    includes: ['隱私政策', '個人資料', 'API 閘道'],
    excludes: ['隐私政策', '个人数据', 'API 网关'],
  },
  {
    file: 'content/pages/terms-of-service.zh-TW.mdx',
    includes: ['服務條款', '智慧財產權', '電子通訊'],
    excludes: ['服务条款', '知识产权', '电子通信'],
  },
] as const;

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

test('localized public MDX pages mirror the English heading structure', async () => {
  for (const [baseline, localizedFiles] of PUBLIC_MDX_LOCALE_GROUPS) {
    const baselineHeadings = (await readFile(join(process.cwd(), baseline), 'utf8'))
      .split(/\r?\n/)
      .filter((line) => /^#{2,3} /.test(line))
      .map((line) => line.match(/^#+/)?.[0].length);

    for (const localizedFile of localizedFiles) {
      const localizedHeadings = (
        await readFile(join(process.cwd(), localizedFile), 'utf8')
      )
        .split(/\r?\n/)
        .filter((line) => /^#{2,3} /.test(line))
        .map((line) => line.match(/^#+/)?.[0].length);

      assert.deepEqual(
        localizedHeadings,
        baselineHeadings,
        `${localizedFile} should mirror ${baseline} heading levels`
      );
    }
  }
});

test('traditional Chinese public MDX pages are not simplified copies', async () => {
  for (const { file, includes, excludes } of ZH_TW_MDX_EXPECTATIONS) {
    const content = await readFile(join(process.cwd(), file), 'utf8');

    for (const expected of includes) {
      assert.match(content, new RegExp(expected), `${file} should include ${expected}`);
    }

    for (const unexpected of excludes) {
      assert.doesNotMatch(
        content,
        new RegExp(unexpected),
        `${file} should not include simplified copy: ${unexpected}`
      );
    }
  }
});
