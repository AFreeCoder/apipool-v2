import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

const root = process.cwd();
const catalogRoot = join(root, 'src/app/[locale]/(admin)/admin/catalog');
const modelsRoot = join(catalogRoot, 'models');

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
  {
    route: 'categories',
    list: 'getCategories',
    getById: 'getCategoryById',
    create: 'createCategory',
    update: 'updateCategory',
    delete: 'deleteCategory',
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

function typedFieldPattern(name: string, type: string) {
  return new RegExp(
    `name:\\s*['"]${name}['"][\\s\\S]*?type:\\s*['"]${type}['"]`
  );
}

function disabledFieldPattern(name: string) {
  return new RegExp(
    `name:\\s*['"]${name}['"][\\s\\S]*?attributes:\\s*\\{\\s*disabled:\\s*true\\s*\\}`
  );
}

function modelPagePath(page: 'list' | 'new' | 'edit' | 'capabilities') {
  if (page === 'list') return join(modelsRoot, 'page.tsx');
  if (page === 'new') return join(modelsRoot, 'new/page.tsx');
  if (page === 'capabilities') {
    return join(modelsRoot, '[id]/capabilities/page.tsx');
  }
  return join(modelsRoot, '[id]/edit/page.tsx');
}

function listingPagePath(page: 'list' | 'new' | 'edit') {
  if (page === 'list') return join(modelsRoot, '[id]/listings/page.tsx');
  if (page === 'new') return join(modelsRoot, '[id]/listings/new/page.tsx');
  return join(modelsRoot, '[id]/listings/[listingId]/edit/page.tsx');
}

function collectKeyPaths(value: unknown, prefix = ''): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return prefix ? [prefix] : [];
  }

  return Object.entries(value as Record<string, unknown>).flatMap(
    ([key, child]) => collectKeyPaths(child, prefix ? `${prefix}.${key}` : key)
  );
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
    assert.match(source, /syncCatalogGroupToNewApi\s*\(\s*result\s*\)/);
  }

  assert.match(
    editPage,
    /name:\s*['"]slug['"][\s\S]*?attributes:\s*\{\s*disabled:\s*true\s*\}/
  );
});

test('catalog model pages expose admin catalog fields, candidate form, and listings entry points', async () => {
  const listPage = await readFile(modelPagePath('list'), 'utf8');
  const newPage = await readFile(modelPagePath('new'), 'utf8');
  const editPage = await readFile(modelPagePath('edit'), 'utf8');
  const capabilitiesPage = await readFile(
    modelPagePath('capabilities'),
    'utf8'
  );

  assert.match(listPage, /PERMISSIONS\.CATALOG_READ/);
  for (const source of [newPage, editPage, capabilitiesPage]) {
    assert.match(source, /PERMISSIONS\.CATALOG_WRITE/);
    assert.match(source, /getTranslations\(['"]admin\.catalog['"]\)/);
  }
  assert.match(listPage, /getTranslations\(['"]admin\.catalog['"]\)/);

  assert.match(listPage, /<TableCard[\s\S]*buttons=/);
  assert.match(listPage, callPattern('getModelAdminRows'));
  assert.match(listPage, /admin\/catalog\/models\/new/);
  assert.match(listPage, /admin\/catalog\/models\/\$\{item\.id\}\/edit/);
  assert.match(
    listPage,
    /admin\/catalog\/models\/\$\{item\.id\}\/capabilities/
  );
  assert.match(listPage, /admin\/catalog\/models\/\$\{item\.id\}\/listings/);
  for (const field of [
    'vendorName',
    'groupName',
    'categoryNames',
    'capabilityNames',
    'inputPrice',
    'outputPrice',
    'imageInputPrice',
    'imageOutputPrice',
    'discountRate',
  ]) {
    assert.match(listPage, new RegExp(`name:\\s*['"]${field}['"]`));
  }
  assert.doesNotMatch(listPage, /contextWindow/);

  for (const source of [newPage, editPage]) {
    assert.match(source, /<ModelAdminForm/);
    assert.doesNotMatch(source, /<FormCard/);
    assert.match(source, callPattern('getVendors'));
    assert.match(source, callPattern('getGroups'));
    assert.match(source, callPattern('getCategories'));
    assert.match(source, callPattern('getCapabilities'));
    assert.match(source, callPattern('getStatuses'));
    assert.match(source, callPattern('upsertModelAdminConfig'));
    assert.match(source, callPattern('optionalDollarsToMicroUsd'));
    assert.match(source, callPattern('discountFoldToBps'));
    assert.match(source, /JSON\.parse\(.*categoryIds/);
    assert.match(source, /JSON\.parse\(.*capabilityIds/);
    assert.doesNotMatch(source, fieldPattern('contextWindow'));
    assert.match(source, /revalidateCatalog\s*\(/);
  }
  assert.match(newPage, /redirect_url:\s*['"]\/admin\/catalog\/models['"]/);
  assert.match(newPage, /redirect_url:\s*['"]\/admin\/catalog\/models['"]/);
  assert.match(editPage, callPattern('getModelAdminConfig'));
  assert.match(editPage, /redirect_url:\s*['"]\/admin\/catalog\/models['"]/);

  assert.match(capabilitiesPage, /<FormCard/);
  assert.match(capabilitiesPage, callPattern('getModelById'));
  assert.match(capabilitiesPage, callPattern('getCapabilities'));
  assert.match(capabilitiesPage, callPattern('getModelCapabilities'));
  assert.match(capabilitiesPage, callPattern('setModelCapabilities'));
  assert.match(capabilitiesPage, typedFieldPattern('capabilities', 'checkbox'));
  assert.match(capabilitiesPage, /JSON\.parse\(capabilities\)/);
  assert.match(capabilitiesPage, /revalidateCatalog\s*\(/);
});

test('catalog listing child pages expose per-model sales item CRUD and immutable edit group', async () => {
  const listPage = await readFile(listingPagePath('list'), 'utf8');
  const newPage = await readFile(listingPagePath('new'), 'utf8');
  const editPage = await readFile(listingPagePath('edit'), 'utf8');

  assert.match(listPage, /PERMISSIONS\.CATALOG_READ/);
  for (const source of [newPage, editPage]) {
    assert.match(source, /PERMISSIONS\.CATALOG_WRITE/);
  }
  for (const source of [listPage, newPage, editPage]) {
    assert.match(source, /getTranslations\(['"]admin\.catalog['"]\)/);
  }

  assert.match(listPage, /<TableCard[\s\S]*buttons=/);
  assert.match(listPage, callPattern('getModelById'));
  assert.match(listPage, callPattern('getListingsByModel'));
  assert.match(listPage, callPattern('getGroups'));
  assert.match(listPage, callPattern('getStatuses'));
  assert.match(
    listPage,
    /admin\/catalog\/models\/\$\{model\.id\}\/listings\/new/
  );
  assert.match(
    listPage,
    /admin\/catalog\/models\/\$\{model\.id\}\/listings\/\$\{item\.id\}\/edit/
  );
  assert.match(listPage, /name:\s*['"]listInputPrice['"]/);
  assert.match(listPage, /name:\s*['"]listOutputPrice['"]/);
  assert.match(listPage, /name:\s*['"]discountNote['"]/);
  assert.match(listPage, /name:\s*['"]description['"]/);

  for (const source of [newPage, editPage]) {
    assert.match(source, /<FormCard/);
    assert.match(source, callPattern('getModelById'));
    assert.match(source, callPattern('getGroups'));
    assert.match(source, callPattern('getStatuses'));
    assert.match(source, typedFieldPattern('groupId', 'select'));
    assert.match(source, typedFieldPattern('statusId', 'select'));
    assert.match(source, typedFieldPattern('inputMicroUsd', 'number'));
    assert.match(source, typedFieldPattern('outputMicroUsd', 'number'));
    assert.match(source, typedFieldPattern('listInputMicroUsd', 'number'));
    assert.match(source, typedFieldPattern('listOutputMicroUsd', 'number'));
    assert.match(source, typedFieldPattern('discountNote', 'text'));
    assert.match(source, typedFieldPattern('description', 'textarea'));
    assert.match(source, switchFieldPattern('smokeTested'));
    assert.match(source, typedFieldPattern('sortOrder', 'number'));
    assert.match(source, callPattern('dollarsToMicroUsd'));
    assert.match(source, /t\(['"]errors\.invalidPrice['"]\)/);
    assert.match(source, /Number\.isFinite/);
    assert.match(source, /revalidateCatalog\s*\(/);
  }
  assert.match(newPage, callPattern('createListing'));
  assert.match(
    newPage,
    /redirect_url:\s*`\/admin\/catalog\/models\/\$\{model\.id\}\/listings`/
  );
  assert.match(editPage, callPattern('getListingById'));
  assert.match(editPage, callPattern('updateListing'));
  assert.match(editPage, callPattern('microUsdToDollars'));
  assert.match(editPage, disabledFieldPattern('groupId'));
  assert.match(
    editPage,
    /redirect_url:\s*`\/admin\/catalog\/models\/\$\{model\.id\}\/listings`/
  );
});

test('catalog sidebar exposes model catalog group in both locales', async () => {
  const en = JSON.parse(
    await readFile(
      join(root, 'src/config/locale/messages/en/admin/sidebar.json'),
      'utf8'
    )
  );
  const zh = JSON.parse(
    await readFile(
      join(root, 'src/config/locale/messages/zh/admin/sidebar.json'),
      'utf8'
    )
  );

  const expectedUrls = [
    '/admin/catalog/vendors',
    '/admin/catalog/groups',
    '/admin/catalog/categories',
    '/admin/catalog/capabilities',
    '/admin/catalog/statuses',
    '/admin/catalog/models',
  ];

  const enCatalog = en.main_navs.find(
    (group: { title: string }) => group.title === 'Model Catalog'
  );
  const zhCatalog = zh.main_navs.find(
    (group: { title: string }) => group.title === '模型目录'
  );

  assert.ok(enCatalog);
  assert.ok(zhCatalog);
  for (const catalog of [enCatalog, zhCatalog]) {
    assert.deepEqual(
      catalog.items[0].children.map((item: { url: string }) => item.url),
      expectedUrls
    );
    assert.ok(
      catalog.items[0].children.every((item: { icon?: string }) => item.icon)
    );
  }
});

test('legacy categories admin route redirects to catalog models', async () => {
  const categoriesPage = await readFile(
    join(root, 'src/app/[locale]/(admin)/admin/categories/page.tsx'),
    'utf8'
  );

  assert.match(
    categoriesPage,
    /redirect\(\{\s*href:\s*['"]\/admin\/catalog\/models['"],\s*locale\s*\}\)/
  );
});

test('catalog model search route requires catalog write permission and hides raw New API response', async () => {
  const source = await readFile(
    join(root, 'src/app/api/apipool/admin/catalog/models/search/route.ts'),
    'utf8'
  );

  assert.match(source, /hasPermission\s*\(/);
  assert.match(source, /PERMISSIONS\.CATALOG_WRITE/);
  assert.match(source, /createNewApiClient\s*\(/);
  assert.match(source, /listPricingModels\s*\(/);
  assert.match(source, /respData\s*\(\s*\{\s*models/);
  assert.doesNotMatch(source, /respData\s*\(\s*pricing/);
});

test('publicModels remains only as a documented test fixture', async () => {
  const catalogSource = await readFile(
    join(root, 'src/features/api-catalog/lib/catalog.ts'),
    'utf8'
  );

  assert.match(
    catalogSource,
    /publicModels[\s\S]{0,240}test fixture[\s\S]{0,240}queries\.ts/
  );
});

test('catalog admin locale files exist, parse, and share nested keys', async () => {
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

  assert.deepEqual(collectKeyPaths(en).sort(), collectKeyPaths(zh).sort());
});
