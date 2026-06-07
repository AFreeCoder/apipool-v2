import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('portal API key creation has a rollback kill switch', async () => {
  const files = {
    config: await readFile('src/config/apipool/index.ts', 'utf8'),
    route: await readFile('src/app/api/apipool/keys/route.ts', 'utf8'),
    page: await readFile(
      'src/app/[locale]/(landing)/dashboard/api-keys/page.tsx',
      'utf8'
    ),
    component: await readFile(
      'src/features/api-console/components/api-key-manager.tsx',
      'utf8'
    ),
    envExample: await readFile('.env.example', 'utf8'),
    readme: await readFile('README.md', 'utf8'),
  };

  assert.match(files.config, /isPortalKeyCreationEnabled/);
  assert.match(files.config, /APIPOOL_KEY_CREATION_ENABLED/);
  assert.match(files.route, /assertPortalApiKeyCreationEnabled/);
  assert.match(
    files.page,
    /creationEnabled=\{APIPOOL_CONFIG\.isPortalKeyCreationEnabled\}/
  );
  assert.match(files.component, /creationEnabled/);
  assert.match(files.component, /disabled=\{loading\s*\|\|\s*!creationEnabled\}/);
  assert.match(files.envExample, /APIPOOL_KEY_CREATION_ENABLED\s*=\s*"true"/);
  assert.match(files.readme, /APIPOOL_KEY_CREATION_ENABLED=false/);
});
