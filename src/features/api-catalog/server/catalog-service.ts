import { and, asc, count, eq, inArray, ne } from 'drizzle-orm';

import {
  catalogCapability,
  catalogCategory,
  catalogGroup,
  catalogModel,
  catalogModelCapability,
  catalogModelCategory,
  catalogModelListing,
  catalogModelPrice,
  catalogModelPriceTier,
  catalogStatus,
  catalogVendor,
  newApiKeyBinding,
} from '@/config/db/schema';
import { db } from '@/core/db';
import { microUsdToDollars } from '@/features/api-catalog/lib/pricing';
import { getUuid } from '@/shared/lib/hash';

export type Vendor = typeof catalogVendor.$inferSelect;
export type Capability = typeof catalogCapability.$inferSelect;
export type CatalogStatus = typeof catalogStatus.$inferSelect;
export type CatalogGroup = typeof catalogGroup.$inferSelect;
export type Model = typeof catalogModel.$inferSelect;
export type Listing = typeof catalogModelListing.$inferSelect;
export type ModelPrice = typeof catalogModelPrice.$inferSelect;
export type ModelPriceTier = typeof catalogModelPriceTier.$inferSelect;
export type ModelCategory = typeof catalogModelCategory.$inferSelect;

export type NewVendor = typeof catalogVendor.$inferInsert;
export type NewCapability = typeof catalogCapability.$inferInsert;
export type NewCatalogStatus = typeof catalogStatus.$inferInsert;
export type NewCatalogGroup = typeof catalogGroup.$inferInsert;
export type NewModel = typeof catalogModel.$inferInsert;
export type NewListing = typeof catalogModelListing.$inferInsert;
export type NewModelCategory = typeof catalogModelCategory.$inferInsert;

export type UpdateVendor = Partial<Omit<Vendor, 'id' | 'createdAt'>>;
export type UpdateCapability = Partial<Omit<Capability, 'id' | 'createdAt'>>;
export type UpdateCatalogStatus = Partial<
  Omit<CatalogStatus, 'id' | 'createdAt'>
>;
export type UpdateCatalogGroup = Partial<
  Omit<CatalogGroup, 'id' | 'createdAt'>
>;
export type UpdateModel = Partial<Omit<Model, 'id' | 'createdAt'>>;
export type UpdateListing = Partial<Omit<Listing, 'id' | 'createdAt'>>;

export type Category = typeof catalogCategory.$inferSelect;
export type NewCategory = typeof catalogCategory.$inferInsert;
export type UpdateCategory = Partial<Omit<Category, 'id' | 'createdAt'>>;

export type ModelAdminConfigInput = {
  modelId?: string;
  operatorUserId?: string | null;
  model: {
    modelId: string;
    displayName: string;
    vendorId: string;
    categoryIds: string[];
  };
  basePrice: {
    billingScheme?: 'token' | 'per_call';
    inputMicroUsd?: number | null;
    outputMicroUsd?: number | null;
    cachedInputMicroUsd?: number | null;
    cacheWriteMicroUsd?: number | null;
    cacheWrite5mMicroUsd?: number | null;
    cacheWrite1hMicroUsd?: number | null;
    imageInputMicroUsd?: number | null;
    cachedImageInputMicroUsd?: number | null;
    imageOutputMicroUsd?: number | null;
    webSearchMicroUsd?: number | null;
    longContextThresholdTokens?: number | null;
    inputLongMicroUsd?: number | null;
    cachedInputLongMicroUsd?: number | null;
    cacheWriteLongMicroUsd?: number | null;
    outputLongMicroUsd?: number | null;
    billingCapabilitiesJson?: string;
    sourceSupportedEndpointTypes?: string | null;
    tiers?: Array<{
      skuKey: string;
      priceMicroUsd: number;
      note?: string | null;
    }>;
  };
  listing: {
    id?: string;
    groupId: string;
    statusId: string;
    listInputMicroUsd?: number | null;
    listOutputMicroUsd?: number | null;
    discountRateBps?: number | null;
    discountNote?: string | null;
    description?: string | null;
    featured?: boolean;
    sortOrder?: number;
  };
  capabilityIds: string[];
};

export type ModelMetadataAdminConfigInput = Omit<
  ModelAdminConfigInput,
  'listing'
>;

export type ModelAdminConfigResult = {
  model: Model;
  listing: Listing;
  basePrice: ModelPrice;
  tiers: ModelPriceTier[];
};

export type ModelMetadataAdminConfigResult = Omit<
  ModelAdminConfigResult,
  'listing'
>;

// 模型列表里逐个 meter 的展示条目；label 由页面按 fields.<key> 翻译解析，
// 这里只回传稳定的 key 与已格式化的美元字符串（仅非空 meter）。
export type ModelAdminPriceMeterKey =
  | 'inputMicroUsd'
  | 'cachedInputMicroUsd'
  | 'cacheWriteMicroUsd'
  | 'cacheWrite5mMicroUsd'
  | 'cacheWrite1hMicroUsd'
  | 'outputMicroUsd'
  | 'imageInputMicroUsd'
  | 'cachedImageInputMicroUsd'
  | 'imageOutputMicroUsd'
  | 'webSearchMicroUsd'
  | 'inputLongMicroUsd'
  | 'cachedInputLongMicroUsd'
  | 'cacheWriteLongMicroUsd'
  | 'outputLongMicroUsd';

export type ModelAdminPriceMeter = {
  key: ModelAdminPriceMeterKey;
  value: string;
};

// 模型元数据列表的价格聚合：不再逐 meter 平铺成列，而是收进一格气泡卡。
// summary 供单元格常态展示，base/long meters 供展开明细。
export type ModelAdminPrice = {
  billingScheme: string;
  hasPrice: boolean;
  inputSummary: string | null;
  outputSummary: string | null;
  fixedPrice: string | null;
  fixedPriceUnit: string | null;
  longContextThresholdTokens: number | null;
  baseMeters: ModelAdminPriceMeter[];
  longMeters: ModelAdminPriceMeter[];
};

export type ModelAdminRow = {
  id: string;
  modelId: string;
  displayName: string;
  vendorName: string;
  categoryNames: string;
  capabilityNames: string;
  price: ModelAdminPrice;
  createdAt: Date;
};

export type ModelAdminConfig = {
  model: Model;
  listing?: Listing;
  basePrice?: ModelPrice;
  tiers: ModelPriceTier[];
  categories: Category[];
  capabilities: Capability[];
};

export type CatalogReference = {
  label: string;
  count: number;
};

export class CatalogDeleteBlockedError extends Error {
  code = 'CATALOG_DELETE_BLOCKED' as const;

  constructor(
    public readonly label: string,
    public readonly references: CatalogReference[]
  ) {
    super(`${label} is still referenced by catalog data.`);
    this.name = 'CatalogDeleteBlockedError';
  }
}

function assertImmutableSlug(
  currentSlug: string | undefined,
  patchSlug: string | undefined,
  label: string
) {
  if (
    currentSlug === undefined ||
    patchSlug === undefined ||
    patchSlug === currentSlug
  ) {
    return;
  }

  throw new Error(`${label} slug is immutable.`);
}

async function getCatalogReferenceCount(table: any, where: any) {
  const [result] = await db()
    .select({ total: count() })
    .from(table)
    .where(where);
  return Number(result?.total ?? 0);
}

function ensureNoCatalogReferences(
  label: string,
  references: CatalogReference[]
) {
  const blockingReferences = references.filter(
    (reference) => reference.count > 0
  );
  if (blockingReferences.length > 0) {
    throw new CatalogDeleteBlockedError(label, blockingReferences);
  }
}

export async function getVendors(): Promise<Vendor[]> {
  return await db()
    .select()
    .from(catalogVendor)
    .orderBy(asc(catalogVendor.sortOrder));
}

export async function getVendorById(id: string): Promise<Vendor | undefined> {
  const [result] = await db()
    .select()
    .from(catalogVendor)
    .where(eq(catalogVendor.id, id));
  return result;
}

export async function createVendor(data: NewVendor): Promise<Vendor> {
  const [result] = await db()
    .insert(catalogVendor)
    .values({ ...data, id: getUuid() })
    .returning();
  return result;
}

export async function updateVendor(
  id: string,
  patch: UpdateVendor
): Promise<Vendor> {
  const current = await getVendorById(id);
  assertImmutableSlug(current?.slug, patch.slug, 'vendor');

  const [result] = await db()
    .update(catalogVendor)
    .set(patch)
    .where(eq(catalogVendor.id, id))
    .returning();
  return result;
}

export async function deleteVendor(id: string): Promise<void> {
  const vendor = await getVendorById(id);
  if (!vendor) return;

  ensureNoCatalogReferences('vendor', [
    {
      label: 'catalog_model.vendor_id',
      count: await getCatalogReferenceCount(
        catalogModel,
        eq(catalogModel.vendorId, vendor.id)
      ),
    },
  ]);

  await db().delete(catalogVendor).where(eq(catalogVendor.id, id));
}

export async function getCategories(): Promise<Category[]> {
  return await db()
    .select()
    .from(catalogCategory)
    .orderBy(asc(catalogCategory.sortOrder));
}

export async function getCategoryById(
  id: string
): Promise<Category | undefined> {
  const [result] = await db()
    .select()
    .from(catalogCategory)
    .where(eq(catalogCategory.id, id));
  return result;
}

export async function createCategory(data: NewCategory): Promise<Category> {
  const [result] = await db()
    .insert(catalogCategory)
    .values({ ...data, id: getUuid() })
    .returning();
  return result;
}

export async function updateCategory(
  id: string,
  patch: UpdateCategory
): Promise<Category> {
  const current = await getCategoryById(id);
  assertImmutableSlug(current?.slug, patch.slug, 'category');

  const [result] = await db()
    .update(catalogCategory)
    .set(patch)
    .where(eq(catalogCategory.id, id))
    .returning();
  return result;
}

export async function deleteCategory(id: string): Promise<void> {
  const category = await getCategoryById(id);
  if (!category) return;

  ensureNoCatalogReferences('category', [
    {
      label: 'catalog_model_category.category_id',
      count: await getCatalogReferenceCount(
        catalogModelCategory,
        eq(catalogModelCategory.categoryId, category.id)
      ),
    },
    {
      label: 'catalog_model.category',
      count: await getCatalogReferenceCount(
        catalogModel,
        eq(catalogModel.category, category.slug)
      ),
    },
  ]);

  await db().delete(catalogCategory).where(eq(catalogCategory.id, id));
}

export async function getCapabilities(): Promise<Capability[]> {
  return await db()
    .select()
    .from(catalogCapability)
    .orderBy(asc(catalogCapability.sortOrder));
}

export async function getCapabilityById(
  id: string
): Promise<Capability | undefined> {
  const [result] = await db()
    .select()
    .from(catalogCapability)
    .where(eq(catalogCapability.id, id));
  return result;
}

export async function createCapability(
  data: NewCapability
): Promise<Capability> {
  const [result] = await db()
    .insert(catalogCapability)
    .values({ ...data, id: getUuid() })
    .returning();
  return result;
}

export async function updateCapability(
  id: string,
  patch: UpdateCapability
): Promise<Capability> {
  const current = await getCapabilityById(id);
  assertImmutableSlug(current?.slug, patch.slug, 'capability');

  const [result] = await db()
    .update(catalogCapability)
    .set(patch)
    .where(eq(catalogCapability.id, id))
    .returning();
  return result;
}

export async function deleteCapability(id: string): Promise<void> {
  const capability = await getCapabilityById(id);
  if (!capability) return;

  ensureNoCatalogReferences('capability', [
    {
      label: 'catalog_model_capability.capability_id',
      count: await getCatalogReferenceCount(
        catalogModelCapability,
        eq(catalogModelCapability.capabilityId, capability.id)
      ),
    },
  ]);

  await db().delete(catalogCapability).where(eq(catalogCapability.id, id));
}

export async function getStatuses(): Promise<CatalogStatus[]> {
  return await db()
    .select()
    .from(catalogStatus)
    .orderBy(asc(catalogStatus.sortOrder));
}

export async function getStatusById(
  id: string
): Promise<CatalogStatus | undefined> {
  const [result] = await db()
    .select()
    .from(catalogStatus)
    .where(eq(catalogStatus.id, id));
  return result;
}

export async function createStatus(
  data: NewCatalogStatus
): Promise<CatalogStatus> {
  const [result] = await db()
    .insert(catalogStatus)
    .values({ ...data, id: getUuid() })
    .returning();
  return result;
}

export async function updateStatus(
  id: string,
  patch: UpdateCatalogStatus
): Promise<CatalogStatus> {
  const current = await getStatusById(id);
  assertImmutableSlug(current?.slug, patch.slug, 'status');

  const [result] = await db()
    .update(catalogStatus)
    .set(patch)
    .where(eq(catalogStatus.id, id))
    .returning();
  return result;
}

export async function deleteStatus(id: string): Promise<void> {
  const status = await getStatusById(id);
  if (!status) return;

  ensureNoCatalogReferences('status', [
    {
      label: 'catalog_model_listing.status_id',
      count: await getCatalogReferenceCount(
        catalogModelListing,
        eq(catalogModelListing.statusId, status.id)
      ),
    },
  ]);

  await db().delete(catalogStatus).where(eq(catalogStatus.id, id));
}

export async function getGroups(): Promise<CatalogGroup[]> {
  return await db()
    .select()
    .from(catalogGroup)
    .orderBy(asc(catalogGroup.sortOrder));
}

export async function getGroupById(
  id: string
): Promise<CatalogGroup | undefined> {
  const [result] = await db()
    .select()
    .from(catalogGroup)
    .where(eq(catalogGroup.id, id));
  return result;
}

export async function getGroupBySlug(
  slug: string
): Promise<CatalogGroup | undefined> {
  const [result] = await db()
    .select()
    .from(catalogGroup)
    .where(eq(catalogGroup.slug, slug));
  return result;
}

export async function createGroup(
  data: NewCatalogGroup
): Promise<CatalogGroup> {
  const [result] = await db()
    .insert(catalogGroup)
    .values({ ...data, id: getUuid() })
    .returning();
  return result;
}

export async function updateGroup(
  id: string,
  patch: UpdateCatalogGroup
): Promise<CatalogGroup> {
  const current = await getGroupById(id);
  assertImmutableSlug(current?.slug, patch.slug, 'group');

  // 改了 New API 映射 = 建 Key / 计费立刻走新分组，但缓存的倍率仍是旧分组的。
  // 不失效就会让 /models 按旧倍率展示价格，与实际扣费不符。
  // 失效后公开价自动转为「—」，直到重新跑一次价格同步确认（hide-until-confirmed）。
  const remapped =
    patch.newapiGroup !== undefined &&
    patch.newapiGroup !== current?.newapiGroup;

  if (!remapped) {
    const [result] = await db()
      .update(catalogGroup)
      .set(patch)
      .where(eq(catalogGroup.id, id))
      .returning();
    return result;
  }

  return await db().transaction(async (tx: any) => {
    const [result] = await tx
      .update(catalogGroup)
      .set({
        ...patch,
        newapiGroupRatioBps: null,
        newapiGroupRatioDecimal: null,
        newapiGroupRatioRaw: null,
        pricingSyncStatus: 'unknown',
        pricingSyncedAt: null,
      })
      .where(eq(catalogGroup.id, id))
      .returning();

    await tx
      .update(catalogModelListing)
      .set({ priceDriftStatus: 'needs_live_check' })
      .where(eq(catalogModelListing.groupId, id));

    return result;
  });
}

export async function deleteGroup(id: string): Promise<void> {
  const group = await getGroupById(id);
  if (!group) return;

  ensureNoCatalogReferences('group', [
    {
      label: 'catalog_model_listing.group_id',
      count: await getCatalogReferenceCount(
        catalogModelListing,
        eq(catalogModelListing.groupId, group.id)
      ),
    },
    {
      label: 'newapi_key_binding.group_id',
      count: await getCatalogReferenceCount(
        newApiKeyBinding,
        and(
          eq(newApiKeyBinding.groupId, group.id),
          ne(newApiKeyBinding.status, 'deleted')
        )
      ),
    },
  ]);

  await db().delete(catalogGroup).where(eq(catalogGroup.id, id));
}

export async function getModels(): Promise<Model[]> {
  return await db()
    .select()
    .from(catalogModel)
    .orderBy(asc(catalogModel.displayName));
}

// meter 展示 key ↔ 价格快照列的映射，顺序与模型编辑表单一致，方便管理员对照。
const ADMIN_BASE_METER_COLUMNS: [ModelAdminPriceMeterKey, keyof ModelPrice][] =
  [
    ['inputMicroUsd', 'baseInputMicroUsd'],
    ['cachedInputMicroUsd', 'baseCachedInputMicroUsd'],
    ['cacheWriteMicroUsd', 'baseCacheWriteMicroUsd'],
    ['cacheWrite5mMicroUsd', 'baseCacheWrite5mMicroUsd'],
    ['cacheWrite1hMicroUsd', 'baseCacheWrite1hMicroUsd'],
    ['outputMicroUsd', 'baseOutputMicroUsd'],
    ['imageInputMicroUsd', 'baseImageInputMicroUsd'],
    ['cachedImageInputMicroUsd', 'baseCachedImageInputMicroUsd'],
    ['imageOutputMicroUsd', 'baseImageOutputMicroUsd'],
    ['webSearchMicroUsd', 'baseWebSearchMicroUsd'],
  ];

const ADMIN_LONG_METER_COLUMNS: [ModelAdminPriceMeterKey, keyof ModelPrice][] =
  [
    ['inputLongMicroUsd', 'baseInputLongMicroUsd'],
    ['cachedInputLongMicroUsd', 'baseCachedInputLongMicroUsd'],
    ['cacheWriteLongMicroUsd', 'baseCacheWriteLongMicroUsd'],
    ['outputLongMicroUsd', 'baseOutputLongMicroUsd'],
  ];

function buildModelAdminPrice(
  basePrice: ModelPrice | undefined
): ModelAdminPrice {
  const toMeters = (
    defs: [ModelAdminPriceMeterKey, keyof ModelPrice][]
  ): ModelAdminPriceMeter[] =>
    defs.flatMap(([key, column]) => {
      const value = microUsdToDollars(
        basePrice?.[column] as number | null | undefined
      );
      return value === '' ? [] : [{ key, value }];
    });

  const baseMeters = toMeters(ADMIN_BASE_METER_COLUMNS);
  const longMeters = toMeters(ADMIN_LONG_METER_COLUMNS);
  const fixedPrice = microUsdToDollars(basePrice?.fixedPriceMicroUsd) || null;

  return {
    billingScheme: basePrice?.billingScheme ?? 'token',
    hasPrice:
      baseMeters.length > 0 || longMeters.length > 0 || fixedPrice !== null,
    inputSummary: microUsdToDollars(basePrice?.baseInputMicroUsd) || null,
    outputSummary: microUsdToDollars(basePrice?.baseOutputMicroUsd) || null,
    fixedPrice,
    fixedPriceUnit: basePrice?.fixedPriceUnit ?? null,
    longContextThresholdTokens: basePrice?.longContextThresholdTokens ?? null,
    baseMeters,
    longMeters,
  };
}

export async function getModelAdminRows(): Promise<ModelAdminRow[]> {
  const [models, vendors] = await Promise.all([getModels(), getVendors()]);
  if (models.length === 0) return [];

  const vendorNames = new Map(
    vendors.map((vendor) => [vendor.id, vendor.name] as const)
  );
  const modelIds = models.map((model) => model.id);

  // 模型列表只读模型主数据与基准价；分组、折扣和 listing 健康状态只在
  // “分组折扣”页面读取，避免拿第一条 listing 冒充模型元数据。
  const [categoryRows, capabilityRows, basePriceRows] = await Promise.all([
    db()
      .select({
        modelId: catalogModelCategory.modelId,
        name: catalogCategory.name,
        sortOrder: catalogCategory.sortOrder,
      })
      .from(catalogModelCategory)
      .innerJoin(
        catalogCategory,
        eq(catalogModelCategory.categoryId, catalogCategory.id)
      )
      .where(inArray(catalogModelCategory.modelId, modelIds))
      .orderBy(asc(catalogCategory.sortOrder)),
    db()
      .select({
        modelId: catalogModelCapability.modelId,
        name: catalogCapability.name,
        sortOrder: catalogCapability.sortOrder,
      })
      .from(catalogModelCapability)
      .innerJoin(
        catalogCapability,
        eq(catalogModelCapability.capabilityId, catalogCapability.id)
      )
      .where(inArray(catalogModelCapability.modelId, modelIds))
      .orderBy(asc(catalogCapability.sortOrder)),
    db()
      .select()
      .from(catalogModelPrice)
      .where(inArray(catalogModelPrice.modelId, modelIds)),
  ]);
  const categoryNamesByModel = new Map<string, string[]>();
  for (const row of categoryRows as { modelId: string; name: string }[]) {
    const names = categoryNamesByModel.get(row.modelId) ?? [];
    names.push(row.name);
    categoryNamesByModel.set(row.modelId, names);
  }
  const capabilityNamesByModel = new Map<string, string[]>();
  for (const row of capabilityRows as { modelId: string; name: string }[]) {
    const names = capabilityNamesByModel.get(row.modelId) ?? [];
    names.push(row.name);
    capabilityNamesByModel.set(row.modelId, names);
  }
  const basePriceByModel = new Map<string, ModelPrice>();
  for (const basePrice of basePriceRows as ModelPrice[]) {
    if (!basePriceByModel.has(basePrice.modelId)) {
      basePriceByModel.set(basePrice.modelId, basePrice);
    }
  }

  return models.map((model) => {
    const basePrice = basePriceByModel.get(model.id);
    const categoryNames = categoryNamesByModel.get(model.id) ?? [];
    const capabilityNames = capabilityNamesByModel.get(model.id) ?? [];

    return {
      id: model.id,
      modelId: model.modelId,
      displayName: model.displayName,
      vendorName: vendorNames.get(model.vendorId) ?? model.vendorId,
      categoryNames:
        categoryNames.length > 0 ? categoryNames.join(', ') : model.category,
      capabilityNames: capabilityNames.join(', '),
      price: buildModelAdminPrice(basePrice),
      createdAt: model.createdAt,
    };
  });
}

export async function getModelById(id: string): Promise<Model | undefined> {
  const [result] = await db()
    .select()
    .from(catalogModel)
    .where(eq(catalogModel.id, id));
  return result;
}

export async function getModelAdminConfig(
  id: string
): Promise<ModelAdminConfig | undefined> {
  const model = await getModelById(id);
  if (!model) return undefined;

  const [listings, categories, capabilities, tiers] = await Promise.all([
    getListingsByModel(model.id),
    getModelCategories(model.id),
    getModelCapabilities(model.id),
    db()
      .select()
      .from(catalogModelPriceTier)
      .where(eq(catalogModelPriceTier.modelId, model.id))
      .orderBy(asc(catalogModelPriceTier.skuKey)),
  ]);
  const [basePrice] = await db()
    .select()
    .from(catalogModelPrice)
    .where(eq(catalogModelPrice.modelId, model.id))
    .limit(1);

  return {
    model,
    listing: listings[0],
    basePrice,
    tiers,
    categories,
    capabilities,
  };
}

export async function getModelCapabilities(
  modelId: string
): Promise<Capability[]> {
  return await db()
    .select({
      id: catalogCapability.id,
      slug: catalogCapability.slug,
      name: catalogCapability.name,
      sortOrder: catalogCapability.sortOrder,
      status: catalogCapability.status,
      createdAt: catalogCapability.createdAt,
      updatedAt: catalogCapability.updatedAt,
    })
    .from(catalogModelCapability)
    .innerJoin(
      catalogCapability,
      eq(catalogModelCapability.capabilityId, catalogCapability.id)
    )
    .where(eq(catalogModelCapability.modelId, modelId))
    .orderBy(asc(catalogCapability.sortOrder));
}

export async function getModelCategories(modelId: string): Promise<Category[]> {
  return await db()
    .select({
      id: catalogCategory.id,
      slug: catalogCategory.slug,
      name: catalogCategory.name,
      sortOrder: catalogCategory.sortOrder,
      status: catalogCategory.status,
      createdAt: catalogCategory.createdAt,
      updatedAt: catalogCategory.updatedAt,
    })
    .from(catalogModelCategory)
    .innerJoin(
      catalogCategory,
      eq(catalogModelCategory.categoryId, catalogCategory.id)
    )
    .where(eq(catalogModelCategory.modelId, modelId))
    .orderBy(asc(catalogCategory.sortOrder));
}

export async function createModel(data: NewModel): Promise<Model> {
  const [result] = await db()
    .insert(catalogModel)
    .values({ ...data, id: getUuid() })
    .returning();
  return result;
}

export async function updateModel(
  id: string,
  patch: UpdateModel
): Promise<Model> {
  const [result] = await db()
    .update(catalogModel)
    .set(patch)
    .where(eq(catalogModel.id, id))
    .returning();
  return result;
}

export async function deleteModel(id: string): Promise<void> {
  await db().transaction(async (tx: any) => {
    // 显式删净所有子表，事务自包含、不依赖 FK cascade 的开关状态
    await tx
      .delete(catalogModelPriceTier)
      .where(eq(catalogModelPriceTier.modelId, id));
    await tx.delete(catalogModelPrice).where(eq(catalogModelPrice.modelId, id));
    await tx
      .delete(catalogModelListing)
      .where(eq(catalogModelListing.modelId, id));
    await tx
      .delete(catalogModelCapability)
      .where(eq(catalogModelCapability.modelId, id));
    await tx
      .delete(catalogModelCategory)
      .where(eq(catalogModelCategory.modelId, id));
    await tx.delete(catalogModel).where(eq(catalogModel.id, id));
  });
}

export async function getListingsByModel(modelId: string): Promise<Listing[]> {
  return await db()
    .select()
    .from(catalogModelListing)
    .where(eq(catalogModelListing.modelId, modelId))
    .orderBy(asc(catalogModelListing.sortOrder));
}

export async function getListingById(id: string): Promise<Listing | undefined> {
  const [result] = await db()
    .select()
    .from(catalogModelListing)
    .where(eq(catalogModelListing.id, id));
  return result;
}

export async function createListing(data: NewListing): Promise<Listing> {
  const [result] = await db()
    .insert(catalogModelListing)
    .values({ ...data, id: getUuid() })
    .returning();
  return result;
}

export async function updateListing(
  id: string,
  patch: UpdateListing
): Promise<Listing> {
  const [result] = await db()
    .update(catalogModelListing)
    .set(patch)
    .where(eq(catalogModelListing.id, id))
    .returning();
  return result;
}

export async function deleteListing(id: string): Promise<void> {
  await db().delete(catalogModelListing).where(eq(catalogModelListing.id, id));
}

// delete + insert 必须同事务：insert 失败会把模型的能力/分类清空，
// 而缺能力的模型会从公开页与建 Key 候选里静默消失。
export async function setModelCapabilities(
  modelId: string,
  capabilityIds: string[]
): Promise<void> {
  await db().transaction(async (tx: any) => {
    await syncModelCapabilities(tx, modelId, capabilityIds);
  });
}

export async function setModelCategories(
  modelId: string,
  categoryIds: string[]
): Promise<void> {
  await db().transaction(async (tx: any) => {
    await syncModelCategories(tx, modelId, categoryIds);
  });
}

export function upsertModelAdminConfig(
  input: ModelAdminConfigInput
): Promise<ModelAdminConfigResult>;
export function upsertModelAdminConfig(
  input: ModelMetadataAdminConfigInput
): Promise<ModelMetadataAdminConfigResult>;
export async function upsertModelAdminConfig(
  input: ModelAdminConfigInput | ModelMetadataAdminConfigInput
): Promise<ModelAdminConfigResult | ModelMetadataAdminConfigResult> {
  if (input.model.categoryIds.length === 0) {
    throw new Error('at least one category is required');
  }
  const billingScheme = input.basePrice.billingScheme ?? 'token';
  if (!['token', 'per_call'].includes(billingScheme)) {
    throw new Error('计费方式无效');
  }
  const normalizedTiers =
    billingScheme === 'per_call'
      ? (input.basePrice.tiers ?? []).map((tier) => ({
          skuKey: tier.skuKey.trim(),
          priceMicroUsd: tier.priceMicroUsd,
          note: tier.note?.trim() || null,
        }))
      : [];
  if (
    normalizedTiers.some(
      (tier) =>
        !tier.skuKey ||
        !Number.isSafeInteger(tier.priceMicroUsd) ||
        tier.priceMicroUsd <= 0
    ) ||
    new Set(normalizedTiers.map((tier) => tier.skuKey)).size !==
      normalizedTiers.length
  ) {
    throw new Error('按次价目表包含无效或重复档位');
  }
  if (
    billingScheme === 'per_call' &&
    !normalizedTiers.some((tier) => tier.skuKey === 'default')
  ) {
    throw new Error('按次计费必须配置 default 档');
  }

  return await db().transaction(async (tx: any) => {
    const categories = (await tx
      .select()
      .from(catalogCategory)
      .where(
        inArray(catalogCategory.id, input.model.categoryIds)
      )) as Category[];
    const categoriesById = new Map<string, Category>(
      categories.map((category: Category) => [category.id, category])
    );
    const missingCategoryId = input.model.categoryIds.find(
      (categoryId) => !categoriesById.has(categoryId)
    );

    if (missingCategoryId) {
      throw new Error(`category not found: ${missingCategoryId}`);
    }

    const primaryCategory = categoriesById.get(input.model.categoryIds[0]);
    if (!primaryCategory) {
      throw new Error('at least one category is required');
    }

    const modelPatch = {
      modelId: input.model.modelId,
      displayName: input.model.displayName,
      vendorId: input.model.vendorId,
      category: primaryCategory.slug,
    };

    const [model] = input.modelId
      ? await tx
          .update(catalogModel)
          .set(modelPatch)
          .where(eq(catalogModel.id, input.modelId))
          .returning()
      : await tx
          .insert(catalogModel)
          .values({
            ...modelPatch,
            id: getUuid(),
            contextWindow: null,
          })
          .returning();

    if (!model) {
      throw new Error('model not found');
    }

    await syncModelCategories(tx, model.id, input.model.categoryIds);
    await syncModelCapabilities(tx, model.id, input.capabilityIds);

    const basePricePatch = {
      modelId: model.id,
      billingScheme,
      pricingMode:
        billingScheme === 'per_call' ? 'manual_per_call' : 'manual_token',
      source: 'manual',
      sourceSupportedEndpointTypes:
        input.basePrice.sourceSupportedEndpointTypes ?? null,
      baseInputMicroUsd: input.basePrice.inputMicroUsd ?? null,
      baseOutputMicroUsd: input.basePrice.outputMicroUsd ?? null,
      baseCachedInputMicroUsd: input.basePrice.cachedInputMicroUsd ?? null,
      baseCacheWriteMicroUsd: input.basePrice.cacheWriteMicroUsd ?? null,
      baseCacheWrite5mMicroUsd: input.basePrice.cacheWrite5mMicroUsd ?? null,
      baseCacheWrite1hMicroUsd: input.basePrice.cacheWrite1hMicroUsd ?? null,
      baseImageInputMicroUsd: input.basePrice.imageInputMicroUsd ?? null,
      baseCachedImageInputMicroUsd:
        input.basePrice.cachedImageInputMicroUsd ?? null,
      baseImageOutputMicroUsd: input.basePrice.imageOutputMicroUsd ?? null,
      baseWebSearchMicroUsd: input.basePrice.webSearchMicroUsd ?? null,
      longContextThresholdTokens:
        input.basePrice.longContextThresholdTokens ?? null,
      baseInputLongMicroUsd: input.basePrice.inputLongMicroUsd ?? null,
      baseCachedInputLongMicroUsd:
        input.basePrice.cachedInputLongMicroUsd ?? null,
      baseCacheWriteLongMicroUsd:
        input.basePrice.cacheWriteLongMicroUsd ?? null,
      baseOutputLongMicroUsd: input.basePrice.outputLongMicroUsd ?? null,
      billingCapabilitiesJson: input.basePrice.billingCapabilitiesJson ?? '{}',
      syncStatus: 'reference_stale',
      driftStatus: 'cost_changed',
      reviewedBy: input.operatorUserId ?? null,
      reviewedAt: new Date(),
      reviewNote: 'admin model form',
    };
    const [basePrice] = await tx
      .insert(catalogModelPrice)
      .values({ ...basePricePatch, id: getUuid() })
      .onConflictDoUpdate({
        target: catalogModelPrice.modelId,
        set: {
          ...basePricePatch,
          updatedAt: new Date(),
        },
      })
      .returning();

    if (!basePrice) {
      throw new Error('model base price was not saved');
    }

    await tx
      .delete(catalogModelPriceTier)
      .where(eq(catalogModelPriceTier.modelId, model.id));
    const tiers = normalizedTiers.length
      ? ((await tx
          .insert(catalogModelPriceTier)
          .values(
            normalizedTiers.map((tier) => ({
              id: getUuid(),
              modelId: model.id,
              ...tier,
            }))
          )
          .returning()) as ModelPriceTier[])
      : [];

    // 卖价变化只触发成本守卫复核，不再隐藏公开价格或阻断调用。
    await tx
      .update(catalogModelListing)
      .set({
        priceDriftStatus: 'cost_changed',
        effectivePriceFormula: JSON.stringify({
          source: 'catalog_base_price_x_listing_discount',
        }),
        effectivePriceSyncedAt: new Date(),
      })
      .where(eq(catalogModelListing.modelId, model.id));

    // 模型元数据页面到此结束：它只维护模型主记录、分类、能力和基准价，
    // 不得静默创建或修改任何分组折扣。
    if (!('listing' in input)) {
      return { model, basePrice, tiers };
    }

    const listingInput = input.listing;

    const listingPatch: Record<string, unknown> = {
      modelId: model.id,
      groupId: listingInput.groupId,
      statusId: listingInput.statusId,
      inputMicroUsd: input.basePrice.inputMicroUsd ?? 0,
      outputMicroUsd: input.basePrice.outputMicroUsd ?? 0,
      imageInputMicroUsd: input.basePrice.imageInputMicroUsd ?? null,
      imageOutputMicroUsd: input.basePrice.imageOutputMicroUsd ?? null,
      discountRateBps: listingInput.discountRateBps ?? null,
      discountNote: listingInput.discountNote ?? null,
      priceDriftStatus: 'cost_changed',
      effectivePriceFormula: JSON.stringify({
        source: 'catalog_base_price_x_listing_discount',
      }),
      effectivePriceSyncedAt: new Date(),
      description: listingInput.description ?? null,
      featured: listingInput.featured ?? false,
      sortOrder: listingInput.sortOrder ?? 0,
    };

    // 划线价（list price）只在调用方显式传入时才写入。传 undefined 表示
    // 「本表单不管这个字段」——旧实现无条件写 null 会静默抹掉已有划线价
    // （模型编辑表单根本不提交该字段）。显式传 null 仍会清空。
    if (listingInput.listInputMicroUsd !== undefined) {
      listingPatch.listInputMicroUsd = listingInput.listInputMicroUsd;
    }
    if (listingInput.listOutputMicroUsd !== undefined) {
      listingPatch.listOutputMicroUsd = listingInput.listOutputMicroUsd;
    }

    const existingListing = listingInput.id
      ? await getListingByIdInTx(tx, listingInput.id)
      : await getListingByModelAndGroupInTx(tx, model.id, listingInput.groupId);

    const [listing] = existingListing
      ? await tx
          .update(catalogModelListing)
          .set(listingPatch)
          .where(eq(catalogModelListing.id, existingListing.id))
          .returning()
      : await tx
          .insert(catalogModelListing)
          .values({ ...listingPatch, id: getUuid() })
          .returning();

    if (!listing) {
      throw new Error('listing was not saved');
    }

    return { model, listing, basePrice, tiers };
  });
}

async function syncModelCapabilities(
  database: any,
  modelId: string,
  capabilityIds: string[]
): Promise<void> {
  await database
    .delete(catalogModelCapability)
    .where(eq(catalogModelCapability.modelId, modelId));

  if (capabilityIds.length > 0) {
    await database.insert(catalogModelCapability).values(
      capabilityIds.map((capabilityId) => ({
        id: getUuid(),
        modelId,
        capabilityId,
      }))
    );
  }
}

async function syncModelCategories(
  database: any,
  modelId: string,
  categoryIds: string[]
): Promise<void> {
  await database
    .delete(catalogModelCategory)
    .where(eq(catalogModelCategory.modelId, modelId));

  if (categoryIds.length > 0) {
    await database.insert(catalogModelCategory).values(
      categoryIds.map((categoryId) => ({
        id: getUuid(),
        modelId,
        categoryId,
      }))
    );
  }
}

async function getListingByIdInTx(
  database: any,
  id: string
): Promise<Listing | undefined> {
  const [result] = await database
    .select()
    .from(catalogModelListing)
    .where(eq(catalogModelListing.id, id));
  return result;
}

async function getListingByModelAndGroupInTx(
  database: any,
  modelId: string,
  groupId: string
): Promise<Listing | undefined> {
  const [result] = await database
    .select()
    .from(catalogModelListing)
    .where(
      and(
        eq(catalogModelListing.modelId, modelId),
        eq(catalogModelListing.groupId, groupId)
      )
    );
  return result;
}

export async function getGroupNewapiMapping(groupId: string): Promise<string> {
  const [result] = await db()
    .select({ newapiGroup: catalogGroup.newapiGroup })
    .from(catalogGroup)
    .where(eq(catalogGroup.id, groupId));

  return result?.newapiGroup ?? '';
}
