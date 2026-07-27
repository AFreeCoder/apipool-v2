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
  catalogModelPricingProfile,
  catalogModelPricingRate,
  catalogStatus,
  catalogVendor,
  newApiKeyBinding,
} from '@/config/db/schema';
import { db } from '@/core/db';
import { getUuid } from '@/shared/lib/hash';

export type Vendor = typeof catalogVendor.$inferSelect;
export type Capability = typeof catalogCapability.$inferSelect;
export type CatalogStatus = typeof catalogStatus.$inferSelect;
export type CatalogGroup = typeof catalogGroup.$inferSelect;
export type Model = typeof catalogModel.$inferSelect;
export type Listing = typeof catalogModelListing.$inferSelect;
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
  model: {
    modelId: string;
    displayName: string;
    vendorId: string;
    categoryIds: string[];
  };
  capabilityIds: string[];
};

export type ModelAdminConfigResult = {
  model: Model;
};

export type ModelAdminRow = {
  id: string;
  modelId: string;
  displayName: string;
  vendorName: string;
  categoryNames: string;
  capabilityNames: string;
  pricingProfileCount: number;
  createdAt: Date;
};

export type ModelAdminConfig = {
  model: Model;
  listing?: Listing;
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

  const [result] = await db()
    .update(catalogGroup)
    .set(patch)
    .where(eq(catalogGroup.id, id))
    .returning();
  return result;
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

export async function getModelAdminRows(): Promise<ModelAdminRow[]> {
  const [models, vendors] = await Promise.all([getModels(), getVendors()]);
  if (models.length === 0) return [];

  const vendorNames = new Map(
    vendors.map((vendor) => [vendor.id, vendor.name] as const)
  );
  const modelIds = models.map((model) => model.id);

  // 模型元数据列表只展示模型事实和定价档案数量，不展示或选择任何计费方式。
  const [categoryRows, capabilityRows, profileRows] = await Promise.all([
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
      .select({ modelId: catalogModelPricingProfile.modelId })
      .from(catalogModelPricingProfile)
      .where(inArray(catalogModelPricingProfile.modelId, modelIds)),
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
  const profileCountByModel = new Map<string, number>();
  for (const profile of profileRows) {
    profileCountByModel.set(
      profile.modelId,
      (profileCountByModel.get(profile.modelId) ?? 0) + 1
    );
  }

  return models.map((model) => {
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
      pricingProfileCount: profileCountByModel.get(model.id) ?? 0,
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

  const [listings, categories, capabilities] = await Promise.all([
    getListingsByModel(model.id),
    getModelCategories(model.id),
    getModelCapabilities(model.id),
  ]);

  return {
    model,
    listing: listings[0],
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
    const profiles = await tx
      .select({ id: catalogModelPricingProfile.id })
      .from(catalogModelPricingProfile)
      .where(eq(catalogModelPricingProfile.modelId, id));
    await tx
      .delete(catalogModelListing)
      .where(eq(catalogModelListing.modelId, id));
    if (profiles.length > 0) {
      await tx.delete(catalogModelPricingRate).where(
        inArray(
          catalogModelPricingRate.profileId,
          profiles.map((profile: { id: string }) => profile.id)
        )
      );
    }
    await tx
      .delete(catalogModelPricingProfile)
      .where(eq(catalogModelPricingProfile.modelId, id));
    await tx
      .delete(catalogModelPriceTier)
      .where(eq(catalogModelPriceTier.modelId, id));
    await tx.delete(catalogModelPrice).where(eq(catalogModelPrice.modelId, id));
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

export async function upsertModelAdminConfig(
  input: ModelAdminConfigInput
): Promise<ModelAdminConfigResult> {
  if (input.model.categoryIds.length === 0) {
    throw new Error('at least one category is required');
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
    // 模型元数据写入在此结束。售卖计费只允许在定价档案和 listing 中维护。
    return { model };
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
