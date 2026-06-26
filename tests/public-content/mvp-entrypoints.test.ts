import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('MVP public entrypoints render APIPool product surfaces, not template pages', async () => {
  const home = await readFile(
    'src/app/[locale]/(landing)/page.tsx',
    'utf8'
  );
  const models = await readFile(
    'src/app/[locale]/(landing)/models/page.tsx',
    'utf8'
  );
  const docs = await readFile(
    'src/app/[locale]/(docs)/docs/[[...slug]]/page.tsx',
    'utf8'
  );

  assert.match(home, /APIPOOL_PUBLIC_CONFIG\.apiBaseUrl/);
  assert.match(home, /createQuickstartSnippets/);
  assert.match(home, /GatewayTopology/);
  assert.match(home, /href="\/dashboard"/);
  assert.match(home, /href="\/docs"/);
  assert.doesNotMatch(home, /DynamicPage|StaticPage|content\/posts/);

  assert.match(models, /publicModels/);
  assert.match(models, /parseModelFilters/);
  assert.match(models, /buildModelFilterHref/);
  assert.match(models, /PRICE_DISCLAIMER_/);
  assert.doesNotMatch(models, /models\/\[slug\]|DynamicPage|StaticPage/);

  assert.match(docs, /source\.getPage/);
  assert.match(docs, /generateStaticParams/);
  assert.match(docs, /generateMetadata/);
});

test('auth entrypoints pass only public configs to client components', async () => {
  const signIn = await readFile(
    'src/app/[locale]/(auth)/sign-in/page.tsx',
    'utf8'
  );
  const signUp = await readFile(
    'src/app/[locale]/(auth)/sign-up/page.tsx',
    'utf8'
  );

  for (const source of [signIn, signUp]) {
    assert.match(source, /getPublicConfigs/);
    assert.match(source, /safeInternalPath/);
    assert.match(source, /stripLocalePrefix/);
    assert.doesNotMatch(source, /getConfigs\(/);
    assert.doesNotMatch(source, /AUTH_SECRET|DATABASE_URL|NEWAPI_ADMIN_TOKEN/);
  }
});

test('MVP route shell keeps docs, landing, auth, dashboard, and admin separated', async () => {
  const landingLayout = await readFile(
    'src/app/[locale]/(landing)/layout.tsx',
    'utf8'
  );
  const docsLayout = await readFile(
    'src/app/[locale]/(docs)/layout.tsx',
    'utf8'
  );
  const authLayout = await readFile(
    'src/app/[locale]/(auth)/layout.tsx',
    'utf8'
  );
  const adminLayout = await readFile(
    'src/app/[locale]/(admin)/layout.tsx',
    'utf8'
  );

  assert.match(landingLayout, /SiteShell/);
  assert.doesNotMatch(landingLayout, /DashboardShell|Admin/);

  assert.match(docsLayout, /DocsLayout/);
  assert.doesNotMatch(docsLayout, /SiteShell|DashboardShell/);

  assert.match(authLayout, /children/);
  assert.doesNotMatch(authLayout, /DashboardShell|SiteShell/);

  assert.match(adminLayout, /Dashboard/);
  assert.match(adminLayout, /requireAdminAccess/);
});
