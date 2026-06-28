import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const REQUIRED_LOCALE_NAMESPACES = [
  'site',
  'pages/home',
  'pages/models',
  'dashboard/common',
  'dashboard/overview',
  'dashboard/billing',
  'dashboard/usage',
  'dashboard/apiKeys',
];

const SOURCE_COPY_EXPECTATIONS: Array<{
  file: string;
  forbidden: string[];
}> = [
  {
    file: 'src/features/apipool-ui/site-shell.tsx',
    forbidden: [
      'Models & Pricing',
      "label: 'Docs'",
      'Console',
      'One API endpoint for frontier models.',
      'Product',
      'Legal',
      'Privacy Policy',
      'Terms of Service',
      'All rights reserved.',
      'built for developers',
    ],
  },
  {
    file: 'src/features/apipool-ui/mobile-nav.tsx',
    forbidden: ['Open menu', '<SheetTitle>Menu</SheetTitle>'],
  },
  {
    file: 'src/app/[locale]/(landing)/page.tsx',
    forbidden: [
      'One endpoint.',
      'Every frontier model.',
      'Start building',
      'Read the docs',
      'From agents to images',
      'Up and running in minutes',
      'Ship with one API today',
      'Open the console',
      'Browse models',
    ],
  },
  {
    file: 'src/app/[locale]/(landing)/models/page.tsx',
    forbidden: [
      'Models & pricing',
      'All prices are per 1M tokens',
      'Provider',
      'Capabilities',
      'No models match these filters.',
      'Clear filters',
      'Scroll horizontally to see context, pricing and status',
    ],
  },
  {
    file: 'src/app/[locale]/(landing)/dashboard/page.tsx',
    forbidden: [
      'Overview',
      'Keys, balance, and usage for the APIPool API.',
      'Add credit',
      'Create key',
      'Quickstart',
      'Recent requests',
      'No usage yet.',
    ],
  },
  {
    file: 'src/app/[locale]/(landing)/dashboard/api-keys/page.tsx',
    forbidden: ['Create real keys for the APIPool Base URL.'],
  },
  {
    file: 'src/app/[locale]/(landing)/dashboard/billing/page.tsx',
    forbidden: [
      'Usage is billed per token. Balance never expires.',
      'Current balance',
      'Credit history',
      'No credit activity yet.',
      'Usage charges',
      'No usage charges with synced spend yet.',
      'Order time',
      'Payment status',
      'Credit status',
    ],
  },
  {
    file: 'src/app/[locale]/(landing)/dashboard/usage/page.tsx',
    forbidden: [
      'Last 7 days',
      'Input tokens',
      'Output tokens',
      'Model distribution',
      'No model distribution synced yet.',
      'Request log',
      'No request logs synced yet.',
    ],
  },
  {
    file: 'src/features/api-console/components/api-key-manager.tsx',
    forbidden: [
      'API key creation is temporarily paused.',
      'Default APIPool key',
      'Select a group first.',
      'Key created. The full key is shown once below.',
      'Create API Key',
      'Key name',
      'Select a group',
      'Callable models',
      'No callable models',
      'Full key. This is shown once.',
      'Masked key',
      'No API keys yet.',
      'Copy masked key',
      'Disable key',
      'Delete key',
    ],
  },
];

test('locale detector is enabled by default and mounted once for all localized routes', async () => {
  const configSource = await readFile('src/config/index.ts', 'utf8');
  const localeLayout = await readFile('src/app/[locale]/layout.tsx', 'utf8');
  const landingLayout = await readFile(
    'src/app/[locale]/(landing)/layout.tsx',
    'utf8'
  );
  const adminLayout = await readFile(
    'src/app/[locale]/(admin)/layout.tsx',
    'utf8'
  );

  assert.match(
    configSource,
    /NEXT_PUBLIC_LOCALE_DETECT_ENABLED\s*\?\?\s*'true'/
  );
  assert.match(localeLayout, /<LocaleDetector \/>/);
  assert.match(localeLayout, /<NextIntlClientProvider key=\{locale\}>/);
  assert.doesNotMatch(landingLayout, /LocaleDetector/);
  assert.doesNotMatch(adminLayout, /LocaleDetector/);
});

test('locale detector banner copy comes from the common locale namespace', async () => {
  const detectorSource = await readFile(
    'src/shared/blocks/common/locale-detector.tsx',
    'utf8'
  );

  assert.match(detectorSource, /useTranslations\('common'\)/);
  assert.doesNotMatch(detectorSource, /We detected your browser language is/);
  assert.doesNotMatch(detectorSource, /检测到浏览器语言是:/);
  assert.doesNotMatch(detectorSource, /切换到中文/);
});

test('locale switchers strip any existing locale prefix before navigating', async () => {
  const [selectorSource, detectorSource, indexingSource] = await Promise.all([
    readFile('src/shared/blocks/common/locale-selector.tsx', 'utf8'),
    readFile('src/shared/blocks/common/locale-detector.tsx', 'utf8'),
    readFile('src/features/apipool-ui/lib/indexing.ts', 'utf8'),
  ]);

  assert.match(
    indexingSource,
    /export function normalizePathWithoutLocale\(pathname: string\)/
  );

  for (const source of [selectorSource, detectorSource]) {
    assert.match(source, /normalizePathWithoutLocale/);
    assert.match(
      source,
      /const normalizedPathname = normalizePathWithoutLocale\(pathname\)/
    );
    assert.match(source, /\$\{normalizedPathname\}\?\$\{query\}/);
  }
});

test('public and console locale namespaces are registered', async () => {
  const localeIndex = await readFile('src/config/locale/index.ts', 'utf8');

  for (const namespace of REQUIRED_LOCALE_NAMESPACES) {
    assert.match(localeIndex, new RegExp(`'${namespace}'`));
  }
});

test('main public and console pages no longer keep hard-coded English UI copy', async () => {
  const failures: string[] = [];

  for (const expectation of SOURCE_COPY_EXPECTATIONS) {
    const source = await readFile(expectation.file, 'utf8');

    for (const phrase of expectation.forbidden) {
      if (source.includes(phrase)) {
        failures.push(`${expectation.file}: ${phrase}`);
      }
    }
  }

  assert.deepEqual(failures, []);
});

test('models page localizes public catalog dimensions instead of echoing admin data names', async () => {
  const [source, enMessages, zhMessages] = await Promise.all([
    readFile('src/app/[locale]/(landing)/models/page.tsx', 'utf8'),
    readFile('src/config/locale/messages/en/pages/models.json', 'utf8'),
    readFile('src/config/locale/messages/zh/pages/models.json', 'utf8'),
  ]);
  const en = JSON.parse(enMessages);
  const zh = JSON.parse(zhMessages);

  assert.match(source, /localizeCatalogDimension/);
  assert.match(source, /t\.raw\(['"]dimensions['"]\)/);
  assert.match(source, /groupName:\s*localizeCatalogDimension/);
  assert.match(source, /statusName:\s*localizeCatalogDimension/);
  assert.match(source, /capabilities:\s*listing\.capabilities\.map/);

  assert.equal(en.dimensions.groups.official, 'Official');
  assert.equal(zh.dimensions.groups.official, '官方');
  assert.equal(en.dimensions.categories.llm, 'LLM');
  assert.equal(zh.dimensions.categories.llm, '大语言模型');
  assert.equal(en.dimensions.capabilities.text, 'Text');
  assert.equal(zh.dimensions.capabilities.text, '文本');
  assert.equal(en.dimensions.capabilities.vision, 'Vision');
  assert.equal(zh.dimensions.capabilities.vision, '视觉');
  assert.equal(en.dimensions.statuses.available, 'Available');
  assert.equal(zh.dimensions.statuses.available, '可用');
});

test('api key page localizes public group names instead of echoing admin data names', async () => {
  const [source, managerSource, enMessages, zhMessages] = await Promise.all([
    readFile('src/app/[locale]/(landing)/dashboard/api-keys/page.tsx', 'utf8'),
    readFile('src/features/api-console/components/api-key-manager.tsx', 'utf8'),
    readFile('src/config/locale/messages/en/dashboard/apiKeys.json', 'utf8'),
    readFile('src/config/locale/messages/zh/dashboard/apiKeys.json', 'utf8'),
  ]);
  const en = JSON.parse(enMessages);
  const zh = JSON.parse(zhMessages);

  assert.match(source, /localizeApiKeyGroupName/);
  assert.match(source, /t\.raw\(['"]groups['"]\)/);
  assert.match(source, /groups=\{localizedGroups\}/);
  assert.match(managerSource, /localizeApiKeyRowGroupName/);
  assert.match(managerSource, /key\.groupSlug/);

  assert.equal(en.groups.official, 'Official');
  assert.equal(zh.groups.official, '官方');
});

test('mobile navigation defers Radix sheet rendering until client mount', async () => {
  const source = await readFile(
    'src/features/apipool-ui/mobile-nav.tsx',
    'utf8'
  );

  assert.match(source, /useEffect/);
  assert.match(source, /const \[mounted,\s*setMounted\] = useState\(false\)/);
  assert.match(source, /setMounted\(true\)/);
  assert.match(source, /if \(!mounted\)/);
});

test('api key manager defers Radix select rendering until client mount', async () => {
  const source = await readFile(
    'src/features/api-console/components/api-key-manager.tsx',
    'utf8'
  );

  assert.match(source, /useEffect/);
  assert.match(source, /const \[mounted,\s*setMounted\] = useState\(false\)/);
  assert.match(source, /setMounted\(true\)/);
  assert.match(source, /mounted \?/);
});
