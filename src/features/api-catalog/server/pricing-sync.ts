import 'server-only';

import {
  deriveBasePriceFromNewApiPricing,
  normalizeGroupRatio,
} from '@/features/api-catalog/lib/pricing';
import type {
  RemotePricingModel,
  RemotePricingSnapshot,
} from '@/features/newapi-bridge/server/client';
import { asc, desc, eq, inArray } from 'drizzle-orm';

import { db } from '@/core/db';
import {
  catalogGroup,
  catalogModel,
  catalogModelListing,
  catalogModelPrice,
  catalogPriceSyncRun,
  catalogStatus,
} from '@/config/db/schema';
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
  inputMicroUsd: number;
  outputMicroUsd: number;
  pricePolicy: string;
  overrideStatus: string;
  groupNewapiGroup: string;
};

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
      pricePolicy: catalogModelListing.pricePolicy,
      overrideInputMicroUsd: catalogModelListing.overrideInputMicroUsd,
      overrideOutputMicroUsd: catalogModelListing.overrideOutputMicroUsd,
      overrideImageInputMicroUsd:
        catalogModelListing.overrideImageInputMicroUsd,
      overrideImageOutputMicroUsd:
        catalogModelListing.overrideImageOutputMicroUsd,
      overrideReason: catalogModelListing.overrideReason,
      overrideStatus: catalogModelListing.overrideStatus,
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
              pricePolicy: 'legacy_override',
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

function remoteToPriceValues(remote: RemotePricingModel) {
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
    pricingMode:
      derived.source === 'fixed-price' ? 'fixed_price' : 'token_ratio',
    source: 'newapi_pricing',
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
    baseInputMicroUsd: derived.inputMicroUsd,
    baseCachedInputMicroUsd: derived.cachedInputMicroUsd,
    // 现有账本以 5m 桶承载非 Anthropic 的单一 cache write；1h 仅用于
    // Anthropic 明确返回的独立时长价格。
    baseCacheWrite5mMicroUsd: derived.cacheWriteMicroUsd,
    baseCacheWrite1hMicroUsd: derived.cacheWrite1hMicroUsd,
    cachePriceNote:
      derived.source === 'fixed-price'
        ? null
        : encodeJson({
            cacheRatio: remote.cacheRatio ?? 1,
            createCacheRatio: remote.createCacheRatio ?? null,
            singleWriteBucket: derived.cacheWriteMicroUsd !== null,
          }),
    baseOutputMicroUsd: derived.outputMicroUsd,
    baseImageInputMicroUsd: derived.imageInputMicroUsd,
    baseImageOutputMicroUsd: derived.imageOutputMicroUsd,
    fixedPriceMicroUsd: derived.fixedPriceMicroUsd ?? null,
    fixedPriceUnit: derived.source === 'fixed-price' ? 'unknown' : null,
    syncStatus: 'synced',
    driftStatus:
      derived.source === 'fixed-price' ? 'fixed_needs_review' : 'matched',
    sourceSyncedAt: now(),
  };
}

export async function syncCatalogPricingFromSnapshot({
  snapshot,
  operatorUserId,
}: {
  snapshot: RemotePricingSnapshot;
  operatorUserId?: string;
}): Promise<PricingSyncReport> {
  const models = (await db().select().from(catalogModel)) as CatalogModelRow[];
  const modelsByModelId = new Map(
    models.map((model) => [model.modelId, model])
  );
  const remoteByModelId = new Map(
    snapshot.models.map((model) => [model.modelId, model])
  );
  const groups = await db().select().from(catalogGroup);
  const conflicts: Array<Record<string, unknown>> = [];
  let matchedModelCount = 0;
  let fixedPriceCount = 0;
  let missingGroupCount = 0;

  await db().transaction(async (tx: any) => {
    for (const group of groups) {
      const remoteGroup = group.newapiGroup
        ? snapshot.groupRatios[group.newapiGroup]
        : undefined;
      if (!remoteGroup) {
        missingGroupCount += 1;
        await tx
          .update(catalogGroup)
          .set({ pricingSyncStatus: 'missing_remote_group' })
          .where(eq(catalogGroup.id, group.id));
        continue;
      }
      await tx
        .update(catalogGroup)
        .set({
          newapiGroupRatioRaw: encodeJson(remoteGroup.raw),
          newapiGroupRatioDecimal: remoteGroup.decimal,
          newapiGroupRatioBps: remoteGroup.bps,
          pricingSyncStatus: 'synced',
          pricingSyncedAt: now(),
        })
        .where(eq(catalogGroup.id, group.id));
    }

    for (const remote of snapshot.models) {
      const model = modelsByModelId.get(remote.modelId);
      if (!model) continue;
      const values = remoteToPriceValues(remote);
      if (values.pricingMode === 'fixed_price') fixedPriceCount += 1;
      matchedModelCount += 1;
      await tx
        .insert(catalogModelPrice)
        .values({
          id: getUuid(),
          modelId: model.id,
          ...values,
          sourceFingerprint: snapshot.sourceFingerprint,
        })
        .onConflictDoUpdate({
          target: catalogModelPrice.modelId,
          set: {
            ...values,
            sourceFingerprint: snapshot.sourceFingerprint,
            updatedAt: now(),
          },
        });
    }

    const listings = (await tx
      .select({
        id: catalogModelListing.id,
        modelPk: catalogModelListing.modelId,
        groupId: catalogModelListing.groupId,
        inputMicroUsd: catalogModelListing.inputMicroUsd,
        outputMicroUsd: catalogModelListing.outputMicroUsd,
        pricePolicy: catalogModelListing.pricePolicy,
        overrideStatus: catalogModelListing.overrideStatus,
        groupNewapiGroup: catalogGroup.newapiGroup,
      })
      .from(catalogModelListing)
      .innerJoin(
        catalogGroup,
        eq(catalogModelListing.groupId, catalogGroup.id)
      )) as SyncListingRow[];

    for (const listing of listings) {
      const model = models.find((item) => item.id === listing.modelPk);
      const remote = model ? remoteByModelId.get(model.modelId) : undefined;
      const remotePriceValues = remote
        ? remoteToPriceValues(remote)
        : undefined;
      const enabled = Boolean(
        remote &&
          listing.groupNewapiGroup &&
          remote.enabledGroups.includes(listing.groupNewapiGroup)
      );
      const hasCurrentGroupRatio = Boolean(
        listing.groupNewapiGroup &&
          snapshot.groupRatios[listing.groupNewapiGroup]
      );
      const hasTokenBasePrice = Boolean(
        remotePriceValues &&
          remotePriceValues.pricingMode !== 'fixed_price' &&
          remotePriceValues.baseInputMicroUsd !== null &&
          remotePriceValues.baseOutputMicroUsd !== null
      );
      const canConfirmGroupPrice =
        enabled && hasCurrentGroupRatio && hasTokenBasePrice;
      let priceDriftStatus = 'missing_group';
      let reportType: string | null = null;
      let publicMatched = false;

      if (listing.pricePolicy === 'inherit_group') {
        priceDriftStatus = canConfirmGroupPrice
          ? 'matched'
          : remotePriceValues?.pricingMode === 'fixed_price'
            ? 'needs_live_check'
            : 'missing_group';
        publicMatched = canConfirmGroupPrice;
        if (!canConfirmGroupPrice) {
          reportType =
            remotePriceValues?.pricingMode === 'fixed_price'
              ? 'fixed_price_needs_review'
              : enabled
                ? 'missing_group_ratio'
                : 'missing_group';
        }
      } else if (listing.pricePolicy === 'listing_multiplier') {
        priceDriftStatus = 'needs_live_check';
        reportType = 'listing_multiplier_needs_live_check';
      } else if (listing.pricePolicy === 'price_override') {
        priceDriftStatus =
          listing.overrideStatus === 'verified'
            ? 'needs_live_check'
            : 'drifted';
        reportType =
          listing.overrideStatus === 'verified'
            ? 'price_override_needs_live_check'
            : 'price_override_unverified';
      } else if (
        listing.pricePolicy === 'legacy_override' ||
        listing.pricePolicy === 'fixed_price_review'
      ) {
        priceDriftStatus = 'needs_live_check';
        reportType = `${listing.pricePolicy}_needs_live_check`;
      } else {
        priceDriftStatus = 'drifted';
        reportType = 'unknown_price_policy';
      }

      if (reportType) {
        conflicts.push({
          type: reportType,
          modelId: model?.modelId,
          listingId: listing.id,
          newapiGroup: listing.groupNewapiGroup,
          pricePolicy: listing.pricePolicy,
          overrideStatus: listing.overrideStatus,
        });
      }
      await tx
        .update(catalogModelListing)
        .set({
          priceDriftStatus,
          effectivePriceFormula: publicMatched
            ? encodeJson({
                source: 'newapi_group_ratio',
                modelId: model?.modelId,
                newapiGroup: listing.groupNewapiGroup,
              })
            : null,
          effectivePriceSyncedAt: publicMatched ? now() : null,
        })
        .where(eq(catalogModelListing.id, listing.id));
    }
  });

  const status = conflicts.length > 0 ? 'partial' : 'success';
  const run = await insertSyncRun({
    operatorUserId,
    status,
    remoteModelCount: snapshot.models.length,
    matchedModelCount,
    driftCount: conflicts.length,
    fixedPriceCount,
    missingGroupCount,
    sourceFingerprint: snapshot.sourceFingerprint,
    report: { conflicts, groupRatios: snapshot.groupRatios },
  });

  return {
    syncRunId: run.id,
    status,
    remoteModelCount: snapshot.models.length,
    matchedModelCount,
    driftCount: conflicts.length,
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
