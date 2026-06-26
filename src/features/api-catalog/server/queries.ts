import 'server-only';

import { revalidateTag, unstable_cache } from 'next/cache';
import { and, asc, eq, inArray } from 'drizzle-orm';

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

import type { FilterDimensions, ListingRow } from '../lib/types';

const CATALOG_CACHE_TAG = 'catalog';

export type ListingFilters = {
  vendor?: string;
  group?: string;
  category?: string;
  capability?: string;
  status?: string;
};

type ListingBaseRow = {
  modelPk: string;
  modelId: string;
  displayName: string;
  vendorName: string;
  groupName: string;
  groupSlug: string;
  category: string;
  contextWindow: number | null;
  inputMicroUsd: number;
  outputMicroUsd: number;
  listInputMicroUsd: number | null;
  listOutputMicroUsd: number | null;
  discountNote: string | null;
  description: string | null;
  statusSlug: string;
  statusName: string;
  isCallable: boolean;
};

type ListingQueryOptions = {
  filters?: ListingFilters;
  publicVisibleOnly?: boolean;
  callableOnly?: boolean;
};

async function getModelPksByCapability(
  capabilitySlug?: string
): Promise<string[] | undefined> {
  if (!capabilitySlug) return undefined;

  const rows = await db()
    .select({ modelPk: catalogModelCapability.modelId })
    .from(catalogModelCapability)
    .innerJoin(
      catalogCapability,
      eq(catalogModelCapability.capabilityId, catalogCapability.id)
    )
    .where(eq(catalogCapability.slug, capabilitySlug));

  return rows.map((row: { modelPk: string }) => row.modelPk);
}

async function queryListingRows({
  filters = {},
  publicVisibleOnly = false,
  callableOnly = false,
}: ListingQueryOptions): Promise<ListingBaseRow[]> {
  const capabilityModelPks = await getModelPksByCapability(filters.capability);
  if (filters.capability && capabilityModelPks?.length === 0) return [];

  const conditions: any[] = [];
  if (publicVisibleOnly) {
    conditions.push(eq(catalogStatus.isPublicVisible, true));
  }
  if (callableOnly) {
    conditions.push(eq(catalogStatus.isCallable, true));
  }
  if (filters.vendor) {
    conditions.push(eq(catalogVendor.slug, filters.vendor));
  }
  if (filters.group) {
    conditions.push(eq(catalogGroup.slug, filters.group));
  }
  if (filters.category) {
    conditions.push(eq(catalogModel.category, filters.category));
  }
  if (filters.status) {
    conditions.push(eq(catalogStatus.slug, filters.status));
  }
  if (capabilityModelPks) {
    conditions.push(inArray(catalogModel.id, capabilityModelPks));
  }

  return await db()
    .select({
      modelPk: catalogModel.id,
      modelId: catalogModel.modelId,
      displayName: catalogModel.displayName,
      vendorName: catalogVendor.name,
      groupName: catalogGroup.name,
      groupSlug: catalogGroup.slug,
      category: catalogModel.category,
      contextWindow: catalogModel.contextWindow,
      inputMicroUsd: catalogModelListing.inputMicroUsd,
      outputMicroUsd: catalogModelListing.outputMicroUsd,
      listInputMicroUsd: catalogModelListing.listInputMicroUsd,
      listOutputMicroUsd: catalogModelListing.listOutputMicroUsd,
      discountNote: catalogModelListing.discountNote,
      description: catalogModelListing.description,
      statusSlug: catalogStatus.slug,
      statusName: catalogStatus.name,
      isCallable: catalogStatus.isCallable,
    })
    .from(catalogModelListing)
    .innerJoin(catalogModel, eq(catalogModelListing.modelId, catalogModel.id))
    .innerJoin(catalogVendor, eq(catalogModel.vendorId, catalogVendor.id))
    .innerJoin(catalogGroup, eq(catalogModelListing.groupId, catalogGroup.id))
    .innerJoin(
      catalogStatus,
      eq(catalogModelListing.statusId, catalogStatus.id)
    )
    .where(and(...conditions))
    .orderBy(asc(catalogModelListing.sortOrder));
}

async function getCapabilitiesByModelPk(modelPks: string[]) {
  if (modelPks.length === 0) return new Map<string, string[]>();

  const rows = await db()
    .select({
      modelPk: catalogModelCapability.modelId,
      capabilitySlug: catalogCapability.slug,
    })
    .from(catalogModelCapability)
    .innerJoin(
      catalogCapability,
      eq(catalogModelCapability.capabilityId, catalogCapability.id)
    )
    .where(inArray(catalogModelCapability.modelId, modelPks))
    .orderBy(asc(catalogCapability.sortOrder));

  const capabilitiesByModelPk = new Map<string, string[]>();
  for (const row of rows as { modelPk: string; capabilitySlug: string }[]) {
    const capabilities = capabilitiesByModelPk.get(row.modelPk) ?? [];
    capabilities.push(row.capabilitySlug);
    capabilitiesByModelPk.set(row.modelPk, capabilities);
  }

  return capabilitiesByModelPk;
}

async function mapListingRows(rows: ListingBaseRow[]): Promise<ListingRow[]> {
  const modelPks = [...new Set(rows.map((row) => row.modelPk))];
  const capabilitiesByModelPk = await getCapabilitiesByModelPk(modelPks);

  return rows.map((row) => ({
    modelId: row.modelId,
    displayName: row.displayName,
    vendorName: row.vendorName,
    groupName: row.groupName,
    groupSlug: row.groupSlug,
    category: row.category,
    capabilities: capabilitiesByModelPk.get(row.modelPk) ?? [],
    contextWindow: row.contextWindow,
    inputMicroUsd: row.inputMicroUsd,
    outputMicroUsd: row.outputMicroUsd,
    listInputMicroUsd: row.listInputMicroUsd ?? undefined,
    listOutputMicroUsd: row.listOutputMicroUsd ?? undefined,
    discountNote: row.discountNote ?? undefined,
    description: row.description ?? undefined,
    statusSlug: row.statusSlug,
    statusName: row.statusName,
    isCallable: row.isCallable,
  }));
}

export async function getPublicListingsUncached(
  filters: ListingFilters = {}
): Promise<ListingRow[]> {
  const rows = await queryListingRows({ filters, publicVisibleOnly: true });
  return await mapListingRows(rows);
}

export async function getFilterDimensionsUncached(): Promise<FilterDimensions> {
  const [vendors, groups, categories, capabilities, statuses] =
    await Promise.all([
      db()
        .select({ slug: catalogVendor.slug, name: catalogVendor.name })
        .from(catalogVendor)
        .where(eq(catalogVendor.status, 'active'))
        .orderBy(asc(catalogVendor.sortOrder)),
      db()
        .select({ slug: catalogGroup.slug, name: catalogGroup.name })
        .from(catalogGroup)
        .where(eq(catalogGroup.status, 'active'))
        .orderBy(asc(catalogGroup.sortOrder)),
      db()
        .select({ slug: catalogCategory.slug, name: catalogCategory.name })
        .from(catalogCategory)
        .where(eq(catalogCategory.status, 'active'))
        .orderBy(asc(catalogCategory.sortOrder)),
      db()
        .select({ slug: catalogCapability.slug, name: catalogCapability.name })
        .from(catalogCapability)
        .where(eq(catalogCapability.status, 'active'))
        .orderBy(asc(catalogCapability.sortOrder)),
      db()
        .select({ slug: catalogStatus.slug, name: catalogStatus.name })
        .from(catalogStatus)
        .where(eq(catalogStatus.status, 'active'))
        .orderBy(asc(catalogStatus.sortOrder)),
    ]);

  return { vendors, groups, categories, capabilities, statuses };
}

export async function getCallableListingsByGroupUncached(
  groupSlug: string
): Promise<ListingRow[]> {
  const rows = await queryListingRows({
    filters: { group: groupSlug },
    callableOnly: true,
  });
  return await mapListingRows(rows);
}

export async function getGroupsForKeyCreationUncached(): Promise<
  { slug: string; name: string; userDescription?: string }[]
> {
  const rows = await db()
    .select({
      slug: catalogGroup.slug,
      name: catalogGroup.name,
      userDescription: catalogGroup.userDescription,
    })
    .from(catalogGroup)
    .where(
      and(
        eq(catalogGroup.status, 'active'),
        eq(catalogGroup.allowCreateKey, true)
      )
    )
    .orderBy(asc(catalogGroup.sortOrder));

  return rows.map(
    (row: { slug: string; name: string; userDescription: string | null }) => ({
      slug: row.slug,
      name: row.name,
      userDescription: row.userDescription ?? undefined,
    })
  );
}

export const getPublicListings = unstable_cache(
  getPublicListingsUncached,
  ['api-catalog-public-listings'],
  { tags: [CATALOG_CACHE_TAG] }
);

export const getFilterDimensions = unstable_cache(
  getFilterDimensionsUncached,
  ['api-catalog-filter-dimensions'],
  { tags: [CATALOG_CACHE_TAG] }
);

export const getCallableListingsByGroup = unstable_cache(
  getCallableListingsByGroupUncached,
  ['api-catalog-callable-listings-by-group'],
  { tags: [CATALOG_CACHE_TAG] }
);

export const getGroupsForKeyCreation = unstable_cache(
  getGroupsForKeyCreationUncached,
  ['api-catalog-groups-for-key-creation'],
  { tags: [CATALOG_CACHE_TAG] }
);

export function revalidateCatalog(): void {
  revalidateTag(CATALOG_CACHE_TAG, 'max');
}
