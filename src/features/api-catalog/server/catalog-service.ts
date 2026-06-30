import { asc, eq } from 'drizzle-orm';

import { db } from '@/core/db';
import {
  catalogCapability,
  catalogCategory,
  catalogGroup,
  catalogModel,
  catalogModelCapability,
  catalogModelListing,
  catalogStatus,
  catalogVendor,
} from '@/config/db/schema';
import { getUuid } from '@/shared/lib/hash';

export type Vendor = typeof catalogVendor.$inferSelect;
export type Capability = typeof catalogCapability.$inferSelect;
export type CatalogStatus = typeof catalogStatus.$inferSelect;
export type CatalogGroup = typeof catalogGroup.$inferSelect;
export type Model = typeof catalogModel.$inferSelect;
export type Listing = typeof catalogModelListing.$inferSelect;

export type NewVendor = typeof catalogVendor.$inferInsert;
export type NewCapability = typeof catalogCapability.$inferInsert;
export type NewCatalogStatus = typeof catalogStatus.$inferInsert;
export type NewCatalogGroup = typeof catalogGroup.$inferInsert;
export type NewModel = typeof catalogModel.$inferInsert;
export type NewListing = typeof catalogModelListing.$inferInsert;

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
  const [result] = await db()
    .update(catalogVendor)
    .set(patch)
    .where(eq(catalogVendor.id, id))
    .returning();
  return result;
}

export async function deleteVendor(id: string): Promise<void> {
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
  const [result] = await db()
    .update(catalogCategory)
    .set(patch)
    .where(eq(catalogCategory.id, id))
    .returning();
  return result;
}

export async function deleteCategory(id: string): Promise<void> {
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
  const [result] = await db()
    .update(catalogCapability)
    .set(patch)
    .where(eq(catalogCapability.id, id))
    .returning();
  return result;
}

export async function deleteCapability(id: string): Promise<void> {
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
  const [result] = await db()
    .update(catalogStatus)
    .set(patch)
    .where(eq(catalogStatus.id, id))
    .returning();
  return result;
}

export async function deleteStatus(id: string): Promise<void> {
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
  const [result] = await db()
    .update(catalogGroup)
    .set(patch)
    .where(eq(catalogGroup.id, id))
    .returning();
  return result;
}

export async function deleteGroup(id: string): Promise<void> {
  await db().delete(catalogGroup).where(eq(catalogGroup.id, id));
}

export async function getModels(): Promise<Model[]> {
  return await db()
    .select()
    .from(catalogModel)
    .orderBy(asc(catalogModel.displayName));
}

export async function getModelById(id: string): Promise<Model | undefined> {
  const [result] = await db()
    .select()
    .from(catalogModel)
    .where(eq(catalogModel.id, id));
  return result;
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
  await db().delete(catalogModel).where(eq(catalogModel.id, id));
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

export async function setModelCapabilities(
  modelId: string,
  capabilityIds: string[]
): Promise<void> {
  await db()
    .delete(catalogModelCapability)
    .where(eq(catalogModelCapability.modelId, modelId));

  if (capabilityIds.length > 0) {
    await db()
      .insert(catalogModelCapability)
      .values(
        capabilityIds.map((capabilityId) => ({
          id: getUuid(),
          modelId,
          capabilityId,
        }))
      );
  }
}

export async function getGroupNewapiMapping(groupId: string): Promise<string> {
  const [result] = await db()
    .select({ newapiGroup: catalogGroup.newapiGroup })
    .from(catalogGroup)
    .where(eq(catalogGroup.id, groupId));

  return result?.newapiGroup ?? '';
}
