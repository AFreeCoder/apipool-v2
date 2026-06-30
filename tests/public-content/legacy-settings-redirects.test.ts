import assert from 'node:assert/strict';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

const legacySettingsRedirects = [
  {
    file: 'src/app/[locale]/(landing)/settings/page.tsx',
    destination: '/dashboard',
  },
  {
    file: 'src/app/[locale]/(landing)/settings/profile/page.tsx',
    destination: '/dashboard',
  },
  {
    file: 'src/app/[locale]/(landing)/settings/security/page.tsx',
    destination: '/dashboard',
  },
  {
    file: 'src/app/[locale]/(landing)/settings/apikeys/page.tsx',
    destination: '/dashboard/api-keys',
  },
  {
    file: 'src/app/[locale]/(landing)/settings/apikeys/create/page.tsx',
    destination: '/dashboard/api-keys',
  },
  {
    file: 'src/app/[locale]/(landing)/settings/apikeys/[id]/edit/page.tsx',
    destination: '/dashboard/api-keys',
  },
  {
    file: 'src/app/[locale]/(landing)/settings/apikeys/[id]/delete/page.tsx',
    destination: '/dashboard/api-keys',
  },
  {
    file: 'src/app/[locale]/(landing)/settings/payments/page.tsx',
    destination: '/dashboard/billing',
  },
  {
    file: 'src/app/[locale]/(landing)/settings/credits/page.tsx',
    destination: '/dashboard/billing',
  },
  {
    file: 'src/app/[locale]/(landing)/settings/billing/page.tsx',
    destination: '/dashboard/billing',
  },
  {
    file: 'src/app/[locale]/(landing)/settings/billing/cancel/page.tsx',
    destination: '/dashboard/billing',
  },
  {
    file: 'src/app/[locale]/(landing)/settings/billing/retrieve/page.tsx',
    destination: '/dashboard/billing',
  },
  {
    file: 'src/app/[locale]/(landing)/settings/invoices/retrieve/page.tsx',
    destination: '/dashboard/billing',
  },
];

test('legacy template settings pages redirect into the APIPool dashboard surface', async () => {
  for (const item of legacySettingsRedirects) {
    const source = await readFile(item.file, 'utf8');

    assert.match(source, /redirect/);
    assert.match(source, new RegExp(`href:\\s*['"]${item.destination}`));
    assert.doesNotMatch(source, /FormCard|PanelCard|updateUser/);
  }
});

test('legacy settings layout does not render the old settings console shell', async () => {
  const source = await readFile(
    'src/app/[locale]/(landing)/settings/layout.tsx',
    'utf8'
  );

  assert.doesNotMatch(source, /ConsoleLayout|settings\.sidebar/);
});

async function collectJsonFiles(path: string): Promise<string[]> {
  const entry = await stat(path).catch(() => null);
  if (!entry) return [];
  if (entry.isFile()) return path.endsWith('.json') ? [path] : [];

  const children = await readdir(path);
  const nested = await Promise.all(
    children.map((child) => collectJsonFiles(join(path, child)))
  );
  return nested.flat();
}

test('shared user navigation does not link to legacy settings pages', async () => {
  const files = [
    'src/shared/blocks/sign/sign-user.tsx',
    ...(await collectJsonFiles('src/config/locale/messages')),
  ];

  const violations: string[] = [];
  for (const file of files) {
    const source = await readFile(file, 'utf8');
    if (/["']\/settings(?:\/[A-Za-z0-9_-]+)?["']/.test(source)) {
      violations.push(file);
    }
  }

  assert.deepEqual(violations, []);
});
