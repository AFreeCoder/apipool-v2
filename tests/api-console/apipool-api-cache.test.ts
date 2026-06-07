import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const APIPOOL_API_ROUTES = [
  'src/app/api/apipool/keys/route.ts',
  'src/app/api/apipool/keys/[id]/route.ts',
  'src/app/api/apipool/keys/[id]/disable/route.ts',
  'src/app/api/apipool/usage/route.ts',
  'src/app/api/apipool/billing/route.ts',
  'src/app/api/apipool/admin/adjust-quota/route.ts',
];

test('authenticated APIPool API routes are dynamic and no-store', async () => {
  const violations: string[] = [];
  const cacheHelper = await readFile('src/shared/lib/http-cache.ts', 'utf8');

  for (const file of APIPOOL_API_ROUTES) {
    const source = await readFile(file, 'utf8');
    if (!/dynamic\s*=\s*'force-dynamic'/.test(source)) {
      violations.push(`${file}: missing force-dynamic`);
    }
    if (!/withNoStore/.test(source)) {
      violations.push(`${file}: missing withNoStore response wrapper`);
    }
  }

  if (!/X-Robots-Tag/.test(cacheHelper)) {
    violations.push('src/shared/lib/http-cache.ts: missing X-Robots-Tag');
  }
  if (!/noindex,\s*nofollow/.test(cacheHelper)) {
    violations.push('src/shared/lib/http-cache.ts: missing noindex, nofollow');
  }

  assert.deepEqual(violations, []);
});
