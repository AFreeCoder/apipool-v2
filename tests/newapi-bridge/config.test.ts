import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

async function collectSourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) return collectSourceFiles(fullPath);
      if (/\.(ts|tsx)$/.test(entry.name)) return [fullPath];
      return [];
    })
  );

  return files.flat();
}

test('New API bridge base URL has no public production fallback', async () => {
  const config = await readFile(
    join(process.cwd(), 'src/config/apipool/index.ts'),
    'utf8'
  );
  const envExample = await readFile(
    join(process.cwd(), '.env.example'),
    'utf8'
  );
  const contract = await readFile(
    join(process.cwd(), 'docs/04-newapi-bridge-contract.md'),
    'utf8'
  );
  const readme = await readFile(join(process.cwd(), 'README.md'), 'utf8');

  assert.match(
    config,
    /newApiBaseUrl:\s*process\.env\.NEWAPI_BASE_URL\s*\?\?\s*''/
  );
  assert.doesNotMatch(
    config,
    /newApiBaseUrl:[\s\S]*https:\/\/newapi\.apipool\.dev/
  );
  assert.match(
    envExample,
    /NEWAPI_BASE_URL\s*=\s*"http:\/\/newapi-internal:3000"/
  );
  assert.doesNotMatch(
    envExample,
    /NEWAPI_BASE_URL\s*=\s*"https:\/\/newapi\.apipool\.dev"/
  );
  assert.match(
    contract,
    /`NEWAPI_BASE_URL`:[^\n]*`http:\/\/newapi-internal:3000`/
  );
  assert.doesNotMatch(
    contract,
    /`NEWAPI_BASE_URL`:[^\n]*https:\/\/newapi\.apipool\.dev/
  );
  assert.match(readme, /NEWAPI_BASE_URL=http:\/\/newapi-internal:3000/);
  assert.doesNotMatch(readme, /NEWAPI_BASE_URL=https:\/\/newapi\.apipool\.dev/);
  assert.match(contract, /Bind portal user[\s\S]*`initialQuotaUsd: 0`/);
});

test('client modules import only public APIPool config', async () => {
  const files = await collectSourceFiles(join(process.cwd(), 'src'));
  const violations: string[] = [];

  for (const file of files) {
    const source = await readFile(file, 'utf8');
    if (!/^\s*['"]use client['"]/.test(source)) continue;
    if (/from\s+['"]@\/config\/apipool(?:\/index)?['"]/.test(source)) {
      violations.push(file.replace(`${process.cwd()}/`, ''));
    }
  }

  assert.deepEqual(violations, []);
});
