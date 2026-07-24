import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { buildFieldSchema } from '@/shared/blocks/form/schema';

const root = process.cwd();

function read(path: string) {
  return readFile(join(root, path), 'utf8');
}

function getByPath(obj: any, path: string) {
  return path.split('.').reduce((current, key) => current?.[key], obj);
}

function collectKeyPaths(value: unknown, prefix = ''): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return prefix ? [prefix] : [];
  }
  return Object.entries(value as Record<string, unknown>).flatMap(
    ([key, child]) => collectKeyPaths(child, prefix ? `${prefix}.${key}` : key)
  );
}

// ---- S-15a: required checkbox schema rejects the empty array ----

test('a required checkbox field rejects an empty selection', () => {
  const schema = buildFieldSchema({
    name: 'roles',
    type: 'checkbox',
    title: 'Roles',
    options: [{ title: 'Admin', value: 'admin' }],
    validation: { required: true },
  });

  const empty = schema.safeParse([]);
  assert.equal(
    empty.success,
    false,
    'empty array must fail a required checkbox'
  );
  if (!empty.success) {
    assert.equal(empty.error.issues[0].message, 'Roles is required');
  }

  assert.equal(schema.safeParse(['admin']).success, true);
});

test('a required checkbox honors a custom validation message', () => {
  const schema = buildFieldSchema({
    name: 'permissions',
    type: 'checkbox',
    title: 'Permissions',
    validation: { required: true, message: 'Pick at least one permission' },
  });

  const result = schema.safeParse([]);
  assert.equal(result.success, false);
  if (!result.success) {
    assert.equal(
      result.error.issues[0].message,
      'Pick at least one permission'
    );
  }
});

test('an optional checkbox still accepts an empty selection', () => {
  const schema = buildFieldSchema({
    name: 'tags',
    type: 'checkbox',
    title: 'Tags',
  });

  assert.equal(schema.safeParse([]).success, true);
});

// ---- S-15b: edit-roles warns when an admin edits their own roles ----

test('edit-roles page warns on self-edit and surfaces business errors as returns', async () => {
  const source = await read(
    'src/app/[locale]/(admin)/admin/users/[id]/edit-roles/page.tsx'
  );

  assert.match(source, /getUserInfo/);
  assert.match(source, /isEditingSelf/);
  assert.match(source, /edit_roles\.self_edit_warning/);
  // Business errors return instead of throwing (production masks thrown errors).
  assert.doesNotMatch(
    source,
    /throw new Error\('(user not found|invalid roles)'\)/
  );
  assert.match(source, /status:\s*'error'\s*as const/);
  // Server-side allowlist validation is preserved.
  assert.match(source, /!allowedRoleIds\.has\(roleId\)/);
});

// ---- S-20: table / copy default strings come from i18n ----

test('table block localizes its default empty state', async () => {
  const source = await read('src/shared/blocks/table/index.tsx');

  assert.match(source, /getTranslations\(['"]admin\.common['"]\)/);
  assert.match(source, /table\.empty/);
  assert.doesNotMatch(source, /'No records found\.'/);
});

test('table copy toast localizes its default confirmation', async () => {
  const source = await read('src/shared/blocks/table/copy.tsx');

  assert.match(source, /useTranslations\(['"]admin\.common['"]\)/);
  assert.match(source, /table\.copied/);
  assert.doesNotMatch(source, /\?\?\s*'Copied'/);
});

// ---- S-22: read-only admins get a disabled submit + notice ----

test('settings page disables saving and shows a notice for read-only admins', async () => {
  const source = await read(
    'src/app/[locale]/(admin)/admin/settings/[tab]/page.tsx'
  );

  assert.match(source, /hasPermission/);
  assert.match(source, /PERMISSIONS\.SETTINGS_WRITE/);
  assert.match(source, /const\s+canWrite\s*=/);
  assert.match(source, /disabled:\s*!canWrite/);
  assert.match(source, /settings\.readonly/);
  // The intentional secret-skip protection must stay untouched.
  assert.match(source, /collectNonEmptyConfigs/);
  assert.match(source, /if \(setting\.type === 'password'\) continue/);
});

test('shared form button honors an optional disabled flag', async () => {
  const source = await read('src/shared/blocks/form/index.tsx');
  assert.match(source, /disabled\?: boolean/);
  assert.match(source, /loading \|\|/);
});

// ---- i18n key presence & parity ----

test('admin/common locale files add table + settings copy in both locales', async () => {
  const en = JSON.parse(
    await read('src/config/locale/messages/en/admin/common.json')
  );
  const zh = JSON.parse(
    await read('src/config/locale/messages/zh/admin/common.json')
  );

  for (const key of ['table.empty', 'table.copied', 'settings.readonly']) {
    assert.equal(typeof getByPath(en, key), 'string', `en missing ${key}`);
    assert.equal(typeof getByPath(zh, key), 'string', `zh missing ${key}`);
  }
  assert.deepEqual(collectKeyPaths(en), collectKeyPaths(zh));
});

test('admin/users locale files add the new filter/role/message keys in both locales', async () => {
  const en = JSON.parse(
    await read('src/config/locale/messages/en/admin/users.json')
  );
  const zh = JSON.parse(
    await read('src/config/locale/messages/zh/admin/users.json')
  );

  for (const key of [
    'list.filters.all',
    'edit_roles.self_edit_warning',
    'messages.updateFailed',
    'messages.invalidRoles',
  ]) {
    assert.equal(typeof getByPath(en, key), 'string', `en missing ${key}`);
    assert.equal(typeof getByPath(zh, key), 'string', `zh missing ${key}`);
    assert.equal(
      getByPath(en, key).includes('admin.users.'),
      false,
      `en ${key} must not be a raw key path`
    );
  }
});
