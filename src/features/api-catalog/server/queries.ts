import 'server-only';

import { revalidateTag, unstable_cache } from 'next/cache';
import { and, asc, eq, inArray, ne } from 'drizzle-orm';

import {
  catalogCapability,
  catalogCategory,
  catalogGroup,
  catalogModel,
  catalogModelCapability,
  catalogModelListing,
  catalogModelPrice,
  catalogModelPriceTier,
  catalogStatus,
  catalogVendor,
} from '@/config/db/schema';
import { db } from '@/core/db';
import {
  resolveEffectiveCatalogPrice,
  scaleMicroUsdByBps,
} from '@/features/api-catalog/lib/pricing';
import { assessPublishReadiness } from '@/features/api-catalog/server/publish-readiness';

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
  priceDriftStatus: string;
  baseInputMicroUsd: number | null;
  baseOutputMicroUsd: number | null;
  baseCachedInputMicroUsd: number | null;
  baseCacheWrite5mMicroUsd: number | null;
  baseCacheWrite1hMicroUsd: number | null;
  baseImageInputMicroUsd: number | null;
  baseImageOutputMicroUsd: number | null;
  billingScheme: string;
  endpointTypesJson: string | null;
  statusSlug: string;
  statusName: string;
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
      priceDriftStatus: catalogModelListing.priceDriftStatus,
      baseInputMicroUsd: catalogModelPrice.baseInputMicroUsd,
      baseOutputMicroUsd: catalogModelPrice.baseOutputMicroUsd,
      baseCachedInputMicroUsd: catalogModelPrice.baseCachedInputMicroUsd,
      baseCacheWrite5mMicroUsd: catalogModelPrice.baseCacheWrite5mMicroUsd,
      baseCacheWrite1hMicroUsd: catalogModelPrice.baseCacheWrite1hMicroUsd,
      baseImageInputMicroUsd: catalogModelPrice.baseImageInputMicroUsd,
      baseImageOutputMicroUsd: catalogModelPrice.baseImageOutputMicroUsd,
      billingScheme: catalogModelPrice.billingScheme,
      endpointTypesJson: catalogModelPrice.sourceSupportedEndpointTypes,
      statusSlug: catalogStatus.slug,
      statusName: catalogStatus.name,
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

// 路由可用性只取决于模型目录中的分组映射、基准价和售卖状态。
// model_route/model_price_version 是请求审计快照，不再是第二套人工配置。
export async function isListingCallable(
  portalGroupId: string,
  portalModelId: string
): Promise<boolean> {
  return (await assessPublishReadiness(portalGroupId, portalModelId)).ready;
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

async function getTiersByModelPk(modelPks: string[]) {
  if (modelPks.length === 0) {
    return new Map<
      string,
      { skuKey: string; priceMicroUsd: number; note: string | null }[]
    >();
  }
  const rows = await db()
    .select({
      modelPk: catalogModelPriceTier.modelId,
      skuKey: catalogModelPriceTier.skuKey,
      priceMicroUsd: catalogModelPriceTier.priceMicroUsd,
      note: catalogModelPriceTier.note,
    })
    .from(catalogModelPriceTier)
    .where(inArray(catalogModelPriceTier.modelId, modelPks))
    .orderBy(asc(catalogModelPriceTier.skuKey));

  const tiersByModelPk = new Map<
    string,
    { skuKey: string; priceMicroUsd: number; note: string | null }[]
  >();
  for (const row of rows) {
    const tiers = tiersByModelPk.get(row.modelPk) ?? [];
    tiers.push(row);
    tiersByModelPk.set(row.modelPk, tiers);
  }
  return tiersByModelPk;
}

async function mapListingRows(rows: ListingBaseRow[]): Promise<ListingRow[]> {
  const modelPks = [...new Set(rows.map((row) => row.modelPk))];
  const [capabilitiesByModelPk, tiersByModelPk] = await Promise.all([
    getCapabilitiesByModelPk(modelPks),
    getTiersByModelPk(modelPks),
  ]);

  return (
    await Promise.all(
      rows.map(async (row) => {
        const readiness = await assessPublishReadiness(
          row.groupId,
          row.modelId
        );
        let endpointTypes: string[] = [];
        try {
          const parsed = JSON.parse(row.endpointTypesJson ?? '[]');
          if (Array.isArray(parsed)) {
            endpointTypes = parsed.filter(
              (value): value is string => typeof value === 'string'
            );
          }
        } catch {
          // 公开目录对旧数据保守处理：未知端点继续要求 input/output 双价。
        }
        const onlyEmbeddings =
          endpointTypes.length > 0 &&
          endpointTypes.every((value) =>
            value.toLowerCase().includes('embedding')
          );
        const effective = resolveEffectiveCatalogPrice({
          baseInputMicroUsd: row.baseInputMicroUsd,
          baseOutputMicroUsd: row.baseOutputMicroUsd,
          baseImageInputMicroUsd: row.baseImageInputMicroUsd,
          baseImageOutputMicroUsd: row.baseImageOutputMicroUsd,
          discountRateBps: row.discountRateBps ?? 10_000,
          priceDriftStatus: row.priceDriftStatus,
          listInputMicroUsd: row.listInputMicroUsd,
          listOutputMicroUsd: row.listOutputMicroUsd,
          discountNote: row.discountNote,
          requiresOutputPrice: !onlyEmbeddings,
        });
        const discountRateBps = row.discountRateBps ?? 10_000;
        const perCallTiers = (tiersByModelPk.get(row.modelPk) ?? []).flatMap(
          (tier) => {
            const priceMicroUsd = scaleMicroUsdByBps(
              tier.priceMicroUsd,
              discountRateBps
            );
            return priceMicroUsd !== null && priceMicroUsd > 0
              ? [
                  {
                    skuKey: tier.skuKey,
                    priceMicroUsd,
                    ...(tier.note ? { note: tier.note } : {}),
                  },
                ]
              : [];
          }
        );
        const perCallConfirmed =
          row.billingScheme === 'per_call' &&
          ['matched', 'ok', 'cost_alert', 'cost_changed'].includes(
            row.priceDriftStatus || 'unknown'
          ) &&
          perCallTiers.some((tier) => tier.skuKey === 'default');
        const publicConfirmed =
          row.billingScheme === 'per_call'
            ? perCallConfirmed
            : effective.publicConfirmed;
        const pricePresentation =
          row.billingScheme === 'per_call'
            ? {
                showPrice: perCallConfirmed,
                showStrikethrough: false,
                ...(perCallConfirmed && discountRateBps !== 10_000
                  ? { discountBps: discountRateBps }
                  : {}),
                ...(perCallConfirmed && row.discountNote
                  ? { note: row.discountNote }
                  : {}),
              }
            : effective.pricePresentation;

        return {
          modelId: row.modelId,
          displayName: row.displayName,
          vendorName: row.vendorName,
          groupName: row.groupName,
          groupSlug: row.groupSlug,
          category: row.category,
          capabilities: capabilitiesByModelPk.get(row.modelPk) ?? [],
          contextWindow: row.contextWindow,
          billingScheme:
            row.billingScheme === 'per_call'
              ? ('per_call' as const)
              : ('token' as const),
          tiers: perCallConfirmed ? perCallTiers : undefined,
          inputMicroUsd: publicConfirmed
            ? (effective.effectiveInputMicroUsd ?? undefined)
            : undefined,
          outputMicroUsd: publicConfirmed
            ? (effective.effectiveOutputMicroUsd ?? undefined)
            : undefined,
          imageInputMicroUsd: publicConfirmed
            ? (effective.effectiveImageInputMicroUsd ?? undefined)
            : undefined,
          imageOutputMicroUsd: publicConfirmed
            ? (effective.effectiveImageOutputMicroUsd ?? undefined)
            : undefined,
          listInputMicroUsd: publicConfirmed
            ? (effective.listInputMicroUsd ?? undefined)
            : undefined,
          listOutputMicroUsd: publicConfirmed
            ? (effective.listOutputMicroUsd ?? undefined)
            : undefined,
          discountRateBps:
            publicConfirmed && row.discountRateBps !== null
              ? row.discountRateBps
              : undefined,
          discountNote: publicConfirmed
            ? (row.discountNote ?? undefined)
            : undefined,
          description: row.description ?? undefined,
          statusSlug: row.statusSlug,
          statusName: row.statusName,
          isCallable: readiness.ready,
          effectiveInputMicroUsd: publicConfirmed
            ? (effective.effectiveInputMicroUsd ?? undefined)
            : undefined,
          effectiveOutputMicroUsd: publicConfirmed
            ? (effective.effectiveOutputMicroUsd ?? undefined)
            : undefined,
          effectiveImageInputMicroUsd: publicConfirmed
            ? (effective.effectiveImageInputMicroUsd ?? undefined)
            : undefined,
          effectiveImageOutputMicroUsd: publicConfirmed
            ? (effective.effectiveImageOutputMicroUsd ?? undefined)
            : undefined,
          pricePresentation,
        };
      })
    )
  ).filter((listing) => listing.capabilities.length > 0);
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

export async function getCallableModelIdsByGroupUncached(
  groupSlug: string
): Promise<string[]> {
  const listings = await getCallableListingsByGroupUncached(groupSlug);
  return [...new Set(listings.map((listing) => listing.modelId))];
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
  // 后台写入后下一次读取必须立即看到新目录；`max` 会保留旧值并在后台刷新，
  // 导致同一会话通过客户端路由返回模型页时仍显示保存前的价格。
  revalidateTag(CATALOG_CACHE_TAG, { expire: 0 });
}
