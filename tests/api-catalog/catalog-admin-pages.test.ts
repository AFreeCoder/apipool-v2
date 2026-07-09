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

function pagePath(route: string, page: 'list' | 'new' | 'edit' | 'delete') {
  if (page === 'list') return join(catalogRoot, route, 'page.tsx');
  if (page === 'new') return join(catalogRoot, route, 'new/page.tsx');
  if (page === 'delete') return join(catalogRoot, route, '[id]/delete/page.tsx');
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

function modelPagePath(
  page: 'list' | 'new' | 'edit' | 'delete' | 'capabilities'
) {
  if (page === 'list') return join(modelsRoot, 'page.tsx');
  if (page === 'new') return join(modelsRoot, 'new/page.tsx');
  if (page === 'capabilities') {
    return join(modelsRoot, '[id]/capabilities/page.tsx');
  }
  if (page === 'delete') return join(modelsRoot, '[id]/delete/page.tsx');
  return join(modelsRoot, '[id]/edit/page.tsx');
}

function listingPagePath(page: 'list' | 'new' | 'edit' | 'delete') {
  if (page === 'list') return join(modelsRoot, '[id]/listings/page.tsx');
  if (page === 'new') return join(modelsRoot, '[id]/listings/new/page.tsx');
  if (page === 'delete') {
    return join(modelsRoot, '[id]/listings/[listingId]/delete/page.tsx');
  }
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
    const deletePage = await readFile(
      pagePath(entity.route, 'delete'),
      'utf8'
    );

    assert.match(listPage, /PERMISSIONS\.CATALOG_READ/);
    assert.match(newPage, /PERMISSIONS\.CATALOG_WRITE/);
    assert.match(editPage, /PERMISSIONS\.CATALOG_WRITE/);
    assert.match(deletePage, /PERMISSIONS\.CATALOG_WRITE/);

    for (const source of [listPage, newPage, editPage, deletePage]) {
      assert.match(source, /getTranslations\(['"]admin\.catalog['"]\)/);
    }
  }
});

test('catalog dictionary pages use TableCard/FormCard and catalog service handlers', async () => {
  for (const entity of entities) {
    const listPage = await readFile(pagePath(entity.route, 'list'), 'utf8');
    const newPage = await readFile(pagePath(entity.route, 'new'), 'utf8');
    const editPage = await readFile(pagePath(entity.route, 'edit'), 'utf8');
    const deletePage = await readFile(
      pagePath(entity.route, 'delete'),
      'utf8'
    );

    assert.match(listPage, /<TableCard[\s\S]*buttons=/);
    assert.match(listPage, callPattern(entity.list));
    assert.match(listPage, new RegExp(`admin/catalog/${entity.route}/new`));
    assert.match(
      listPage,
      new RegExp(`admin/catalog/${entity.route}/\\$\\{item\\.id\\}/edit`)
    );
    assert.match(
      listPage,
      new RegExp(`admin/catalog/${entity.route}/\\$\\{item\\.id\\}/delete`)
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
    assert.match(editPage, disabledFieldPattern('slug'));

    assert.match(deletePage, /<FormCard/);
    assert.match(deletePage, callPattern(entity.getById));
    assert.match(deletePage, callPattern(entity.delete));
    assert.match(deletePage, /CatalogDeleteBlockedError/);
    assert.match(deletePage, /delete\.blocked/);
    assert.match(deletePage, /errors\.deleteFailed/);
    assert.match(deletePage, /variant:\s*['"]destructive['"]/);
    assert.match(deletePage, /actions=\{\[/);
    assert.match(
      deletePage,
      new RegExp(`${entity.route}\\.delete\\.buttons\\.cancel`)
    );
    assert.match(deletePage, /icon:\s*['"]ArrowLeft['"]/);
    assert.match(
      deletePage,
      new RegExp(`\\burl:\\s*['"]/admin/catalog/${entity.route}['"]`)
    );
    assert.match(deletePage, /revalidateCatalog\s*\(/);
    assert.match(
      deletePage,
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

test('catalog group forms expose mapping and key creation controls', async () => {
  const newPage = await readFile(pagePath('groups', 'new'), 'utf8');
  const editPage = await readFile(pagePath('groups', 'edit'), 'utf8');

  for (const source of [newPage, editPage]) {
    assert.match(source, fieldPattern('newapiGroup'));
    assert.match(source, switchFieldPattern('allowCreateKey'));
  }
});

test('catalog model pages expose admin catalog fields, candidate form, and listings entry points', async () => {
  const listPage = await readFile(modelPagePath('list'), 'utf8');
  const pricingControls = await readFile(
    join(modelsRoot, 'pricing-sync-controls.tsx'),
    'utf8'
  );
  const modelForm = await readFile(
    join(modelsRoot, 'model-admin-form.tsx'),
    'utf8'
  );
  const newPage = await readFile(modelPagePath('new'), 'utf8');
  const editPage = await readFile(modelPagePath('edit'), 'utf8');
  const deletePage = await readFile(modelPagePath('delete'), 'utf8');
  const capabilitiesPage = await readFile(
    modelPagePath('capabilities'),
    'utf8'
  );

  assert.match(listPage, /PERMISSIONS\.CATALOG_READ/);
  for (const source of [newPage, editPage, deletePage, capabilitiesPage]) {
    assert.match(source, /PERMISSIONS\.CATALOG_WRITE/);
    assert.match(source, /getTranslations\(['"]admin\.catalog['"]\)/);
  }
  assert.match(listPage, /getTranslations\(['"]admin\.catalog['"]\)/);

  assert.match(listPage, /<TableCard[\s\S]*buttons=/);
  assert.match(listPage, /<CatalogPricingSyncControls/);
  assert.match(listPage, callPattern('getModelAdminRows'));
  assert.match(listPage, /admin\/catalog\/models\/new/);
  assert.match(listPage, /admin\/catalog\/models\/\$\{item\.id\}\/edit/);
  assert.match(
    listPage,
    /admin\/catalog\/models\/\$\{item\.id\}\/capabilities/
  );
  assert.match(listPage, /admin\/catalog\/models\/\$\{item\.id\}\/listings/);
  assert.match(listPage, /admin\/catalog\/models\/\$\{item\.id\}\/delete/);
  for (const field of [
    'vendorName',
    'categoryNames',
    'capabilityNames',
    'inputPrice',
    'outputPrice',
    'imageInputPrice',
    'imageOutputPrice',
  ]) {
    assert.match(listPage, new RegExp(`name:\\s*['"]${field}['"]`));
  }
  for (const hiddenField of ['groupName', 'discountRate', 'pricingStatus']) {
    assert.doesNotMatch(
      listPage,
      new RegExp(`name:\\s*['"]${hiddenField}['"]`)
    );
  }
  assert.doesNotMatch(listPage, /contextWindow/);

  for (const source of [newPage, editPage]) {
    assert.match(source, /<ModelAdminForm/);
    assert.doesNotMatch(source, /<FormCard/);
    assert.match(source, callPattern('getVendors'));
    assert.match(source, callPattern('getCategories'));
    assert.match(source, callPattern('getCapabilities'));
    assert.match(source, callPattern('getStatuses'));
    assert.match(source, callPattern('upsertModelAdminConfig'));
    assert.match(source, callPattern('optionalDollarsToMicroUsd'));
    assert.match(source, /JSON\.parse\(.*categoryIds/);
    assert.match(source, /JSON\.parse\(.*capabilityIds/);
    assert.doesNotMatch(source, fieldPattern('contextWindow'));
    assert.match(source, /revalidateCatalog\s*\(/);
  }
  assert.match(newPage, callPattern('getGroups'));
  assert.match(editPage, callPattern('getGroups'));
  for (const hiddenField of [
    'groupId',
    'discountFold',
    'discountNote',
    'description',
  ]) {
    assert.match(modelForm, new RegExp(`name="${hiddenField}"`));
  }
  assert.match(newPage, /redirect_url:\s*['"]\/admin\/catalog\/models['"]/);
  assert.match(newPage, /redirect_url:\s*['"]\/admin\/catalog\/models['"]/);
  assert.match(editPage, callPattern('getModelAdminConfig'));
  assert.match(editPage, /redirect_url:\s*['"]\/admin\/catalog\/models['"]/);

  assert.match(deletePage, /<FormCard/);
  assert.match(deletePage, callPattern('getModelById'));
  assert.match(deletePage, callPattern('getListingsByModel'));
  assert.match(deletePage, callPattern('deleteModel'));
  assert.match(deletePage, /variant:\s*['"]destructive['"]/);
  assert.match(deletePage, /revalidateCatalog\s*\(/);
  assert.match(deletePage, /redirect_url:\s*['"]\/admin\/catalog\/models['"]/);

  assert.match(pricingControls, /\/api\/apipool\/admin\/catalog\/pricing\/sync/);
  assert.match(pricingControls, /\/api\/apipool\/admin\/catalog\/pricing\/drift/);
  assert.match(pricingControls, /useState<['"]sync['"] \| ['"]drift['"] \| null>/);
  assert.match(pricingControls, /labels\.success/);
  assert.match(pricingControls, /labels\.error/);
  assert.doesNotMatch(pricingControls, /NEWAPI|NEW_API|admin-token|Bearer|internal|newapiGroup/);

  assert.match(capabilitiesPage, /<FormCard/);
  assert.match(capabilitiesPage, callPattern('getModelById'));
  assert.match(capabilitiesPage, callPattern('getCapabilities'));
  assert.match(capabilitiesPage, callPattern('getModelCapabilities'));
  assert.match(capabilitiesPage, callPattern('setModelCapabilities'));
  assert.match(capabilitiesPage, typedFieldPattern('capabilities', 'checkbox'));
  assert.match(capabilitiesPage, /JSON\.parse\(capabilities\)/);
  assert.match(capabilitiesPage, /revalidateCatalog\s*\(/);
});

test('catalog pricing sync and drift admin routes require permissions and call pricing services', async () => {
  const syncRoute = await readFile(
    join(root, 'src/app/api/apipool/admin/catalog/pricing/sync/route.ts'),
    'utf8'
  );
  const driftRoute = await readFile(
    join(root, 'src/app/api/apipool/admin/catalog/pricing/drift/route.ts'),
    'utf8'
  );

  assert.match(syncRoute, /admin\.catalog\.write/);
  assert.match(syncRoute, /getPricingSnapshot\s*\(/);
  assert.match(syncRoute, /syncPricing:\s*syncCatalogPricingFromSnapshot/);
  assert.match(syncRoute, /routeDeps\.syncPricing\s*\(/);
  assert.match(syncRoute, /revalidate:\s*revalidateCatalog/);
  assert.match(syncRoute, /routeDeps\.revalidate\s*\(/);
  assert.doesNotMatch(syncRoute, /newapiGroup/);

  assert.match(driftRoute, /admin\.catalog\.read/);
  assert.match(driftRoute, /buildReport:\s*buildCatalogPriceDriftReport/);
  assert.match(driftRoute, /routeDeps\.buildReport\s*\(/);
  assert.doesNotMatch(driftRoute, /newapiGroup/);
});

test('catalog listing child pages expose per-model group discount CRUD with the smoke toggle', async () => {
  const listPage = await readFile(listingPagePath('list'), 'utf8');
  const newPage = await readFile(listingPagePath('new'), 'utf8');
  const editPage = await readFile(listingPagePath('edit'), 'utf8');
  const deletePage = await readFile(listingPagePath('delete'), 'utf8');

  assert.match(listPage, /PERMISSIONS\.CATALOG_READ/);
  for (const source of [newPage, editPage, deletePage]) {
    assert.match(source, /PERMISSIONS\.CATALOG_WRITE/);
  }
  for (const source of [listPage, newPage, editPage, deletePage]) {
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
  assert.match(
    listPage,
    /admin\/catalog\/models\/\$\{model\.id\}\/listings\/\$\{item\.id\}\/delete/
  );
  assert.match(listPage, /name:\s*['"]groupSlug['"]/);
  assert.match(listPage, /name:\s*['"]groupName['"]/);
  assert.match(listPage, /name:\s*['"]discountRate['"]/);
  assert.match(listPage, /name:\s*['"]discountNote['"]/);
  assert.match(listPage, /name:\s*['"]description['"]/);
  for (const hiddenColumn of [
    'inputPrice',
    'outputPrice',
    'listInputPrice',
    'listOutputPrice',
    'smokeTested',
    'sortOrder',
  ]) {
    assert.doesNotMatch(
      listPage,
      new RegExp(`name:\\s*['"]${hiddenColumn}['"]`)
    );
  }

  for (const source of [newPage, editPage]) {
    assert.match(source, /<FormCard/);
    assert.match(source, callPattern('getModelById'));
    assert.match(source, callPattern('getGroups'));
    assert.match(source, callPattern('getStatuses'));
    assert.match(source, typedFieldPattern('groupId', 'select'));
    assert.match(source, typedFieldPattern('statusId', 'select'));
    assert.match(source, typedFieldPattern('discountFold', 'number'));
    assert.match(source, typedFieldPattern('discountNote', 'text'));
    assert.match(source, typedFieldPattern('description', 'textarea'));
    // smokeTested 是运维标记：没有入口时新模型永远进不了部署冒烟候选池
    assert.match(source, switchFieldPattern('smokeTested'));
    assert.match(source, /t\(['"]fields\.smokeTestedTip['"]\)/);
    for (const hiddenField of [
      'inputMicroUsd',
      'outputMicroUsd',
      'listInputMicroUsd',
      'listOutputMicroUsd',
      'sortOrder',
    ]) {
      assert.doesNotMatch(source, typedFieldPattern(hiddenField, 'number'));
    }
    assert.match(source, /revalidateCatalog\s*\(/);
  }
  assert.match(newPage, callPattern('createListing'));
  assert.match(newPage, /baseInputMicroUsd/);
  assert.match(newPage, /defaultListing/);
  assert.match(newPage, /missingBasePriceMessage/);
  assert.match(newPage, /t\(['"]errors\.missingBasePrice['"]\)/);
  assert.match(newPage, callPattern('requiredBasePrice'));
  assert.doesNotMatch(newPage, /\?\?\s*0/);
  assert.match(
    newPage,
    /redirect_url:\s*`\/admin\/catalog\/models\/\$\{model\.id\}\/listings`/
  );
  assert.match(editPage, callPattern('getListingById'));
  assert.match(editPage, callPattern('updateListing'));
  assert.match(editPage, /pricePolicy:\s*listing\.pricePolicy/);
  assert.match(editPage, /featured:\s*listing\.featured/);
  assert.match(editPage, /sortOrder:\s*listing\.sortOrder/);
  assert.match(editPage, disabledFieldPattern('groupId'));
  assert.match(
    editPage,
    /redirect_url:\s*`\/admin\/catalog\/models\/\$\{model\.id\}\/listings`/
  );

  assert.match(deletePage, /<FormCard/);
  assert.match(deletePage, callPattern('getModelById'));
  assert.match(deletePage, callPattern('getListingById'));
  assert.match(deletePage, callPattern('deleteListing'));
  assert.match(deletePage, /variant:\s*['"]destructive['"]/);
  assert.match(deletePage, /revalidateCatalog\s*\(/);
  assert.match(
    deletePage,
    /redirect_url:\s*`\/admin\/catalog\/models\/\$\{targetModel\.id\}\/listings`/
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
  assert.match(source, /getGroupById\s*\(/);
  assert.match(source, /searchParams\.get\(['"]groupId['"]\)/);
  assert.match(source, /respData\s*\(\s*\{\s*models/);
  assert.doesNotMatch(source, /respData\s*\(\s*pricing/);
});

test('catalog model candidate form surfaces empty and error states', async () => {
  const source = await readFile(
    join(modelsRoot, 'model-admin-form.tsx'),
    'utf8'
  );

  assert.match(source, /searchError/);
  assert.match(
    source,
    /new URLSearchParams\(\{\s*vendorId,\s*groupId,\s*keyword\s*\}\)/
  );
  assert.match(source, /messages\.noCandidates/);
  assert.match(source, /setSearchError\s*\(/);
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

  assert.equal(en.listings.list.title, 'Group Discounts');
  assert.equal(en.listings.list.crumb, 'Group Discounts');
  assert.equal(en.actions.listings, 'Group Discounts');
  assert.match(en.models.delete.description, /group discounts/);
  assert.equal(zh.listings.list.title, '分组折扣');
  assert.equal(zh.listings.list.crumb, '分组折扣');
  assert.equal(zh.actions.listings, '分组折扣');
  assert.match(zh.models.delete.description, /分组折扣/);
  assert.equal(en.fields.groupSlug, 'Group ID');
  assert.equal(zh.fields.groupSlug, '分组 ID');
  assert.ok(en.fields.smokeTested);
  assert.ok(zh.fields.smokeTested);
  assert.ok(en.fields.smokeTestedTip);
  assert.ok(zh.fields.smokeTestedTip);
  assert.ok(en.listings.delete);
  assert.ok(zh.listings.delete);
  assert.ok(en.errors.missingBasePrice);
  assert.ok(zh.errors.missingBasePrice);
  assert.equal(en.fields.pricingStatus, undefined);
  assert.equal(zh.fields.pricingStatus, undefined);

  assert.deepEqual(collectKeyPaths(en).sort(), collectKeyPaths(zh).sort());
});

test('listing forms expose the smoke-tested switch so new models can enter the smoke candidate pool', async () => {
  const { readFile } = await import('node:fs/promises');

  // ede2dc4 把开关从两个表单都删掉且无替代入口，新模型的 smoke_tested 永远是
  // false → getSmokeTestedCallableModelIdsByGroup 返回空 → 部署冒烟直接抛错。
  for (const page of [
    'src/app/[locale]/(admin)/admin/catalog/models/[id]/listings/new/page.tsx',
    'src/app/[locale]/(admin)/admin/catalog/models/[id]/listings/[listingId]/edit/page.tsx',
  ]) {
    const source = await readFile(page, 'utf8');
    assert.match(source, /name: 'smokeTested'/, `${page} needs the switch`);
    assert.match(
      source,
      /smokeTested: data\.get\('smokeTested'\) === 'true'/,
      `${page} must read the switch instead of hardcoding`
    );
    assert.doesNotMatch(source, /smokeTested: false,/);
  }
});

test('creating a duplicate listing surfaces a translated message, not a raw constraint error', async () => {
  const { readFile } = await import('node:fs/promises');
  const page = await readFile(
    'src/app/[locale]/(admin)/admin/catalog/models/[id]/listings/new/page.tsx',
    'utf8'
  );

  assert.match(page, /uniq_listing_model_group/);
  assert.match(page, /duplicateListingMessage/);

  for (const locale of ['en', 'zh']) {
    const messages = JSON.parse(
      await readFile(
        `src/config/locale/messages/${locale}/admin/catalog.json`,
        'utf8'
      )
    );
    assert.ok(messages.errors?.duplicateListing, `${locale} duplicateListing`);
    assert.ok(messages.fields?.smokeTested, `${locale} fields.smokeTested`);
  }
});

test('saving a model warns that the public price is now hidden until a price sync runs', async () => {
  const { readFile } = await import('node:fs/promises');

  for (const page of [
    'src/app/[locale]/(admin)/admin/catalog/models/[id]/edit/page.tsx',
    'src/app/[locale]/(admin)/admin/catalog/models/new/page.tsx',
  ]) {
    const source = await readFile(page, 'utf8');
    assert.match(source, /messages\.priceHiddenAfterSave/, page);
  }

  for (const locale of ['en', 'zh']) {
    const messages = JSON.parse(
      await readFile(
        `src/config/locale/messages/${locale}/admin/catalog.json`,
        'utf8'
      )
    );
    assert.ok(messages.messages?.priceHiddenAfterSave, locale);
  }
});

test('an unset group discount stays null instead of being written back as 10000 bps', async () => {
  const { readFile } = await import('node:fs/promises');

  for (const page of [
    'src/app/[locale]/(admin)/admin/catalog/models/[id]/edit/page.tsx',
    'src/app/[locale]/(admin)/admin/catalog/models/[id]/listings/new/page.tsx',
  ]) {
    const source = await readFile(page, 'utf8');
    // `|| '10'` 会把「没有折扣」写成「十折」——语义等价但脏了数据
    assert.doesNotMatch(source, /bpsToDiscountFold\([^)]*\) \|\| '10'/, page);
  }
});
