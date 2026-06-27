import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { createClient } from '@libsql/client';

const root = process.cwd();
const settingsPagePath = join(
  root,
  'src/app/[locale]/(admin)/admin/settings/[tab]/page.tsx'
);
const sidebarEnPath = join(
  root,
  'src/config/locale/messages/en/admin/sidebar.json'
);
const sidebarZhPath = join(
  root,
  'src/config/locale/messages/zh/admin/sidebar.json'
);
const settingsEnPath = join(
  root,
  'src/config/locale/messages/en/admin/settings.json'
);
const settingsZhPath = join(
  root,
  'src/config/locale/messages/zh/admin/settings.json'
);
const authConfigPath = join(root, 'src/core/auth/config.ts');
const signUpPath = join(root, 'src/shared/blocks/sign/sign-up.tsx');
const signUpFormPath = join(root, 'src/shared/blocks/sign/sign-up-form.tsx');
const verifyEmailPath = join(root, 'src/shared/blocks/sign/verify-email.tsx');

let configModel: typeof import('@/shared/models/config');
let settingsService: typeof import('@/shared/services/settings');

function createTestIncrementalCache() {
  const cache = new Map<string, unknown>();

  return {
    isOnDemandRevalidate: false,
    async generateCacheKey(key: string) {
      return key;
    },
    async get(key: string) {
      return cache.get(key) ?? null;
    },
    async set(key: string, value: unknown) {
      cache.set(key, value);
    },
    async revalidateTag() {},
  };
}

async function runWithNextCache<T>(fn: () => Promise<T>) {
  const { workAsyncStorage } = await import(
    'next/dist/server/app-render/work-async-storage.external'
  );

  return workAsyncStorage.run(
    {
      page: '/admin/settings/[tab]/page',
      route: '/admin/settings/[tab]',
      incrementalCache: createTestIncrementalCache(),
      cacheLifeProfiles: {},
      pendingRevalidatedTags: [],
      previouslyRevalidatedTags: [],
      pendingRevalidates: {},
      pendingRevalidateWrites: [],
      pathWasRevalidated: false,
      isOnDemandRevalidate: false,
      isDraftMode: false,
      fetchCache: 'default-cache',
      nextFetchId: 1,
      buildId: 'settings-page-test',
    } as any,
    fn
  );
}

async function setupDb() {
  (globalThis as any).AsyncLocalStorage ??= AsyncLocalStorage;

  const dbPath = join(root, '.tmp', 'settings-page.db');
  await mkdir(join(root, '.tmp'), { recursive: true });
  await rm(dbPath, { force: true });

  process.env.DATABASE_PROVIDER = 'sqlite';
  process.env.DATABASE_URL = `file:${dbPath}`;
  process.env.DB_SCHEMA_FILE = './src/config/db/schema.sqlite.ts';
  process.env.DB_SINGLETON_ENABLED = 'false';

  const client = createClient({ url: `file:${dbPath}` });
  const migrationsDir = join(root, 'src/config/db/migrations_sqlite');
  for (const file of (await readdir(migrationsDir))
    .filter((name) => name.endsWith('.sql'))
    .sort()) {
    await client.executeMultiple(
      await readFile(join(migrationsDir, file), 'utf8')
    );
  }
  client.close();

  configModel = await import('@/shared/models/config');
  settingsService = await import('@/shared/services/settings');
}

function namesForTab(
  settings: Awaited<ReturnType<typeof settingsService.getSettings>>,
  tab: string
) {
  return new Set(
    settings
      .filter((setting) => setting.tab === tab)
      .map((setting) => setting.name)
  );
}

function collectKeyPaths(value: unknown, prefix = ''): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return prefix ? [prefix] : [];
  }

  return Object.entries(value as Record<string, unknown>).flatMap(
    ([key, child]) => collectKeyPaths(child, prefix ? `${prefix}.${key}` : key)
  );
}

async function loadCollectNonEmptyConfigs(source: string) {
  const start = source.indexOf('export function collectNonEmptyConfigs');
  const end = source.indexOf('\n\nexport default', start);
  assert.notEqual(start, -1, 'collectNonEmptyConfigs export should exist');
  assert.notEqual(end, -1, 'collectNonEmptyConfigs should precede page export');

  const snippet = source.slice(start, end);
  const ts = await import('typescript');
  const output = ts.transpileModule(
    `${snippet}\nexports.collectNonEmptyConfigs = collectNonEmptyConfigs;`,
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    }
  ).outputText;
  const module = { exports: {} as Record<string, unknown> };

  new Function('exports', 'module', output)(module.exports, module);
  return module.exports.collectNonEmptyConfigs as (
    data: FormData,
    settings: { name: string }[]
  ) => Record<string, string>;
}

test.before(setupDb);

test('settings service exposes auth and email fields for tab filtering', async () => {
  const settings = await settingsService.getSettings();
  const authNames = namesForTab(settings, 'auth');
  const emailNames = namesForTab(settings, 'email');

  for (const name of [
    'google_client_id',
    'google_client_secret',
    'github_client_id',
    'github_client_secret',
  ]) {
    assert.ok(authNames.has(name), `auth tab should include ${name}`);
  }
  assert.equal(
    authNames.has('email_verification_enabled'),
    false,
    'auth tab should leave email verification delivery settings to the email tab'
  );

  for (const name of [
    'resend_api_key',
    'resend_sender_email',
    'email_verification_enabled',
  ]) {
    assert.ok(emailNames.has(name), `email tab should include ${name}`);
  }
});

test('email settings document verification-link delivery check', async () => {
  const settings = await settingsService.getSettings();
  const emailVerification = settings.find(
    (setting) => setting.name === 'email_verification_enabled'
  );

  assert.equal(emailVerification?.tab, 'email');
  assert.equal(emailVerification?.group, 'resend');
  assert.match(
    emailVerification?.tip ?? '',
    /verification link/i,
    'email verification setting should tell admins how to check link delivery'
  );
});

test('email verification flow sends links instead of custom code inputs', async () => {
  const [authConfig, signUp, signUpForm, verifyEmail] = await Promise.all([
    readFile(authConfigPath, 'utf8'),
    readFile(signUpPath, 'utf8'),
    readFile(signUpFormPath, 'utf8'),
    readFile(verifyEmailPath, 'utf8'),
  ]);

  assert.match(authConfig, /sendVerificationEmail/);
  assert.match(signUp, /sendVerificationEmail/);
  assert.match(signUpForm, /sendVerificationEmail/);
  assert.match(verifyEmail, /sendVerificationEmail/);

  for (const source of [authConfig, signUp, signUpForm, verifyEmail]) {
    assert.doesNotMatch(source, /verification-code|VerificationCode/);
  }
});

test('saveConfigs persists values that getAllConfigs can read back', async () => {
  await runWithNextCache(async () => {
    await configModel.saveConfigs({
      google_client_id: 'settings-page-google-client-id',
    });

    const configs = await configModel.getAllConfigs();
    assert.equal(configs.google_client_id, 'settings-page-google-client-id');
  });
});

test('settings page exports a collector that skips empty submitted values', async () => {
  const source = await readFile(settingsPagePath, 'utf8');
  assert.match(source, /export function collectNonEmptyConfigs/);
  const collectNonEmptyConfigs = await loadCollectNonEmptyConfigs(source);

  const formData = new FormData();
  formData.set('google_client_id', 'google-client-id');
  formData.set('google_client_secret', '');
  formData.set('github_client_secret', '   ');
  formData.set('email_verification_enabled', 'false');
  formData.set('ignored', 'value');

  assert.deepEqual(
    collectNonEmptyConfigs(formData, [
      { name: 'google_client_id' },
      { name: 'google_client_secret' },
      { name: 'github_client_secret' },
      { name: 'email_verification_enabled' },
    ]),
    {
      google_client_id: 'google-client-id',
      email_verification_enabled: 'false',
    }
  );
});

test('settings page is wired back to FormCard and config save flow', async () => {
  const source = await readFile(settingsPagePath, 'utf8');

  assert.doesNotMatch(
    source,
    /redirect\(\{\s*href:\s*['"]\/admin\/apipool-adjustments['"]/
  );
  assert.match(source, /PERMISSIONS\.SETTINGS_READ/);
  assert.match(source, /getSettingTabs/);
  assert.match(source, /getSettings/);
  assert.match(source, /getAllConfigs/);
  assert.match(source, /saveConfigs/);
  assert.match(source, /<FormCard/);
  assert.match(source, /collectNonEmptyConfigs/);
});

test('admin sidebar links to auth and email settings with matching locale shapes', async () => {
  const sidebarEn = JSON.parse(await readFile(sidebarEnPath, 'utf8'));
  const sidebarZh = JSON.parse(await readFile(sidebarZhPath, 'utf8'));
  const sidebarEnSource = JSON.stringify(sidebarEn);
  const sidebarZhSource = JSON.stringify(sidebarZh);

  assert.match(sidebarEnSource, /\/admin\/settings\/auth/);
  assert.match(sidebarEnSource, /\/admin\/settings\/email/);
  assert.match(sidebarZhSource, /\/admin\/settings\/auth/);
  assert.match(sidebarZhSource, /\/admin\/settings\/email/);
  assert.deepEqual(collectKeyPaths(sidebarEn), collectKeyPaths(sidebarZh));

  const settingsEn = JSON.parse(await readFile(settingsEnPath, 'utf8'));
  const settingsZh = JSON.parse(await readFile(settingsZhPath, 'utf8'));
  assert.deepEqual(collectKeyPaths(settingsEn), collectKeyPaths(settingsZh));
});
