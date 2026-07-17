import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { createClient } from '@libsql/client';

import { isUniqueConstraintError } from '@/features/api-catalog/lib/errors';

// 覆盖 admin-review S-6~S-11 修复的运行时断言。静态（页面文本）断言见文件末尾。
let modules: any;

async function setupDb() {
  const dbPath = join(process.cwd(), '.tmp', 'catalog-admin-review-fixes.db');
  await mkdir(join(process.cwd(), '.tmp'), { recursive: true });
  await rm(dbPath, { force: true });

  process.env.DATABASE_PROVIDER = 'sqlite';
  process.env.DATABASE_URL = `file:${dbPath}`;
  process.env.DB_SCHEMA_FILE = './src/config/db/schema.sqlite.ts';
  process.env.DB_SINGLETON_ENABLED = 'false';

  const client = createClient({ url: `file:${dbPath}` });
  const migrationsDir = join(process.cwd(), 'src/config/db/migrations_sqlite');
  for (const file of (await readdir(migrationsDir))
    .filter((name) => name.endsWith('.sql'))
    .sort()) {
    await client.executeMultiple(
      await readFile(join(migrationsDir, file), 'utf8')
    );
  }

  const schema = await import('@/config/db/schema');
  const { db } = await import('@/core/db');
  const service = await import('@/features/api-catalog/server/catalog-service');
  modules = { db, schema, service };
}

async function seedDimensions(suffix: string) {
  const vendor = await modules.service.createVendor({
    slug: `vendor-${suffix}`,
    name: `Vendor ${suffix}`,
    sortOrder: 10,
    status: 'active',
  });
  const status = await modules.service.createStatus({
    slug: `status-${suffix}`,
    name: `Status ${suffix}`,
    isCallable: true,
    isPublicVisible: true,
    sortOrder: 20,
    status: 'active',
  });
  const group = await modules.service.createGroup({
    slug: `group-${suffix}`,
    name: `Group ${suffix}`,
    userDescription: `${suffix} group`,
    newapiGroup: `gw-${suffix}`,
    allowCreateKey: true,
    sortOrder: 30,
    status: 'active',
  });
  const category = await modules.service.createCategory({
    slug: `category-${suffix}`,
    name: `Category ${suffix}`,
    sortOrder: 40,
    status: 'active',
  });
  const capability = await modules.service.createCapability({
    slug: `capability-${suffix}`,
    name: `Capability ${suffix}`,
    sortOrder: 50,
    status: 'active',
  });
  return { vendor, status, group, category, capability };
}

test('setup catalog admin review fixes db', async () => {
  await setupDb();
});

test('模型管理行只返回模型元数据与基准价，不投影第一条分组折扣', async () => {
  const dims = await seedDimensions('rows');

  for (let i = 0; i < 3; i++) {
    await modules.service.upsertModelAdminConfig({
      model: {
        modelId: `rows-model-${i}`,
        displayName: `Rows Model ${i}`,
        vendorId: dims.vendor.id,
        categoryIds: [dims.category.id],
      },
      basePrice: { inputMicroUsd: 150000, outputMicroUsd: 600000 },
      listing: {
        groupId: dims.group.id,
        statusId: dims.status.id,
        discountRateBps: 9000,
      },
      capabilityIds: [dims.capability.id],
    });
  }

  const rows = await modules.service.getModelAdminRows();

  // 批量查询必须覆盖 N 个模型（此前是每模型 4-5 条 N+1）——三个都要在场且字段正确。
  for (let i = 0; i < 3; i++) {
    const row = rows.find((r: any) => r.modelId === `rows-model-${i}`);
    assert.ok(row, `expected rows-model-${i} to be present`);
    assert.equal(row.inputPrice, '0.15');
    assert.equal(row.outputPrice, '0.6');
    for (const field of ['groupName', 'discountRateBps', 'pricingStatus']) {
      assert.equal(
        Object.prototype.hasOwnProperty.call(row, field),
        false,
        `${field} 属于分组折扣，不属于模型元数据`
      );
    }
  }
});

test('S-11c: upsertModelAdminConfig preserves list prices when the caller omits them, clears them on explicit null', async () => {
  const dims = await seedDimensions('listprice');

  const created = await modules.service.upsertModelAdminConfig({
    model: {
      modelId: 'listprice-model',
      displayName: 'List Price Model',
      vendorId: dims.vendor.id,
      categoryIds: [dims.category.id],
    },
    basePrice: { inputMicroUsd: 150000, outputMicroUsd: 600000 },
    listing: {
      groupId: dims.group.id,
      statusId: dims.status.id,
      listInputMicroUsd: 999000,
      listOutputMicroUsd: 1999000,
      discountRateBps: 9000,
    },
    capabilityIds: [dims.capability.id],
  });

  assert.equal(created.listing.listInputMicroUsd, 999000);
  assert.equal(created.listing.listOutputMicroUsd, 1999000);

  // 模型编辑表单根本不提交划线价字段（undefined）：不应被静默抹成 null
  const preserved = await modules.service.upsertModelAdminConfig({
    modelId: created.model.id,
    model: {
      modelId: 'listprice-model',
      displayName: 'List Price Model Renamed',
      vendorId: dims.vendor.id,
      categoryIds: [dims.category.id],
    },
    basePrice: { inputMicroUsd: 150000, outputMicroUsd: 600000 },
    listing: {
      id: created.listing.id,
      groupId: dims.group.id,
      statusId: dims.status.id,
      discountRateBps: 8000,
    },
    capabilityIds: [dims.capability.id],
  });

  assert.equal(preserved.listing.listInputMicroUsd, 999000);
  assert.equal(preserved.listing.listOutputMicroUsd, 1999000);

  // 显式 null 仍然清空（有意的写入路径不受影响）
  const cleared = await modules.service.upsertModelAdminConfig({
    modelId: created.model.id,
    model: {
      modelId: 'listprice-model',
      displayName: 'List Price Model Cleared',
      vendorId: dims.vendor.id,
      categoryIds: [dims.category.id],
    },
    basePrice: { inputMicroUsd: 150000, outputMicroUsd: 600000 },
    listing: {
      id: created.listing.id,
      groupId: dims.group.id,
      statusId: dims.status.id,
      listInputMicroUsd: null,
      listOutputMicroUsd: null,
      discountRateBps: 8000,
    },
    capabilityIds: [dims.capability.id],
  });

  assert.equal(cleared.listing.listInputMicroUsd, null);
  assert.equal(cleared.listing.listOutputMicroUsd, null);
});

test('S-11a: dictionary slug and model modelId unique collisions surface a UNIQUE constraint error the pages can catch', async () => {
  const dims = await seedDimensions('dup');

  // slug 唯一索引：drizzle 把约束文案埋进 error.cause，页面用 isUniqueConstraintError
  // 展开整条 cause 链后转 duplicateSlug。这里断言那个判定谓词确实命中。
  await assert.rejects(
    () =>
      modules.service.createVendor({
        slug: `vendor-dup`,
        name: 'Vendor Dup 2',
        sortOrder: 10,
        status: 'active',
      }),
    (error: unknown) => {
      assert.ok(
        isUniqueConstraintError(error),
        'duplicate slug must be recognized as a UNIQUE constraint error'
      );
      return true;
    }
  );

  await modules.service.upsertModelAdminConfig({
    model: {
      modelId: 'dup-model',
      displayName: 'Dup Model',
      vendorId: dims.vendor.id,
      categoryIds: [dims.category.id],
    },
    basePrice: { inputMicroUsd: 150000, outputMicroUsd: 600000 },
    listing: { groupId: dims.group.id, statusId: dims.status.id },
    capabilityIds: [dims.capability.id],
  });

  // catalog_model.model_id 唯一索引：页面用 isUniqueConstraintError 捕获后转 duplicateModelId
  await assert.rejects(
    () =>
      modules.service.upsertModelAdminConfig({
        model: {
          modelId: 'dup-model',
          displayName: 'Dup Model 2',
          vendorId: dims.vendor.id,
          categoryIds: [dims.category.id],
        },
        basePrice: { inputMicroUsd: 150000, outputMicroUsd: 600000 },
        listing: { groupId: dims.group.id, statusId: dims.status.id },
        capabilityIds: [dims.capability.id],
      }),
    (error: unknown) => {
      assert.ok(
        isUniqueConstraintError(error),
        'duplicate modelId must be recognized as a UNIQUE constraint error'
      );
      return true;
    }
  );
});

const root = process.cwd();
const catalogRoot = join(root, 'src/app/[locale]/(admin)/admin/catalog');
const modelsRoot = join(catalogRoot, 'models');

async function readCatalogJson(locale: string) {
  return JSON.parse(
    await readFile(
      join(root, `src/config/locale/messages/${locale}/admin/catalog.json`),
      'utf8'
    )
  );
}

test('S-8: formatDiscountRate is removed and discount labels render from a locale message, never a hardcoded single-language string', async () => {
  const pricing = await readFile(
    join(root, 'src/features/api-catalog/lib/pricing.ts'),
    'utf8'
  );
  // 服务层不再产出预格式化的折扣字符串：formatDiscountRate 整个删除。
  assert.doesNotMatch(pricing, /export function formatDiscountRate/);

  const service = await readFile(
    join(root, 'src/features/api-catalog/server/catalog-service.ts'),
    'utf8'
  );
  assert.doesNotMatch(service, /formatDiscountRate/);
  assert.doesNotMatch(service, /discountRateBps: listing\?\.discountRateBps/);

  const listingsListPage = await readFile(
    join(modelsRoot, '[id]/listings/page.tsx'),
    'utf8'
  );
  const modelsListPage = await readFile(join(modelsRoot, 'page.tsx'), 'utf8');
  assert.doesNotMatch(listingsListPage, /formatDiscountRate/);
  assert.match(listingsListPage, /t\(['"]discount\.value['"]/);
  assert.doesNotMatch(modelsListPage, /formatDiscountRate|discount\.value/);

  const en = await readCatalogJson('en');
  const zh = await readCatalogJson('zh');
  assert.ok(en.discount?.value, 'en discount.value must exist');
  assert.ok(zh.discount?.value, 'zh discount.value must exist');
  // 英文词条不得含中文「折」——这正是原 formatDiscountRate 漏到英文站的字
  assert.doesNotMatch(
    en.discount.value,
    /折/,
    'the English discount label must not contain Chinese characters'
  );
});

test('模型列表不注册分组、折扣和 listing 定价状态列', async () => {
  const listPage = await readFile(join(modelsRoot, 'page.tsx'), 'utf8');
  for (const field of ['groupName', 'discountRate', 'pricingStatus']) {
    assert.doesNotMatch(listPage, new RegExp(`name:\\s*['"]${field}['"]`));
  }
  assert.match(listPage, /admin\/catalog\/models\/\$\{item\.id\}\/listings/);
});

test('模型表单及保存动作完全不读写分组折扣字段', async () => {
  const form = await readFile(join(modelsRoot, 'model-admin-form.tsx'), 'utf8');
  assert.doesNotMatch(form, /<select\s+name="groupId"/);
  assert.doesNotMatch(form, /name="groupId"/);
  assert.doesNotMatch(form, /groups\.map\(\(group\)/);
  assert.doesNotMatch(form, /setGroupId/);

  for (const page of ['new/page.tsx', '[id]/edit/page.tsx']) {
    const source = await readFile(join(modelsRoot, page), 'utf8');
    assert.doesNotMatch(source, /group:\s*t\(['"]fields\.group['"]\)/);
    assert.doesNotMatch(source, /groups=\{/);
    assert.doesNotMatch(source, /listing:\s*\{/);
  }
});

test('S-9: zero-capability saves append the silent-delisting warning', async () => {
  const capabilitiesPage = await readFile(
    join(modelsRoot, '[id]/capabilities/page.tsx'),
    'utf8'
  );
  const newPage = await readFile(join(modelsRoot, 'new/page.tsx'), 'utf8');
  const editPage = await readFile(join(modelsRoot, '[id]/edit/page.tsx'), 'utf8');
  for (const source of [capabilitiesPage, newPage, editPage]) {
    assert.match(source, /capabilitiesEmptyWarning/);
    assert.match(source, /length === 0/);
  }
  const en = await readCatalogJson('en');
  const zh = await readCatalogJson('zh');
  assert.ok(en.messages.capabilitiesEmptyWarning);
  assert.ok(zh.messages.capabilitiesEmptyWarning);
});

test('S-10: group discount forms carry a tip that the field is record-only', async () => {
  for (const page of [
    '[id]/listings/new/page.tsx',
    '[id]/listings/[listingId]/edit/page.tsx',
  ]) {
    const source = await readFile(join(modelsRoot, page), 'utf8');
    assert.match(
      source,
      /name:\s*['"]discountFold['"][\s\S]*?tip:\s*t\(['"]fields\.discountFoldTip['"]\)/
    );
  }
  const en = await readCatalogJson('en');
  const zh = await readCatalogJson('zh');
  assert.ok(en.fields.discountFoldTip);
  assert.ok(zh.fields.discountFoldTip);
});

test('S-11a: create/upsert pages catch UNIQUE collisions and map them to translated messages', async () => {
  const dictionaryCreatePages = [
    'vendors/new/page.tsx',
    'capabilities/new/page.tsx',
    'statuses/new/page.tsx',
    'categories/new/page.tsx',
    'groups/new/page.tsx',
  ];
  for (const page of dictionaryCreatePages) {
    const source = await readFile(join(catalogRoot, page), 'utf8');
    assert.match(source, /isUniqueConstraintError\(error\)/, page);
    assert.match(source, /duplicateSlugMessage/, page);
  }

  for (const page of ['models/new/page.tsx', 'models/[id]/edit/page.tsx']) {
    const source = await readFile(join(catalogRoot, page), 'utf8');
    assert.match(source, /isUniqueConstraintError\(error\)/, page);
    assert.match(source, /duplicateModelIdMessage/, page);
  }

  const en = await readCatalogJson('en');
  const zh = await readCatalogJson('zh');
  for (const messages of [en, zh]) {
    assert.ok(messages.errors.duplicateSlug);
    assert.ok(messages.errors.duplicateModelId);
  }
});

test('S-11b: new group discount success reuses the price-hidden hint', async () => {
  const newPage = await readFile(
    join(modelsRoot, '[id]/listings/new/page.tsx'),
    'utf8'
  );
  assert.match(newPage, /messages\.priceHiddenAfterSave/);
});
