import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const customerApiRoutes = [
  {
    file: 'src/app/api/apipool/keys/route.ts',
    required: [
      'getUserInfo',
      'withNoStore',
      'getPublicPortalErrorMessage',
      'assertPortalApiKeyCreationEnabled',
      'sanitizePortalApiKeyCreateInput',
      'createPortalApiKey',
      'listPortalApiKeys',
    ],
  },
  {
    file: 'src/app/api/apipool/keys/[id]/route.ts',
    required: [
      'getUserInfo',
      'withNoStore',
      'getPublicPortalErrorMessage',
      'deletePortalApiKey(user.id, id)',
    ],
  },
  {
    file: 'src/app/api/apipool/keys/[id]/disable/route.ts',
    required: [
      'getUserInfo',
      'withNoStore',
      'getPublicPortalErrorMessage',
      'disablePortalApiKey(user.id, id)',
    ],
  },
  {
    file: 'src/app/api/apipool/usage/route.ts',
    required: [
      'getUserInfo',
      'withNoStore',
      'getPublicPortalErrorMessage',
      'getPortalUsage',
    ],
  },
  {
    file: 'src/app/api/apipool/billing/route.ts',
    required: [
      'getUserInfo',
      'withNoStore',
      'getPublicPortalErrorMessage',
      'getPortalUsage',
      'listLedgerEntries',
      'buildBillingUsageCharges',
    ],
  },
];

const adminApiRoutes = [
  'src/app/api/apipool/admin/adjust-quota/route.ts',
  'src/app/api/apipool/admin/recharge/retry/route.ts',
  'src/app/api/apipool/admin/recharge/reconciliation/route.ts',
];

test('customer APIPool API routes require auth, no-store, and public errors', async () => {
  for (const route of customerApiRoutes) {
    const source = await readFile(route.file, 'utf8');

    assert.match(source, /export const dynamic = ['"]force-dynamic['"]/);
    assert.match(source, /no auth, please sign in/, route.file);
    for (const token of route.required) {
      assert.match(
        source,
        new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
        route.file
      );
    }
    assert.doesNotMatch(source, /NEWAPI_ADMIN_TOKEN|newapiKeyId|newapiUserId/);
  }
});

test('operator APIPool API routes enforce RBAC before side effects', async () => {
  for (const file of adminApiRoutes) {
    const source = await readFile(file, 'utf8');

    assert.match(source, /getUserInfo/);
    assert.match(source, /hasPermission/);
    assert.match(source, /PERMISSIONS\.APIPOOL_QUOTA_ADJUST/);
    assert.match(source, /withNoStore/);
    assert.match(source, /getPublicPortalErrorMessage/);
    assert.match(source, /permission required/);
  }
});

test('dashboard pages use bridge DTOs and keep unauthenticated fallbacks empty', async () => {
  const overview = await readFile(
    'src/app/[locale]/(landing)/dashboard/page.tsx',
    'utf8'
  );
  const apiKeys = await readFile(
    'src/app/[locale]/(landing)/dashboard/api-keys/page.tsx',
    'utf8'
  );
  const usage = await readFile(
    'src/app/[locale]/(landing)/dashboard/usage/page.tsx',
    'utf8'
  );
  const billing = await readFile(
    'src/app/[locale]/(landing)/dashboard/billing/page.tsx',
    'utf8'
  );
  const layout = await readFile(
    'src/app/[locale]/(landing)/dashboard/layout.tsx',
    'utf8'
  );

  assert.match(layout, /getUserInfo/);
  assert.match(layout, /redirect\(\{\s*href:\s*['"]\/sign-in['"]/);
  assert.match(layout, /DashboardShell/);

  assert.match(overview, /getPortalUsage\(user as any, ['"]7d['"]\)/);
  assert.match(overview, /listPortalApiKeys\(user\.id\)/);
  assert.match(overview, /EMPTY_USAGE/);

  assert.match(apiKeys, /listPortalApiKeys\(user\.id\)/);
  assert.match(apiKeys, /isPortalKeyCreationEnabled/);
  assert.match(apiKeys, /JSON\.parse\(JSON\.stringify\(keys\)\)/);

  assert.match(usage, /getPortalUsage\(user as any, ['"]7d['"]\)/);
  assert.match(usage, /status:\s*['"]empty['"] as const/);

  assert.match(billing, /listLedgerEntries\(user\.id\)/);
  assert.match(billing, /buildBillingUsageCharges\(usage\)/);
  assert.match(billing, /TopUpPackages/);

  for (const source of [overview, apiKeys, usage, billing]) {
    assert.doesNotMatch(source, /newapiUserId|newapiKeyId|NEWAPI_ADMIN_TOKEN/);
  }
});

test('console client components call only portal APIs and guard invalid key actions', async () => {
  const keyManager = await readFile(
    'src/features/api-console/components/api-key-manager.tsx',
    'utf8'
  );
  const topUps = await readFile(
    'src/features/api-console/components/top-up-packages.tsx',
    'utf8'
  );
  const quotaForm = await readFile(
    'src/features/api-console/components/admin/quota-adjustment-form.tsx',
    'utf8'
  );

  assert.match(keyManager, /fetch\(['"]\/api\/apipool\/keys['"]/);
  assert.match(keyManager, /canDisableKeyStatus/);
  assert.match(keyManager, /canDeleteKeyStatus/);
  assert.match(keyManager, /APIPOOL_PUBLIC_CONFIG\.defaultLaunchModel/);
  assert.doesNotMatch(keyManager, /newapi|NEWAPI_ADMIN_TOKEN/i);

  assert.match(topUps, /fetch\(['"]\/api\/payment\/checkout['"]/);
  assert.match(topUps, /currency:\s*['"]USD['"]/);
  assert.doesNotMatch(topUps, /stripe|creem|paypal/i);

  assert.match(quotaForm, /fetch\(['"]\/api\/apipool\/admin\/adjust-quota['"]/);
  assert.match(quotaForm, /portalUserId/);
  assert.match(quotaForm, /amountUsd:\s*Number\(amountUsd\)/);
});
