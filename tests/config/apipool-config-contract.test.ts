import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { APIPOOL_PUBLIC_CONFIG } from '@/config/apipool/public';

test('APIPool public config defaults match the MVP public surface', () => {
  assert.deepEqual(APIPOOL_PUBLIC_CONFIG, {
    brandName: 'APIPool',
    siteUrl: 'https://apipool.dev',
    apiBaseUrl: 'https://api.apipool.dev/v1',
    supportEmail: 'support@apipool.dev',
    defaultLaunchModel: 'gpt-4o-mini',
  });
});

test('public APIPool config does not read server-only New API secrets', async () => {
  const source = await readFile('src/config/apipool/public.ts', 'utf8');

  assert.doesNotMatch(source, /NEWAPI/i);
  assert.doesNotMatch(source, /ADMIN_TOKEN|AUTH_SECRET|DATABASE_URL/);
  assert.match(source, /NEXT_PUBLIC_APIPOOL_API_BASE_URL/);
});

test('server APIPool config owns rollback switches and New API internals', async () => {
  const source = await readFile('src/config/apipool/index.ts', 'utf8');

  assert.match(source, /NEWAPI_BASE_URL/);
  assert.match(source, /NEWAPI_INTEGRATION_ENABLED/);
  assert.match(source, /APIPOOL_KEY_CREATION_ENABLED/);
  assert.match(source, /isPortalKeyCreationEnabled/);
});
