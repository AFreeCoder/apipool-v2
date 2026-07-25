import 'server-only';

import { asc, desc, eq, inArray } from 'drizzle-orm';

import {
  catalogGroup,
  catalogModel,
  catalogModelListing,
  catalogModelPrice,
  catalogPriceSyncRun,
  catalogStatus,
  modelPriceVersion,
} from '@/config/db/schema';
import { db } from '@/core/db';
import {
  deriveBasePriceFromNewApiPricing,
  normalizeGroupRatio,
  scaleMicroUsdByBps,
} from '@/features/api-catalog/lib/pricing';
import type {
  RemotePricingModel,
  RemotePricingSnapshot,
} from '@/features/newapi-bridge/server/client';
import { getUuid } from '@/shared/lib/hash';

type BackfillMode = 'report' | 'apply';

type CatalogModelRow = typeof catalogModel.$inferSelect;
type CatalogModelListingRow = typeof catalogModelListing.$inferSelect;
type CatalogModelPriceRow = typeof catalogModelPrice.$inferSelect;
type CatalogPriceSyncRunRow = typeof catalogPriceSyncRun.$inferSelect;

type BackfillListingRow = CatalogModelListingRow & {
  groupSlug: string;
  statusIsCallable: boolean;
  statusIsPublicVisible: boolean;
};

type SyncListingRow = {
  id: string;
  modelPk: string;
  groupId: string;
  newapiGroup: string;
};

type ActiveSaleSnapshot = {
  portalGroupId: string;
  portalModelId: string;
  billingScheme: string;
  ratesJson: string;
  tiersJson: string;
};

export type CostReference = {
  newapiGroup: string;
  billingScheme: 'token' | 'per_call';
  rates?: Record<string, number>;
  defaultTier?: number;
};

type CostGuardStatus = 'cost_alert' | 'cost_changed' | 'ok';

type BackfillConflict = {
  modelId: string;
  listingId: string;
  groupId: string;
  inputMicroUsd: number;
  outputMicroUsd: number;
  reason: string;
};

export type PricingBackfillReport = {
  mode: BackfillMode;
  created: number;
  skipped: number;
  conflicts: BackfillConflict[];
  syncRunId?: string;
};

export type PricingSyncReport = {
  syncRunId: string;
  status: 'success' | 'partial' | 'failed';
  remoteModelCount: number;
  matchedModelCount: number;
  driftCount: number;
  fixedPriceCount: number;
  missingGroupCount: number;
  conflicts: Array<Record<string, unknown>>;
};

function now() {
  return new Date();
}

function encodeJson(value: unknown) {
  return JSON.stringify(value);
}

function sanitizeSyncErrorMessage(message: string) {
  return message
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/https?:\/\/\S+/gi, '[redacted-url]')
    .slice(0, 500);
}

async function insertSyncRun(input: {
  operatorUserId?: string;
  status: 'success' | 'partial' | 'failed';
  remoteModelCount?: number;
  matchedModelCount?: number;
  driftCount?: number;
  fixedPriceCount?: number;
  missingGroupCount?: number;
  sourceFingerprint?: string;
  errorMessage?: string;
  report: unknown;
}) {
  const [run] = (await db()
    .insert(catalogPriceSyncRun)
    .values({
      id: getUuid(),
      operatorUserId: input.operatorUserId,
      status: input.status,
      startedAt: now(),
      finishedAt: now(),
      remoteModelCount: input.remoteModelCount ?? 0,
      matchedModelCount: input.matchedModelCount ?? 0,
      driftCount: input.driftCount ?? 0,
      fixedPriceCount: input.fixedPriceCount ?? 0,
      missingGroupCount: input.missingGroupCount ?? 0,
      sourceFingerprint: input.sourceFingerprint,
      errorMessage: input.errorMessage,
      reportJson: encodeJson(input.report),
    })
    .returning()) as CatalogPriceSyncRunRow[];
  return run;
}

export async function recordCatalogPriceSyncFailure({
  operatorUserId,
  error,
}: {
  operatorUserId?: string;
  error: unknown;
}) {
  const rawMessage =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : 'Model pricing sync is unavailable';
  const message = sanitizeSyncErrorMessage(rawMessage);
  return await insertSyncRun({
    operatorUserId,
    status: 'failed',
    errorMessage: message,
    report: { error: message },
  });
}

async function getListingsForModels(modelIds: string[]) {
  if (modelIds.length === 0) return [];
  return (await db()
    .select({
      id: catalogModelListing.id,
      modelId: catalogModelListing.modelId,
      groupId: catalogModelListing.groupId,
      statusId: catalogModelListing.statusId,
      inputMicroUsd: catalogModelListing.inputMicroUsd,
      outputMicroUsd: catalogModelListing.outputMicroUsd,
      imageInputMicroUsd: catalogModelListing.imageInputMicroUsd,
      imageOutputMicroUsd: catalogModelListing.imageOutputMicroUsd,
      listInputMicroUsd: catalogModelListing.listInputMicroUsd,
      listOutputMicroUsd: catalogModelListing.listOutputMicroUsd,
      discountRateBps: catalogModelListing.discountRateBps,
      discountNote: catalogModelListing.discountNote,
      effectivePriceSyncedAt: catalogModelListing.effectivePriceSyncedAt,
      effectivePriceFormula: catalogModelListing.effectivePriceFormula,
      priceDriftStatus: catalogModelListing.priceDriftStatus,
      description: catalogModelListing.description,
      featured: catalogModelListing.featured,
      sortOrder: catalogModelListing.sortOrder,
      createdAt: catalogModelListing.createdAt,
      updatedAt: catalogModelListing.updatedAt,
      groupSlug: catalogGroup.slug,
      statusIsCallable: catalogStatus.isCallable,
      statusIsPublicVisible: catalogStatus.isPublicVisible,
    })
    .from(catalogModelListing)
    .innerJoin(catalogGroup, eq(catalogModelListing.groupId, catalogGroup.id))
    .innerJoin(
      catalogStatus,
      eq(catalogModelListing.statusId, catalogStatus.id)
    )
    .where(inArray(catalogModelListing.modelId, modelIds))
    .orderBy(asc(catalogModelListing.sortOrder))) as BackfillListingRow[];
}

function listingPriceKey(listing: BackfillListingRow) {
  return [
    listing.inputMicroUsd,
    listing.outputMicroUsd,
    listing.imageInputMicroUsd ?? '',
    listing.imageOutputMicroUsd ?? '',
  ].join(':');
}

function backfillBaseFromListing(
  listing: BackfillListingRow,
  source: 'list' | 'effective' = 'effective'
) {
  const useList =
    source === 'list' &&
    listing.listInputMicroUsd !== null &&
    listing.listOutputMicroUsd !== null;

  return {
    listing,
    baseInputMicroUsd: useList
      ? listing.listInputMicroUsd
      : listing.inputMicroUsd,
    baseOutputMicroUsd: useList
      ? listing.listOutputMicroUsd
      : listing.outputMicroUsd,
    baseImageInputMicroUsd:
      listing.imageInputMicroUsd === null
        ? undefined
        : listing.imageInputMicroUsd,
    baseImageOutputMicroUsd:
      listing.imageOutputMicroUsd === null
        ? undefined
        : listing.imageOutputMicroUsd,
  };
}

function chooseBackfillBase(listings: BackfillListingRow[]) {
  const sorted = [...listings].sort((a, b) => {
    if (a.groupSlug === 'official' && b.groupSlug !== 'official') return -1;
    if (a.groupSlug !== 'official' && b.groupSlug === 'official') return 1;
    if (a.statusIsCallable !== b.statusIsCallable) {
      return a.statusIsCallable ? -1 : 1;
    }
    return a.sortOrder - b.sortOrder;
  });
  const officialListings = sorted.filter(
    (listing) => listing.groupSlug === 'official'
  );
  const officialListPrice = officialListings.find(
    (listing) =>
      listing.listInputMicroUsd !== null && listing.listOutputMicroUsd !== null
  );
  if (officialListPrice)
    return backfillBaseFromListing(officialListPrice, 'list');

  const officialEffective = officialListings[0];
  if (officialEffective) return backfillBaseFromListing(officialEffective);

  const comparableListings = sorted.filter(
    (listing) =>
      listing.inputMicroUsd !== null && listing.outputMicroUsd !== null
  );
  if (comparableListings.length > 0) {
    const keys = new Set(comparableListings.map(listingPriceKey));
    if (keys.size === 1) return backfillBaseFromListing(comparableListings[0]);
  }

  const callable = sorted.find((listing) => listing.statusIsCallable);
  if (callable) return backfillBaseFromListing(callable);

  const fallback = sorted[0];
  return fallback ? backfillBaseFromListing(fallback) : undefined;
}

export async function backfillCatalogModelPrices({
  mode,
  operatorUserId,
}: {
  mode: BackfillMode;
  operatorUserId?: string;
}): Promise<PricingBackfillReport> {
  const models = (await db().select().from(catalogModel)) as CatalogModelRow[];
  const existingPrices = (await db()
    .select()
    .from(catalogModelPrice)) as CatalogModelPriceRow[];
  const existingModelIds = new Set(
    existingPrices.map((price) => price.modelId)
  );
  const listings = await getListingsForModels(models.map((model) => model.id));
  const listingsByModel = new Map<string, BackfillListingRow[]>();
  for (const listing of listings) {
    const value = listingsByModel.get(listing.modelId) ?? [];
    value.push(listing);
    listingsByModel.set(listing.modelId, value);
  }

  const report: PricingBackfillReport = {
    mode,
    created: 0,
    skipped: 0,
    conflicts: [],
  };

  await db().transaction(async (tx: any) => {
    for (const model of models) {
      if (existingModelIds.has(model.id)) {
        report.skipped += 1;
        continue;
      }

      const modelListings = listingsByModel.get(model.id) ?? [];
      const base = chooseBackfillBase(modelListings);
      if (!base) {
        report.skipped += 1;
        continue;
      }

      const conflicts = modelListings.filter(
        (listing) =>
          listing.inputMicroUsd !== base.baseInputMicroUsd ||
          listing.outputMicroUsd !== base.baseOutputMicroUsd ||
          (listing.imageInputMicroUsd ?? undefined) !==
            base.baseImageInputMicroUsd ||
          (listing.imageOutputMicroUsd ?? undefined) !==
            base.baseImageOutputMicroUsd
      );
      for (const conflict of conflicts) {
        report.conflicts.push({
          modelId: model.modelId,
          listingId: conflict.id,
          groupId: conflict.groupId,
          inputMicroUsd: conflict.inputMicroUsd,
          outputMicroUsd: conflict.outputMicroUsd,
          reason: 'listing price differs from selected backfill base',
        });
      }

      if (mode === 'apply') {
        await tx.insert(catalogModelPrice).values({
          id: getUuid(),
          modelId: model.id,
          pricingMode: 'manual_token',
          source: 'migration',
          sourceModelId: model.modelId,
          baseInputMicroUsd: base.baseInputMicroUsd,
          baseOutputMicroUsd: base.baseOutputMicroUsd,
          baseImageInputMicroUsd: base.baseImageInputMicroUsd,
          baseImageOutputMicroUsd: base.baseImageOutputMicroUsd,
          syncStatus: 'manual',
          driftStatus: conflicts.length > 0 ? 'drifted' : 'unknown',
          reviewNote: 'Backfilled from existing catalog_model_listing prices.',
        });

        if (conflicts.length > 0) {
          await tx
            .update(catalogModelListing)
            .set({
              priceDriftStatus: 'needs_live_check',
            })
            .where(
              inArray(
                catalogModelListing.id,
                conflicts.map((listing) => listing.id)
              )
            );
        }
      }
      report.created += 1;
    }

    if (mode === 'apply') {
      const run = (await tx
        .insert(catalogPriceSyncRun)
        .values({
          id: getUuid(),
          operatorUserId,
          status: report.conflicts.length > 0 ? 'partial' : 'success',
          startedAt: now(),
          finishedAt: now(),
          matchedModelCount: report.created,
          driftCount: report.conflicts.length,
          reportJson: encodeJson(report),
        })
        .returning()) as CatalogPriceSyncRunRow[];
      report.syncRunId = run[0]?.id;
    }
  });

  return report;
}

function remoteToReference(remote: RemotePricingModel) {
  const derived = deriveBasePriceFromNewApiPricing({
    model_name: remote.modelId,
    quota_type: remote.quotaType,
    model_ratio: remote.modelRatio,
    model_price: remote.modelPrice,
    completion_ratio: remote.completionRatio,
    cache_ratio: remote.cacheRatio,
    create_cache_ratio: remote.createCacheRatio,
    image_ratio: remote.imageRatio,
    supported_endpoint_types: remote.supportedEndpointTypes,
  });
  return {
    derived,
    patch: {
      sourceModelId: remote.modelId,
      sourceVendorId: remote.vendorId,
      sourceQuotaType: remote.quotaType,
      sourceModelRatio: String(remote.modelRatio),
      sourceCompletionRatio: String(remote.completionRatio),
      sourceImageRatio:
        remote.imageRatio === null || remote.imageRatio === undefined
          ? null
          : String(remote.imageRatio),
      sourceSupportedEndpointTypes: encodeJson(remote.supportedEndpointTypes),
      // 历史表没有独立的 cache/model_price 参照列；该 note 只保存 New API
      // 参照参数，绝不进入门户卖价或发布快照。
      cachePriceNote: encodeJson({
        cacheRatio: remote.cacheRatio ?? 1,
        createCacheRatio: remote.createCacheRatio ?? null,
        modelPriceMicroUsd: derived.fixedPriceMicroUsd ?? null,
      }),
      syncStatus: 'reference_current',
      sourceSyncedAt: now(),
    },
  };
}

function parsePriceMap(raw: string): Record<string, number> | null {
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return null;
    }
    const result: Record<string, number> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (!Number.isSafeInteger(value) || Number(value) < 0) return null;
      result[key] = Number(value);
    }
    return result;
  } catch {
    return null;
  }
}

function buildCostReference(
  remote: RemotePricingModel,
  newapiGroup: string,
  groupRatioBps: number
): CostReference | null {
  const { derived } = remoteToReference(remote);
  if (derived.source === 'fixed-price') {
    if (
      derived.fixedPriceMicroUsd === null ||
      derived.fixedPriceMicroUsd === undefined
    ) {
      return null;
    }
    return {
      newapiGroup,
      billingScheme: 'per_call',
      defaultTier: scaleMicroUsdByBps(
        derived.fixedPriceMicroUsd,
        groupRatioBps
      )!,
    };
  }

  const candidates: Array<[string, number | null]> = [
    ['input', derived.inputMicroUsd],
    ['cached_input', derived.cachedInputMicroUsd],
    ['cache_write_5m', derived.cacheWriteMicroUsd],
    ['cache_write_1h', derived.cacheWrite1hMicroUsd],
    ['output', derived.outputMicroUsd],
    ['image_input', derived.imageInputMicroUsd],
    ['image_output', derived.imageOutputMicroUsd],
  ];
  const rates: Record<string, number> = {};
  for (const [key, value] of candidates) {
    if (value !== null) {
      rates[key] = scaleMicroUsdByBps(value, groupRatioBps)!;
    }
  }
  return Object.keys(rates).length > 0
    ? { newapiGroup, billingScheme: 'token', rates }
    : null;
}

function sameCostReference(
  previous: CostReference | undefined,
  current: CostReference
) {
  return previous !== undefined && encodeJson(previous) === encodeJson(current);
}

function compareSaleToCost(
  sale: ActiveSaleSnapshot | undefined,
  cost: CostReference
) {
  if (!sale) return { comparable: false, alerts: [] as string[] };
  if (sale.billingScheme !== cost.billingScheme) {
    return { comparable: false, alerts: [] as string[] };
  }
  if (cost.billingScheme === 'per_call') {
    const tiers = parsePriceMap(sale.tiersJson);
    const saleDefault = tiers?.default;
    return {
      comparable: saleDefault !== undefined,
      alerts:
        saleDefault !== undefined &&
        cost.defaultTier !== undefined &&
        saleDefault < cost.defaultTier
          ? ['default']
          : [],
    };
  }

  const saleRates = parsePriceMap(sale.ratesJson);
  if (!saleRates) return { comparable: false, alerts: [] as string[] };
  const comparable = Object.entries(cost.rates ?? {}).filter(
    ([key]) => saleRates[key] !== undefined
  );
  return {
    comparable: comparable.length > 0,
    alerts: comparable
      .filter(([key, costRate]) => saleRates[key] < costRate)
      .map(([key]) => key),
  };
}

function aggregateCostStatus(
  current: CostGuardStatus | undefined,
  next: CostGuardStatus
): CostGuardStatus {
  if (current === 'cost_alert' || next === 'cost_alert') return 'cost_alert';
  if (current === 'cost_changed' || next === 'cost_changed') {
    return 'cost_changed';
  }
  return 'ok';
}

export async function getLatestCostReferences() {
  const runs = await db()
    .select({ reportJson: catalogPriceSyncRun.reportJson })
    .from(catalogPriceSyncRun)
    .where(inArray(catalogPriceSyncRun.status, ['success', 'partial']))
    .orderBy(desc(catalogPriceSyncRun.startedAt))
    .limit(20);
  for (const run of runs) {
    if (!run.reportJson?.trim()) continue;
    try {
      const parsed = JSON.parse(run.reportJson);
      if (
        parsed?.costReferences &&
        typeof parsed.costReferences === 'object' &&
        !Array.isArray(parsed.costReferences)
      ) {
        return parsed.costReferences as Record<string, CostReference>;
      }
    } catch {
      // 跳过旧格式或损坏的只读报告，继续找上一份有效成本基线。
    }
  }
  return {};
}

export async function syncCatalogPricingFromSnapshot({
  snapshot,
  operatorUserId,
}: {
  snapshot: RemotePricingSnapshot;
  operatorUserId?: string;
}): Promise<PricingSyncReport> {
  const models = (await db().select().from(catalogModel)) as CatalogModelRow[];
  const prices = (await db()
    .select()
    .from(catalogModelPrice)) as CatalogModelPriceRow[];
  const remoteByModelId = new Map(
    snapshot.models.map((model) => [model.modelId, model])
  );
  const activeSales = (await db()
    .select({
      portalGroupId: modelPriceVersion.portalGroupId,
      portalModelId: modelPriceVersion.portalModelId,
      billingScheme: modelPriceVersion.billingScheme,
      ratesJson: modelPriceVersion.ratesJson,
      tiersJson: modelPriceVersion.tiersJson,
    })
    .from(modelPriceVersion)
    .where(eq(modelPriceVersion.status, 'active'))) as ActiveSaleSnapshot[];
  const saleByRoute = new Map(
    activeSales.map((sale) => [
      `${sale.portalGroupId}\u0000${sale.portalModelId}`,
      sale,
    ])
  );
  const previousReferences = await getLatestCostReferences();
  const conflicts: Array<Record<string, unknown>> = [];
  const costReferences: Record<string, CostReference> = {};
  const modelStatuses = new Map<string, CostGuardStatus>();
  let matchedModelCount = 0;
  let fixedPriceCount = 0;
  let missingGroupCount = 0;
  let driftCount = 0;

  await db().transaction(async (tx: any) => {
    for (const price of prices) {
      const model = models.find((item) => item.id === price.modelId);
      const remote = model ? remoteByModelId.get(model.modelId) : undefined;
      if (!remote) {
        await tx
          .update(catalogModelPrice)
          .set({
            syncStatus: 'reference_missing',
            driftStatus: 'cost_changed',
            updatedAt: now(),
          })
          .where(eq(catalogModelPrice.id, price.id));
        modelStatuses.set(price.modelId, 'cost_changed');
        continue;
      }
      const reference = remoteToReference(remote);
      if (reference.derived.source === 'fixed-price') fixedPriceCount += 1;
      matchedModelCount += 1;
      await tx
        .update(catalogModelPrice)
        .set({
          ...reference.patch,
          sourceFingerprint: snapshot.sourceFingerprint,
          updatedAt: now(),
        })
        .where(eq(catalogModelPrice.id, price.id));
    }

    const listings = (await tx
      .select({
        id: catalogModelListing.id,
        modelPk: catalogModelListing.modelId,
        groupId: catalogModelListing.groupId,
        newapiGroup: catalogModelListing.newapiGroup,
      })
      .from(catalogModelListing)) as SyncListingRow[];

    for (const listing of listings) {
      const model = models.find((item) => item.id === listing.modelPk);
      const remote = model ? remoteByModelId.get(model.modelId) : undefined;
      const newapiGroup = listing.newapiGroup.trim();
      const enabled = Boolean(
        remote && newapiGroup && remote.enabledGroups.includes(newapiGroup)
      );
      const groupRatio = newapiGroup
        ? snapshot.groupRatios[newapiGroup]
        : undefined;
      if (!newapiGroup || (remote && (!enabled || !groupRatio))) {
        missingGroupCount += 1;
      }
      const cost =
        remote && enabled && groupRatio
          ? buildCostReference(remote, newapiGroup, groupRatio.bps)
          : null;
      let priceDriftStatus: CostGuardStatus = 'ok';
      let reportType: string | null = null;
      let alerts: string[] = [];
      if (!cost) {
        priceDriftStatus = 'cost_changed';
        reportType = !newapiGroup
          ? 'cost_reference_mapping_missing'
          : remote
            ? enabled
              ? 'cost_reference_missing_group_ratio'
              : 'cost_reference_group_unavailable'
            : 'cost_reference_model_missing';
      } else {
        costReferences[listing.id] = cost;
        const changed =
          previousReferences[listing.id] !== undefined &&
          !sameCostReference(previousReferences[listing.id], cost);
        const sale = saleByRoute.get(
          `${listing.groupId}\u0000${model?.modelId ?? ''}`
        );
        const comparison = compareSaleToCost(sale, cost);
        alerts = comparison.alerts;
        if (alerts.length > 0) {
          priceDriftStatus = 'cost_alert';
          reportType = 'cost_alert';
        } else if (changed) {
          priceDriftStatus = 'cost_changed';
          reportType = 'cost_changed';
        } else if (!comparison.comparable) {
          reportType = sale
            ? 'cost_reference_not_comparable'
            : 'sale_snapshot_missing';
        }
      }

      if (priceDriftStatus !== 'ok') driftCount += 1;
      modelStatuses.set(
        listing.modelPk,
        aggregateCostStatus(
          modelStatuses.get(listing.modelPk),
          priceDriftStatus
        )
      );
      if (reportType) {
        conflicts.push({
          type: reportType,
          modelId: model?.modelId,
          listingId: listing.id,
          newapiGroup,
          meters: alerts,
        });
      }
      await tx
        .update(catalogModelListing)
        .set({
          priceDriftStatus,
          effectivePriceFormula: encodeJson({
            source: 'catalog_base_price_x_listing_discount',
          }),
          effectivePriceSyncedAt: now(),
        })
        .where(eq(catalogModelListing.id, listing.id));
    }

    for (const price of prices) {
      await tx
        .update(catalogModelPrice)
        .set({
          driftStatus: modelStatuses.get(price.modelId) ?? 'ok',
          updatedAt: now(),
        })
        .where(eq(catalogModelPrice.id, price.id));
    }
  });

  const status =
    driftCount > 0 || missingGroupCount > 0 ? 'partial' : 'success';
  const run = await insertSyncRun({
    operatorUserId,
    status,
    remoteModelCount: snapshot.models.length,
    matchedModelCount,
    driftCount,
    fixedPriceCount,
    missingGroupCount,
    sourceFingerprint: snapshot.sourceFingerprint,
    report: {
      conflicts,
      costReferences,
      groupRatios: snapshot.groupRatios,
    },
  });

  return {
    syncRunId: run.id,
    status,
    remoteModelCount: snapshot.models.length,
    matchedModelCount,
    driftCount,
    fixedPriceCount,
    missingGroupCount,
    conflicts,
  };
}

export async function getLatestCatalogPriceSyncRun() {
  const [run] = await db()
    .select()
    .from(catalogPriceSyncRun)
    .orderBy(desc(catalogPriceSyncRun.startedAt))
    .limit(1);
  return run;
}

export async function buildCatalogPriceDriftReport() {
  const latest = await getLatestCatalogPriceSyncRun();
  return {
    latestRun: latest,
    report:
      latest?.reportJson && latest.reportJson.trim()
        ? JSON.parse(latest.reportJson)
        : null,
  };
}

export async function resolveAndCacheEffectivePrices() {
  // Effective cache updates are intentionally conservative in this phase.
  // Existing listing cache remains the rollback-compatible public price until
  // a listing is explicitly matched and verified.
  return { updated: 0 };
}

export function normalizeRemoteGroupRatioForSync(value: number | string) {
  return normalizeGroupRatio(value);
}
