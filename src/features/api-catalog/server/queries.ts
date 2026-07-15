import 'server-only';

import { revalidateTag, unstable_cache } from 'next/cache';
import { resolveEffectiveCatalogPrice } from '@/features/api-catalog/lib/pricing';
import { and, asc, eq, inArray, ne } from 'drizzle-orm';

import { db } from '@/core/db';
import {
  catalogCapability,
  catalogCategory,
  catalogGroup,
  catalogModel,
  catalogModelCapability,
  catalogModelListing,
  catalogModelPrice,
  catalogStatus,
  catalogVendor,
  modelPriceVersion,
  modelRoute,
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
  groupId: string;
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
  groupRatioBps: number | null;
  pricePolicy: string;
  overrideInputMicroUsd: number | null;
  overrideOutputMicroUsd: number | null;
  overrideImageInputMicroUsd: number | null;
  overrideImageOutputMicroUsd: number | null;
  overrideStatus: string;
  priceDriftStatus: string;
  baseInputMicroUsd: number | null;
  baseOutputMicroUsd: number | null;
  baseImageInputMicroUsd: number | null;
  baseImageOutputMicroUsd: number | null;
  statusSlug: string;
  statusName: string;
  isCallable: boolean;
};

type ListingQueryOptions = {
  filters?: ListingFilters;
  publicVisibleOnly?: boolean;
  callableOnly?: boolean;
  exactGroupId?: string;
  exactPortalModelId?: string;
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
  exactGroupId,
  exactPortalModelId,
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
  if (exactGroupId) {
    conditions.push(eq(catalogGroup.id, exactGroupId));
  }
  if (exactPortalModelId) {
    conditions.push(eq(catalogModel.modelId, exactPortalModelId));
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
      groupId: catalogGroup.id,
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
      groupRatioBps: catalogGroup.newapiGroupRatioBps,
      pricePolicy: catalogModelListing.pricePolicy,
      overrideInputMicroUsd: catalogModelListing.overrideInputMicroUsd,
      overrideOutputMicroUsd: catalogModelListing.overrideOutputMicroUsd,
      overrideImageInputMicroUsd:
        catalogModelListing.overrideImageInputMicroUsd,
      overrideImageOutputMicroUsd:
        catalogModelListing.overrideImageOutputMicroUsd,
      overrideStatus: catalogModelListing.overrideStatus,
      priceDriftStatus: catalogModelListing.priceDriftStatus,
      baseInputMicroUsd: catalogModelPrice.baseInputMicroUsd,
      baseOutputMicroUsd: catalogModelPrice.baseOutputMicroUsd,
      baseImageInputMicroUsd: catalogModelPrice.baseImageInputMicroUsd,
      baseImageOutputMicroUsd: catalogModelPrice.baseImageOutputMicroUsd,
      statusSlug: catalogStatus.slug,
      statusName: catalogStatus.name,
      isCallable: catalogStatus.isCallable,
    })
    .from(catalogModelListing)
    .innerJoin(catalogModel, eq(catalogModelListing.modelId, catalogModel.id))
    .innerJoin(catalogVendor, eq(catalogModel.vendorId, catalogVendor.id))
    .innerJoin(catalogCategory, eq(catalogModel.category, catalogCategory.slug))
    .innerJoin(catalogGroup, eq(catalogModelListing.groupId, catalogGroup.id))
    .leftJoin(catalogModelPrice, eq(catalogModelPrice.modelId, catalogModel.id))
    .innerJoin(
      catalogStatus,
      eq(catalogModelListing.statusId, catalogStatus.id)
    )
    .where(and(...conditions))
    .orderBy(asc(catalogModelListing.sortOrder));
}

function routePriceKey(portalGroupId: string, portalModelId: string) {
  return `${portalGroupId}\u0000${portalModelId}`;
}

async function getActiveRoutePriceKeys(
  listings: Pick<ListingBaseRow, 'groupId' | 'modelId'>[]
): Promise<Set<string>> {
  if (listings.length === 0) return new Set();

  const groupIds = [...new Set(listings.map((listing) => listing.groupId))];
  const modelIds = [...new Set(listings.map((listing) => listing.modelId))];
  let rows: { portalGroupId: string; portalModelId: string }[];
  try {
    rows = await db()
      .select({
        portalGroupId: modelRoute.portalGroupId,
        portalModelId: modelRoute.portalModelId,
      })
      .from(modelRoute)
      .innerJoin(
        modelPriceVersion,
        and(
          eq(modelPriceVersion.portalGroupId, modelRoute.portalGroupId),
          eq(modelPriceVersion.portalModelId, modelRoute.portalModelId),
          eq(modelPriceVersion.status, 'active')
        )
      )
      .where(
        and(
          eq(modelRoute.status, 'active'),
          inArray(modelRoute.portalGroupId, groupIds),
          inArray(modelRoute.portalModelId, modelIds)
        )
      );
  } catch (error) {
    // 旧迁移隔离检查会有意运行在路由表出现前的 schema。此时只把 CTA
    // 关闭（fail-closed）；连接、SQL 等其他错误仍必须向上传播。
    let cause: unknown = error;
    for (let depth = 0; depth < 4 && cause; depth += 1) {
      const message = cause instanceof Error ? cause.message : String(cause);
      if (/no such table: (model_route|model_price_version)/.test(message)) {
        return new Set();
      }
      cause = cause instanceof Error ? cause.cause : undefined;
    }
    throw error;
  }

  return new Set(
    rows.map((row) =>
      routePriceKey(row.portalGroupId, row.portalModelId)
    )
  );
}

// 网关与公开目录复用同一条完整 catalog + active route + active price
// 判定，避免紧急下线维度漂移。
export async function isListingCallable(
  portalGroupId: string,
  portalModelId: string
): Promise<boolean> {
  const rows = await queryListingRows({
    callableOnly: true,
    exactGroupId: portalGroupId,
    exactPortalModelId: portalModelId,
  });
  const activeRoutePriceKeys = await getActiveRoutePriceKeys(rows);
  return rows.some((row) =>
    activeRoutePriceKeys.has(routePriceKey(row.groupId, row.modelId))
  );
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
  const [capabilitiesByModelPk, activeRoutePriceKeys] = await Promise.all([
    getCapabilitiesByModelPk(modelPks),
    getActiveRoutePriceKeys(rows),
  ]);

  return rows
    .map((row) => {
      const effective = resolveEffectiveCatalogPrice({
        baseInputMicroUsd: row.baseInputMicroUsd,
        baseOutputMicroUsd: row.baseOutputMicroUsd,
        baseImageInputMicroUsd: row.baseImageInputMicroUsd,
        baseImageOutputMicroUsd: row.baseImageOutputMicroUsd,
        groupRatioBps: row.groupRatioBps,
        pricePolicy: row.pricePolicy,
        discountRateBps: row.discountRateBps,
        overrideInputMicroUsd: row.overrideInputMicroUsd,
        overrideOutputMicroUsd: row.overrideOutputMicroUsd,
        overrideImageInputMicroUsd: row.overrideImageInputMicroUsd,
        overrideImageOutputMicroUsd: row.overrideImageOutputMicroUsd,
        overrideStatus: row.overrideStatus,
        priceDriftStatus: row.priceDriftStatus,
        listInputMicroUsd: row.listInputMicroUsd,
        listOutputMicroUsd: row.listOutputMicroUsd,
        discountNote: row.discountNote,
      });

      return {
        modelId: row.modelId,
        displayName: row.displayName,
        vendorName: row.vendorName,
        groupName: row.groupName,
        groupSlug: row.groupSlug,
        category: row.category,
        capabilities: capabilitiesByModelPk.get(row.modelPk) ?? [],
        contextWindow: row.contextWindow,
        inputMicroUsd: effective.publicConfirmed
          ? (effective.effectiveInputMicroUsd ?? undefined)
          : undefined,
        outputMicroUsd: effective.publicConfirmed
          ? (effective.effectiveOutputMicroUsd ?? undefined)
          : undefined,
        imageInputMicroUsd: effective.publicConfirmed
          ? (effective.effectiveImageInputMicroUsd ?? undefined)
          : undefined,
        imageOutputMicroUsd: effective.publicConfirmed
          ? (effective.effectiveImageOutputMicroUsd ?? undefined)
          : undefined,
        listInputMicroUsd: effective.publicConfirmed
          ? (effective.listInputMicroUsd ?? undefined)
          : undefined,
        listOutputMicroUsd: effective.publicConfirmed
          ? (effective.listOutputMicroUsd ?? undefined)
          : undefined,
        discountRateBps:
          effective.publicConfirmed && row.discountRateBps !== null
            ? row.discountRateBps
            : undefined,
        discountNote: effective.publicConfirmed
          ? (row.discountNote ?? undefined)
          : undefined,
        description: row.description ?? undefined,
        statusSlug: row.statusSlug,
        statusName: row.statusName,
        isCallable:
          row.isCallable &&
          activeRoutePriceKeys.has(routePriceKey(row.groupId, row.modelId)),
        effectiveInputMicroUsd: effective.publicConfirmed
          ? (effective.effectiveInputMicroUsd ?? undefined)
          : undefined,
        effectiveOutputMicroUsd: effective.publicConfirmed
          ? (effective.effectiveOutputMicroUsd ?? undefined)
          : undefined,
        effectiveImageInputMicroUsd: effective.publicConfirmed
          ? (effective.effectiveImageInputMicroUsd ?? undefined)
          : undefined,
        effectiveImageOutputMicroUsd: effective.publicConfirmed
          ? (effective.effectiveImageOutputMicroUsd ?? undefined)
          : undefined,
        pricePresentation: effective.pricePresentation,
      };
    })
    .filter((listing) => listing.capabilities.length > 0);
}

export async function getPublicListingsUncached(
  filters: ListingFilters = {}
): Promise<ListingRow[]> {
  const rows = await queryListingRows({ filters, publicVisibleOnly: true });
  return await mapListingRows(rows);
}

export async function getFilterDimensionsUncached(): Promise<FilterDimensions> {
  const stripSortOrder = <T extends { slug: string; name: string }>(
    rows: T[]
  ) => rows.map(({ slug, name }) => ({ slug, name }));

  const [vendors, groups, categories, capabilities, statuses] =
    await Promise.all([
      db()
        .select({
          slug: catalogVendor.slug,
          name: catalogVendor.name,
          sortOrder: catalogVendor.sortOrder,
        })
        .from(catalogVendor)
        .where(eq(catalogVendor.status, 'active'))
        .orderBy(asc(catalogVendor.sortOrder))
        .then(stripSortOrder),
      db()
        .select({
          slug: catalogGroup.slug,
          name: catalogGroup.name,
          sortOrder: catalogGroup.sortOrder,
        })
        .from(catalogGroup)
        .where(eq(catalogGroup.status, 'active'))
        .orderBy(asc(catalogGroup.sortOrder))
        .then(stripSortOrder),
      db()
        .select({
          slug: catalogCategory.slug,
          name: catalogCategory.name,
          sortOrder: catalogCategory.sortOrder,
        })
        .from(catalogCategory)
        .where(eq(catalogCategory.status, 'active'))
        .orderBy(asc(catalogCategory.sortOrder))
        .then(stripSortOrder),
      db()
        .select({
          slug: catalogCapability.slug,
          name: catalogCapability.name,
          sortOrder: catalogCapability.sortOrder,
        })
        .from(catalogCapability)
        .where(eq(catalogCapability.status, 'active'))
        .orderBy(asc(catalogCapability.sortOrder))
        .then(stripSortOrder),
      db()
        .select({
          slug: catalogStatus.slug,
          name: catalogStatus.name,
          sortOrder: catalogStatus.sortOrder,
        })
        .from(catalogStatus)
        .where(eq(catalogStatus.status, 'active'))
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
  return (await mapListingRows(rows)).filter((listing) => listing.isCallable);
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
        // 新建分组默认 allowCreateKey=true 且 newapiGroup=''：admin 还没填映射
        // 就进了下拉，用户选中后 createPortalApiKey 必然抛 group not available。
        ne(catalogGroup.newapiGroup, ''),
        // 价格同步已经证明远端不存在这个分组；映射非空也没用。
        // 'unknown'（从未同步）必须放行——初始 seed 的分组就是 unknown。
        ne(catalogGroup.pricingSyncStatus, 'missing_remote_group')
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
