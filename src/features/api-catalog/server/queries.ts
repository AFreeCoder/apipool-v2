import 'server-only';

import { revalidateTag, unstable_cache } from 'next/cache';
import { and, asc, eq, inArray } from 'drizzle-orm';

import {
  catalogCapability,
  catalogCategory,
  catalogGroup,
  catalogModel,
  catalogModelCapability,
  catalogModelListing,
  catalogModelPricingProfile,
  catalogModelPricingRate,
  catalogStatus,
  catalogVendor,
} from '@/config/db/schema';
import { db } from '@/core/db';
import { scaleMicroUsdByBps } from '@/features/api-catalog/lib/pricing';
import { assessPublishReadiness } from '@/features/api-catalog/server/publish-readiness';
import type {
  PricingBasis,
  QuantityMeter,
} from '@/features/gateway/lib/pricing-spec';

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
  discountRateBps: number | null;
  discountNote: string | null;
  description: string | null;
  pricingProfileId: string | null;
  pricingBasis: string | null;
  quantityMeter: string | null;
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
      discountRateBps: catalogModelListing.discountRateBps,
      discountNote: catalogModelListing.discountNote,
      description: catalogModelListing.description,
      pricingProfileId: catalogModelListing.pricingProfileId,
      pricingBasis: catalogModelPricingProfile.pricingBasis,
      quantityMeter: catalogModelPricingProfile.quantityMeter,
      statusSlug: catalogStatus.slug,
      statusName: catalogStatus.name,
    })
    .from(catalogModelListing)
    .innerJoin(catalogModel, eq(catalogModelListing.modelId, catalogModel.id))
    .innerJoin(catalogVendor, eq(catalogModel.vendorId, catalogVendor.id))
    .innerJoin(catalogCategory, eq(catalogModel.category, catalogCategory.slug))
    .innerJoin(catalogGroup, eq(catalogModelListing.groupId, catalogGroup.id))
    .leftJoin(
      catalogModelPricingProfile,
      eq(catalogModelListing.pricingProfileId, catalogModelPricingProfile.id)
    )
    .innerJoin(
      catalogStatus,
      eq(catalogModelListing.statusId, catalogStatus.id)
    )
    .where(and(...conditions))
    .orderBy(asc(catalogModelListing.sortOrder));
}

// 路由可用性只取决于模型目录中的分组映射、所选售卖定价档案和售卖状态。
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

type PublicProfileRate = {
  profileId: string;
  meterKey: string;
  skuKey: string;
  unitSize: number;
  priceMicroUsd: number;
  note: string | null;
};

async function getRatesByProfileId(profileIds: string[]) {
  if (profileIds.length === 0) {
    return new Map<string, PublicProfileRate[]>();
  }
  const rows = await db()
    .select({
      profileId: catalogModelPricingRate.profileId,
      meterKey: catalogModelPricingRate.meterKey,
      skuKey: catalogModelPricingRate.skuKey,
      unitSize: catalogModelPricingRate.unitSize,
      priceMicroUsd: catalogModelPricingRate.priceMicroUsd,
      note: catalogModelPricingRate.note,
    })
    .from(catalogModelPricingRate)
    .where(inArray(catalogModelPricingRate.profileId, profileIds))
    .orderBy(
      asc(catalogModelPricingRate.meterKey),
      asc(catalogModelPricingRate.skuKey)
    );

  const ratesByProfileId = new Map<string, PublicProfileRate[]>();
  for (const row of rows) {
    const rates = ratesByProfileId.get(row.profileId) ?? [];
    rates.push(row);
    ratesByProfileId.set(row.profileId, rates);
  }
  return ratesByProfileId;
}

async function mapListingRows(rows: ListingBaseRow[]): Promise<ListingRow[]> {
  const modelPks = [...new Set(rows.map((row) => row.modelPk))];
  const profileIds = [
    ...new Set(
      rows.flatMap((row) =>
        row.pricingProfileId ? [row.pricingProfileId] : []
      )
    ),
  ];
  const [capabilitiesByModelPk, ratesByProfileId] = await Promise.all([
    getCapabilitiesByModelPk(modelPks),
    getRatesByProfileId(profileIds),
  ]);

  return (
    await Promise.all(
      rows.map(async (row) => {
        const readiness = await assessPublishReadiness(
          row.groupId,
          row.modelId
        );
        const pricingBasis = row.pricingBasis as PricingBasis | null;
        const quantityMeter = row.quantityMeter as QuantityMeter | null;
        const discountRateBps = row.discountRateBps ?? 10_000;
        const baseRates = row.pricingProfileId
          ? (ratesByProfileId.get(row.pricingProfileId) ?? [])
          : [];
        const effectiveRates = baseRates.flatMap((rate) => {
          const priceMicroUsd = scaleMicroUsdByBps(
            rate.priceMicroUsd,
            discountRateBps
          );
          return priceMicroUsd !== null && priceMicroUsd > 0
            ? [{ ...rate, priceMicroUsd }]
            : [];
        });
        const findRate = (meterKey: string) =>
          effectiveRates.find(
            (rate) => rate.meterKey === meterKey && rate.skuKey === 'default'
          )?.priceMicroUsd;
        const findBaseRate = (meterKey: string) =>
          baseRates.find(
            (rate) => rate.meterKey === meterKey && rate.skuKey === 'default'
          )?.priceMicroUsd;
        const nonTokenRates =
          pricingBasis && pricingBasis !== 'token'
            ? effectiveRates.map((rate) => {
                const base = baseRates.find(
                  (candidate) =>
                    candidate.meterKey === rate.meterKey &&
                    candidate.skuKey === rate.skuKey
                );
                return {
                  skuKey: rate.skuKey,
                  meterKey: rate.meterKey,
                  unitSize: rate.unitSize,
                  priceMicroUsd: rate.priceMicroUsd,
                  ...(base ? { listPriceMicroUsd: base.priceMicroUsd } : {}),
                  ...(rate.note ? { note: rate.note } : {}),
                };
              })
            : [];
        const publicConfirmed = readiness.ready;
        const billingScheme =
          pricingBasis === 'unit'
            ? ('per_call' as const)
            : pricingBasis === 'duration'
              ? ('duration' as const)
              : ('token' as const);
        const pricePresentation = {
          showPrice: publicConfirmed,
          showStrikethrough: publicConfirmed && discountRateBps !== 10_000,
          ...(publicConfirmed && discountRateBps !== 10_000
            ? { discountBps: discountRateBps }
            : {}),
          ...(publicConfirmed && row.discountNote
            ? { note: row.discountNote }
            : {}),
        };

        return {
          modelId: row.modelId,
          displayName: row.displayName,
          vendorName: row.vendorName,
          groupName: row.groupName,
          groupSlug: row.groupSlug,
          category: row.category,
          capabilities: capabilitiesByModelPk.get(row.modelPk) ?? [],
          contextWindow: row.contextWindow,
          pricingBasis: pricingBasis ?? undefined,
          quantityMeter: quantityMeter ?? undefined,
          billingScheme,
          tiers:
            publicConfirmed && pricingBasis !== 'token'
              ? nonTokenRates
              : undefined,
          inputMicroUsd:
            publicConfirmed && pricingBasis === 'token'
              ? findRate('input')
              : undefined,
          outputMicroUsd:
            publicConfirmed && pricingBasis === 'token'
              ? findRate('output')
              : undefined,
          imageInputMicroUsd:
            publicConfirmed && pricingBasis === 'token'
              ? findRate('image_input')
              : undefined,
          imageOutputMicroUsd:
            publicConfirmed && pricingBasis === 'token'
              ? findRate('image_output')
              : undefined,
          listInputMicroUsd:
            publicConfirmed &&
            pricingBasis === 'token' &&
            discountRateBps !== 10_000
              ? findBaseRate('input')
              : undefined,
          listOutputMicroUsd:
            publicConfirmed &&
            pricingBasis === 'token' &&
            discountRateBps !== 10_000
              ? findBaseRate('output')
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
          effectiveInputMicroUsd:
            publicConfirmed && pricingBasis === 'token'
              ? findRate('input')
              : undefined,
          effectiveOutputMicroUsd:
            publicConfirmed && pricingBasis === 'token'
              ? findRate('output')
              : undefined,
          effectiveImageInputMicroUsd:
            publicConfirmed && pricingBasis === 'token'
              ? findRate('image_input')
              : undefined,
          effectiveImageOutputMicroUsd:
            publicConfirmed && pricingBasis === 'token'
              ? findRate('image_output')
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
        // 门户 Key 只绑定逻辑分组。具体 New API 分组由每个模型的
        // catalog_model_listing 决定，不得在这里要求全局分组映射。
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
  // 后台写入后下一次读取必须立即看到新目录；`max` 会保留旧值并在后台刷新，
  // 导致同一会话通过客户端路由返回模型页时仍显示保存前的价格。
  revalidateTag(CATALOG_CACHE_TAG, { expire: 0 });
}
