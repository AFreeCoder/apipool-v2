import assert from 'node:assert/strict';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { localeMessagesPaths, locales } from '@/config/locale';

const messagesRoot = join(process.cwd(), 'src/config/locale/messages');
const baselineLocale = 'en';

async function collectJsonFiles(dir: string, base = dir): Promise<string[]> {
  const entry = await stat(dir).catch(() => null);
  if (!entry) return [];
  if (entry.isFile()) {
    return dir.endsWith('.json')
      ? [dir.slice(base.length + 1).replace(/\\/g, '/')]
      : [];
  }

  const children = await readdir(dir);
  const nested = await Promise.all(
    children.map((child) => collectJsonFiles(join(dir, child), base))
  );
  return nested.flat().sort();
}

async function readJson(locale: string, relativePath: string) {
  const source = await readFile(join(messagesRoot, locale, relativePath), 'utf8');
  return JSON.parse(source);
}

function collectShape(value: unknown, prefix = '$'): string[] {
  if (Array.isArray(value)) {
    if (value.length === 0) return [`${prefix}:array`];
    return value
      .flatMap((item, index) => collectShape(item, `${prefix}[${index}]`))
      .sort();
  }

  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(
      ([left], [right]) => left.localeCompare(right)
    );
    if (entries.length === 0) return [`${prefix}:object`];
    return entries
      .flatMap(([key, nested]) => collectShape(nested, `${prefix}.${key}`))
      .sort();
  }

  return [prefix];
}

test('all locale message directories mirror the English file inventory', async () => {
  const localeDirs = (await readdir(messagesRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const baselineFiles = await collectJsonFiles(
    join(messagesRoot, baselineLocale)
  );

  assert.ok(localeDirs.includes(baselineLocale));
  assert.ok(baselineFiles.length > 0);

  for (const locale of localeDirs) {
    assert.deepEqual(
      await collectJsonFiles(join(messagesRoot, locale)),
      baselineFiles,
      `${locale} should keep the same locale JSON files as ${baselineLocale}`
    );
  }
});

test('locale JSON files are parseable and keep the same key shape', async () => {
  const localeDirs = (await readdir(messagesRoot, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const baselineFiles = await collectJsonFiles(
    join(messagesRoot, baselineLocale)
  );

  for (const relativePath of baselineFiles) {
    const baselineShape = collectShape(
      await readJson(baselineLocale, relativePath)
    );

    for (const locale of localeDirs) {
      assert.deepEqual(
        collectShape(await readJson(locale, relativePath)),
        baselineShape,
        `${locale}/${relativePath} should match ${baselineLocale} key shape`
      );
    }
  }
});

test('configured runtime locale bundles exist for every routed locale', async () => {
  for (const locale of locales) {
    for (const messagePath of localeMessagesPaths) {
      const fullPath = join(messagesRoot, locale, `${messagePath}.json`);
      const file = await stat(fullPath).catch(() => null);

      assert.ok(file?.isFile(), `${locale}/${messagePath}.json should exist`);
      JSON.parse(await readFile(fullPath, 'utf8'));
    }
  }
});
