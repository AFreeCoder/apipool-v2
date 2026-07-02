import 'server-only';

import { revalidateTag, unstable_cache } from 'next/cache';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';

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
  imageInputMicroUsd: number | null;
  imageOutputMicroUsd: number | null;
  listInputMicroUsd: number | null;
  listOutputMicroUsd: number | null;
  discountRateBps: number | null;
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
    .where(
      and(
        eq(catalogCapability.slug, capabilitySlug),
        eq(catalogCapability.status, 'active')
      )
    );

  return rows.map((row: { modelPk: string }) => row.modelPk);
}

async function getModelPksWithActiveCapabilities(): Promise<string[]> {
  const rows = await db()
    .selectDistinct({ modelPk: catalogModelCapability.modelId })
    .from(catalogModelCapability)
    .innerJoin(
      catalogCapability,
      eq(catalogModelCapability.capabilityId, catalogCapability.id)
    )
    .where(eq(catalogCapability.status, 'active'));

  return rows.map((row: { modelPk: string }) => row.modelPk);
}

async function queryListingRows({
  filters = {},
  publicVisibleOnly = false,
  callableOnly = false,
}: ListingQueryOptions): Promise<ListingBaseRow[]> {
  const capabilityModelPks = await getModelPksByCapability(filters.capability);
  if (filters.capability && capabilityModelPks?.length === 0) return [];
  const activeCapabilityModelPks =
    publicVisibleOnly || callableOnly
      ? await getModelPksWithActiveCapabilities()
      : undefined;
  if (activeCapabilityModelPks?.length === 0) return [];

  const conditions: any[] = [];
  if (publicVisibleOnly) {
    conditions.push(eq(catalogStatus.isPublicVisible, true));
  }
  if (callableOnly) {
    conditions.push(eq(catalogStatus.isCallable, true));
  }
  if (publicVisibleOnly || callableOnly) {
    conditions.push(eq(catalogVendor.status, 'active'));
    conditions.push(eq(catalogGroup.status, 'active'));
    conditions.push(eq(catalogCategory.status, 'active'));
    conditions.push(eq(catalogStatus.status, 'active'));
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
  if (activeCapabilityModelPks) {
    conditions.push(inArray(catalogModel.id, activeCapabilityModelPks));
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
      imageInputMicroUsd: catalogModelListing.imageInputMicroUsd,
      imageOutputMicroUsd: catalogModelListing.imageOutputMicroUsd,
      listInputMicroUsd: catalogModelListing.listInputMicroUsd,
      listOutputMicroUsd: catalogModelListing.listOutputMicroUsd,
      discountRateBps: catalogModelListing.discountRateBps,
      discountNote: catalogModelListing.discountNote,
      description: catalogModelListing.description,
      statusSlug: catalogStatus.slug,
      statusName: catalogStatus.name,
      isCallable: catalogStatus.isCallable,
    })
    .from(catalogModelListing)
    .innerJoin(catalogModel, eq(catalogModelListing.modelId, catalogModel.id))
    .innerJoin(catalogVendor, eq(catalogModel.vendorId, catalogVendor.id))
    .innerJoin(catalogCategory, eq(catalogModel.category, catalogCategory.slug))
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
    .where(
      and(
        inArray(catalogModelCapability.modelId, modelPks),
        eq(catalogCapability.status, 'active')
      )
    )
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

  return rows
    .map((row) => ({
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
      imageInputMicroUsd: row.imageInputMicroUsd ?? undefined,
      imageOutputMicroUsd: row.imageOutputMicroUsd ?? undefined,
      listInputMicroUsd: row.listInputMicroUsd ?? undefined,
      listOutputMicroUsd: row.listOutputMicroUsd ?? undefined,
      discountRateBps: row.discountRateBps ?? undefined,
      discountNote: row.discountNote ?? undefined,
      description: row.description ?? undefined,
      statusSlug: row.statusSlug,
      statusName: row.statusName,
      isCallable: row.isCallable,
    }))
    .filter((listing) => listing.capabilities.length > 0);
}

export async function getPublicListingsUncached(
  filters: ListingFilters = {}
): Promise<ListingRow[]> {
  const rows = await queryListingRows({ filters, publicVisibleOnly: true });
  return await mapListingRows(rows);
}

export async function getFilterDimensionsUncached(): Promise<FilterDimensions> {
  // Only advertise filter options that match at least one public-visible
  // listing, so a chip never dead-ends into the "no models match" empty state.
  const isPublicVisible = eq(catalogStatus.isPublicVisible, true);
  const publicListingConditions = [
    isPublicVisible,
    eq(catalogVendor.status, 'active'),
    eq(catalogGroup.status, 'active'),
    eq(catalogCategory.status, 'active'),
    eq(catalogStatus.status, 'active'),
    eq(catalogCapability.status, 'active'),
  ];

  const stripSortOrder = <T extends { slug: string; name: string }>(
    rows: T[]
  ) => rows.map(({ slug, name }) => ({ slug, name }));

  const [vendors, groups, categories, capabilities, statuses] =
    await Promise.all([
      db()
        .selectDistinct({
          slug: catalogVendor.slug,
          name: catalogVendor.name,
          sortOrder: catalogVendor.sortOrder,
        })
        .from(catalogModelListing)
        .innerJoin(
          catalogModel,
          eq(catalogModelListing.modelId, catalogModel.id)
        )
        .innerJoin(catalogVendor, eq(catalogModel.vendorId, catalogVendor.id))
        .innerJoin(
          catalogCategory,
          eq(catalogModel.category, catalogCategory.slug)
        )
        .innerJoin(
          catalogGroup,
          eq(catalogModelListing.groupId, catalogGroup.id)
        )
        .innerJoin(
          catalogModelCapability,
          eq(catalogModelCapability.modelId, catalogModel.id)
        )
        .innerJoin(
          catalogCapability,
          eq(catalogModelCapability.capabilityId, catalogCapability.id)
        )
        .innerJoin(
          catalogStatus,
          eq(catalogModelListing.statusId, catalogStatus.id)
        )
        .where(and(...publicListingConditions))
        .orderBy(asc(catalogVendor.sortOrder))
        .then(stripSortOrder),
      db()
        .selectDistinct({
          slug: catalogGroup.slug,
          name: catalogGroup.name,
          sortOrder: catalogGroup.sortOrder,
        })
        .from(catalogModelListing)
        .innerJoin(
          catalogModel,
          eq(catalogModelListing.modelId, catalogModel.id)
        )
        .innerJoin(catalogVendor, eq(catalogModel.vendorId, catalogVendor.id))
        .innerJoin(
          catalogCategory,
          eq(catalogModel.category, catalogCategory.slug)
        )
        .innerJoin(
          catalogGroup,
          eq(catalogModelListing.groupId, catalogGroup.id)
        )
        .innerJoin(
          catalogModelCapability,
          eq(catalogModelCapability.modelId, catalogModel.id)
        )
        .innerJoin(
          catalogCapability,
          eq(catalogModelCapability.capabilityId, catalogCapability.id)
        )
        .innerJoin(
          catalogStatus,
          eq(catalogModelListing.statusId, catalogStatus.id)
        )
        .where(and(...publicListingConditions))
        .orderBy(asc(catalogGroup.sortOrder))
        .then(stripSortOrder),
      db()
        .selectDistinct({
          slug: catalogCategory.slug,
          name: catalogCategory.name,
          sortOrder: catalogCategory.sortOrder,
        })
        .from(catalogModelListing)
        .innerJoin(
          catalogModel,
          eq(catalogModelListing.modelId, catalogModel.id)
        )
        .innerJoin(catalogVendor, eq(catalogModel.vendorId, catalogVendor.id))
        .innerJoin(
          catalogCategory,
          eq(catalogModel.category, catalogCategory.slug)
        )
        .innerJoin(
          catalogGroup,
          eq(catalogModelListing.groupId, catalogGroup.id)
        )
        .innerJoin(
          catalogModelCapability,
          eq(catalogModelCapability.modelId, catalogModel.id)
        )
        .innerJoin(
          catalogCapability,
          eq(catalogModelCapability.capabilityId, catalogCapability.id)
        )
        .innerJoin(
          catalogStatus,
          eq(catalogModelListing.statusId, catalogStatus.id)
        )
        .where(and(...publicListingConditions))
        .orderBy(asc(catalogCategory.sortOrder))
        .then(stripSortOrder),
      db()
        .selectDistinct({
          slug: catalogCapability.slug,
          name: catalogCapability.name,
          sortOrder: catalogCapability.sortOrder,
        })
        .from(catalogModelListing)
        .innerJoin(
          catalogModel,
          eq(catalogModelListing.modelId, catalogModel.id)
        )
        .innerJoin(catalogVendor, eq(catalogModel.vendorId, catalogVendor.id))
        .innerJoin(
          catalogCategory,
          eq(catalogModel.category, catalogCategory.slug)
        )
        .innerJoin(
          catalogGroup,
          eq(catalogModelListing.groupId, catalogGroup.id)
        )
        .innerJoin(
          catalogStatus,
          eq(catalogModelListing.statusId, catalogStatus.id)
        )
        .innerJoin(
          catalogModelCapability,
          eq(catalogModelCapability.modelId, catalogModel.id)
        )
        .innerJoin(
          catalogCapability,
          eq(catalogModelCapability.capabilityId, catalogCapability.id)
        )
        .where(and(...publicListingConditions))
        .orderBy(asc(catalogCapability.sortOrder))
        .then(stripSortOrder),
      db()
        .selectDistinct({
          slug: catalogStatus.slug,
          name: catalogStatus.name,
          sortOrder: catalogStatus.sortOrder,
        })
        .from(catalogModelListing)
        .innerJoin(
          catalogModel,
          eq(catalogModelListing.modelId, catalogModel.id)
        )
        .innerJoin(catalogVendor, eq(catalogModel.vendorId, catalogVendor.id))
        .innerJoin(
          catalogCategory,
          eq(catalogModel.category, catalogCategory.slug)
        )
        .innerJoin(
          catalogGroup,
          eq(catalogModelListing.groupId, catalogGroup.id)
        )
        .innerJoin(
          catalogModelCapability,
          eq(catalogModelCapability.modelId, catalogModel.id)
        )
        .innerJoin(
          catalogCapability,
          eq(catalogModelCapability.capabilityId, catalogCapability.id)
        )
        .innerJoin(
          catalogStatus,
          eq(catalogModelListing.statusId, catalogStatus.id)
        )
        .where(and(...publicListingConditions))
        .orderBy(asc(catalogStatus.sortOrder))
        .then(stripSortOrder),
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

export async function getSmokeTestedCallableModelIdsByGroupUncached(
  groupSlug: string
): Promise<string[]> {
  const rows = await db()
    .selectDistinct({
      modelId: catalogModel.modelId,
    })
    .from(catalogModelListing)
    .innerJoin(catalogModel, eq(catalogModelListing.modelId, catalogModel.id))
    .innerJoin(catalogVendor, eq(catalogModel.vendorId, catalogVendor.id))
    .innerJoin(catalogCategory, eq(catalogModel.category, catalogCategory.slug))
    .innerJoin(catalogGroup, eq(catalogModelListing.groupId, catalogGroup.id))
    .innerJoin(
      catalogModelCapability,
      eq(catalogModelCapability.modelId, catalogModel.id)
    )
    .innerJoin(
      catalogCapability,
      eq(catalogModelCapability.capabilityId, catalogCapability.id)
    )
    .innerJoin(
      catalogStatus,
      eq(catalogModelListing.statusId, catalogStatus.id)
    )
    .where(
      and(
        eq(catalogGroup.slug, groupSlug),
        eq(catalogGroup.status, 'active'),
        eq(catalogVendor.status, 'active'),
        eq(catalogCategory.status, 'active'),
        eq(catalogStatus.status, 'active'),
        eq(catalogCapability.status, 'active'),
        eq(catalogStatus.isCallable, true),
        eq(catalogModelListing.smokeTested, true)
      )
    )
    .orderBy(asc(catalogModelListing.sortOrder));

  return rows.map((row: { modelId: string }) => row.modelId);
}

export async function getGroupsForKeyCreationUncached(): Promise<
  { slug: string; name: string; userDescription?: string }[]
> {
  const rows = await db()
    .select({
      slug: catalogGroup.slug,
      name: catalogGroup.name,
      userDescription: catalogGroup.userDescription,
      sortOrder: catalogGroup.sortOrder,
    })
    .from(catalogGroup)
    .where(
      and(
        eq(catalogGroup.status, 'active'),
        eq(catalogGroup.allowCreateKey, true),
        sql`trim(${catalogGroup.newapiGroup}) <> ''`
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
