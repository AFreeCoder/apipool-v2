import assert from 'node:assert/strict';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

const PUBLIC_DIR = join(process.cwd(), 'public');

const REMOVED_TEMPLATE_DIRS = [
  'imgs/avatars',
  'imgs/bg',
  'imgs/cases',
  'imgs/features',
  'imgs/logos',
];

const REMOVED_DEFAULT_BRAND_FILES = [
  'logo.png',
  'favicon.ico',
  'preview.png',
  'logo.svg',
  'favicon.svg',
  'preview.svg',
];

const LEGACY_BRAND_PATTERN = new RegExp('Ship' + 'Any', 'i');

async function exists(path: string) {
  return Boolean(await stat(path).catch(() => null));
}

async function listFiles(path: string): Promise<string[]> {
  const entry = await stat(path).catch(() => null);
  if (!entry) return [];
  if (entry.isFile()) return [path];

  const children = await readdir(path);
  const nested = await Promise.all(
    children.map((child) => listFiles(join(path, child)))
  );
  return nested.flat();
}

test('public brand images are not shipped until the APIPool logo is finalized', async () => {
  for (const relativePath of REMOVED_DEFAULT_BRAND_FILES) {
    assert.equal(
      await exists(join(PUBLIC_DIR, relativePath)),
      false,
      relativePath
    );
  }
});

test('default config does not point SEO or chrome at placeholder brand images', async () => {
  const configSource = await readFile('src/config/index.ts', 'utf8');
  const seoSource = await readFile('src/shared/lib/seo.ts', 'utf8');

  assert.match(configSource, /app_logo:[^\n]*\?\? ''/);
  assert.match(configSource, /app_favicon:[^\n]*\?\? ''/);
  assert.match(configSource, /app_preview_image:[^\n]*\?\? ''/);
  assert.match(
    seoSource,
    /\.\.\.\(imageUrl \? \{ images: \[imageUrl\] \} : \{\}\)/
  );
});

test('unused legacy template image directories are not shipped publicly', async () => {
  for (const relativeDir of REMOVED_TEMPLATE_DIRS) {
    assert.equal(
      await exists(join(PUBLIC_DIR, relativeDir)),
      false,
      relativeDir
    );
  }
});

test('remaining public files do not contain legacy brand copy', async () => {
  const files = await listFiles(PUBLIC_DIR);
  const textFiles = files.filter((file) =>
    /\.(svg|xml|txt|json|html?)$/.test(file)
  );
  const violations: string[] = [];

  for (const file of textFiles) {
    const source = await readFile(file, 'utf8');
    if (LEGACY_BRAND_PATTERN.test(source)) {
      violations.push(file);
    }
  }

  assert.deepEqual(violations, []);
});
