import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

const root = process.cwd();
const catalogRoot = join(root, 'src/app/[locale]/(admin)/admin/catalog');

const entities = [
  {
    route: 'vendors',
    list: 'getVendors',
    getById: 'getVendorById',
    create: 'createVendor',
    update: 'updateVendor',
    delete: 'deleteVendor',
  },
  {
    route: 'capabilities',
    list: 'getCapabilities',
    getById: 'getCapabilityById',
    create: 'createCapability',
    update: 'updateCapability',
    delete: 'deleteCapability',
  },
  {
    route: 'statuses',
    list: 'getStatuses',
    getById: 'getStatusById',
    create: 'createStatus',
    update: 'updateStatus',
    delete: 'deleteStatus',
  },
  {
    route: 'groups',
    list: 'getGroups',
    getById: 'getGroupById',
    create: 'createGroup',
    update: 'updateGroup',
    delete: 'deleteGroup',
  },
] as const;

function pagePath(route: string, page: 'list' | 'new' | 'edit') {
  if (page === 'list') return join(catalogRoot, route, 'page.tsx');
  if (page === 'new') return join(catalogRoot, route, 'new/page.tsx');
  return join(catalogRoot, route, '[id]/edit/page.tsx');
}

function callPattern(name: string) {
  return new RegExp(`\\b${name}\\s*\\(`);
}

function switchFieldPattern(name: string) {
  return new RegExp(
    `name:\\s*['"]${name}['"][\\s\\S]*?type:\\s*['"]switch['"]`
  );
}

function fieldPattern(name: string) {
  return new RegExp(`name:\\s*['"]${name}['"]`);
}

test('catalog dictionary admin pages exist with read/write permissions and i18n', async () => {
  for (const entity of entities) {
    const listPage = await readFile(pagePath(entity.route, 'list'), 'utf8');
    const newPage = await readFile(pagePath(entity.route, 'new'), 'utf8');
    const editPage = await readFile(pagePath(entity.route, 'edit'), 'utf8');

    assert.match(listPage, /PERMISSIONS\.CATALOG_READ/);
    assert.match(newPage, /PERMISSIONS\.CATALOG_WRITE/);
    assert.match(editPage, /PERMISSIONS\.CATALOG_WRITE/);

    for (const source of [listPage, newPage, editPage]) {
      assert.match(source, /getTranslations\(['"]admin\.catalog['"]\)/);
      assert.doesNotMatch(source, callPattern(entity.delete));
    }
  }
});

test('catalog dictionary pages use TableCard/FormCard and catalog service handlers', async () => {
  for (const entity of entities) {
    const listPage = await readFile(pagePath(entity.route, 'list'), 'utf8');
    const newPage = await readFile(pagePath(entity.route, 'new'), 'utf8');
    const editPage = await readFile(pagePath(entity.route, 'edit'), 'utf8');

    assert.match(listPage, /<TableCard[\s\S]*buttons=/);
    assert.match(listPage, callPattern(entity.list));
    assert.match(listPage, new RegExp(`admin/catalog/${entity.route}/new`));
    assert.match(
      listPage,
      new RegExp(`admin/catalog/${entity.route}/\\$\\{item\\.id\\}/edit`)
    );

    assert.match(newPage, /<FormCard/);
    assert.match(newPage, callPattern(entity.create));
    assert.match(newPage, /revalidateCatalog\s*\(/);
    assert.match(
      newPage,
      new RegExp(`redirect_url:\\s*['"]/admin/catalog/${entity.route}['"]`)
    );

    assert.match(editPage, /<FormCard/);
    assert.match(editPage, callPattern(entity.getById));
    assert.match(editPage, callPattern(entity.update));
    assert.match(editPage, /revalidateCatalog\s*\(/);
    assert.match(
      editPage,
      new RegExp(`redirect_url:\\s*['"]/admin/catalog/${entity.route}['"]`)
    );
  }
});

test('catalog status forms expose callable and public visibility switches', async () => {
  const newPage = await readFile(pagePath('statuses', 'new'), 'utf8');
  const editPage = await readFile(pagePath('statuses', 'edit'), 'utf8');

  for (const source of [newPage, editPage]) {
    assert.match(source, switchFieldPattern('isCallable'));
    assert.match(source, switchFieldPattern('isPublicVisible'));
  }
});

test('catalog group forms expose mapping, key creation, and immutable edit slug', async () => {
  const newPage = await readFile(pagePath('groups', 'new'), 'utf8');
  const editPage = await readFile(pagePath('groups', 'edit'), 'utf8');

  for (const source of [newPage, editPage]) {
    assert.match(source, fieldPattern('newapiGroup'));
    assert.match(source, switchFieldPattern('allowCreateKey'));
  }

  assert.match(
    editPage,
    /name:\s*['"]slug['"][\s\S]*?attributes:\s*\{\s*disabled:\s*true\s*\}/
  );
});

test('catalog admin locale files exist, parse, and share top-level keys', async () => {
  const en = JSON.parse(
    await readFile(
      join(root, 'src/config/locale/messages/en/admin/catalog.json'),
      'utf8'
    )
  );
  const zh = JSON.parse(
    await readFile(
      join(root, 'src/config/locale/messages/zh/admin/catalog.json'),
      'utf8'
    )
  );

  assert.deepEqual(Object.keys(en).sort(), Object.keys(zh).sort());
});
