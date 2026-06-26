import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('Next build keeps standalone output for deploys but skips it on Windows', async () => {
  const nextConfig = await readFile('next.config.mjs', 'utf8');
  const dockerfile = await readFile('Dockerfile', 'utf8');

  assert.match(
    nextConfig,
    /const shouldBuildStandalone = !process\.env\.VERCEL && process\.platform !== 'win32';/
  );
  assert.match(nextConfig, /output: shouldBuildStandalone \? 'standalone' : undefined/);
  assert.match(nextConfig, /\.\.\.\(shouldBuildStandalone\s*\?/);
  assert.match(nextConfig, /outputFileTracingIncludes/);
  assert.match(dockerfile, /\/app\/\.next\/standalone/);
});
