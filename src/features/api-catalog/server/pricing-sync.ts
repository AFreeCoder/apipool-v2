import 'server-only';

import { desc, eq, inArray } from 'drizzle-orm';

import {
  catalogModel,
  catalogModelListing,
  catalogModelPrice,
  catalogPriceSyncRun,
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

type CatalogModelRow = typeof catalogModel.$inferSelect;
type CatalogModelPriceRow = typeof catalogModelPrice.$inferSelect;
type CatalogPriceSyncRunRow = typeof catalogPriceSyncRun.$inferSelect;

type SyncListingRow = {
  id: string;
  modelPk: string;
  groupId: string;
  newapiGroup: string;
};

export type CostReference = {
  newapiGroup: string;
  billingScheme: 'token' | 'per_call';
  rates?: Record<string, number>;
  defaultTier?: number;
};

type CostReferenceStatus = 'cost_changed' | 'ok';

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
      billingScheme:
        derived.source === 'fixed-price'
          ? ('per_call' as const)
          : ('token' as const),
      pricingMode:
        derived.source === 'fixed-price' ? 'cost_fixed' : 'cost_token',
      source: 'newapi',
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
      baseInputMicroUsd: derived.inputMicroUsd,
      baseCachedInputMicroUsd: derived.cachedInputMicroUsd,
      baseCacheWriteMicroUsd: derived.cacheWriteMicroUsd,
      baseCacheWrite5mMicroUsd: derived.cacheWriteMicroUsd,
      baseCacheWrite1hMicroUsd: derived.cacheWrite1hMicroUsd,
      baseOutputMicroUsd: derived.outputMicroUsd,
      baseImageInputMicroUsd: derived.imageInputMicroUsd,
      baseImageOutputMicroUsd: derived.imageOutputMicroUsd,
      fixedPriceMicroUsd: derived.fixedPriceMicroUsd,
      fixedPriceUnit: derived.source === 'fixed-price' ? 'per_call' : null,
      syncStatus: 'reference_current',
      sourceSyncedAt: now(),
    },
  };
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

function aggregateCostStatus(
  current: CostReferenceStatus | undefined,
  next: CostReferenceStatus
): CostReferenceStatus {
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
  const priceByModelId = new Map(prices.map((price) => [price.modelId, price]));
  const remoteByModelId = new Map(
    snapshot.models.map((model) => [model.modelId, model])
  );
  const previousReferences = await getLatestCostReferences();
  const conflicts: Array<Record<string, unknown>> = [];
  const costReferences: Record<string, CostReference> = {};
  const modelStatuses = new Map<string, CostReferenceStatus>();
  let matchedModelCount = 0;
  let fixedPriceCount = 0;
  let missingGroupCount = 0;
  let driftCount = 0;

  await db().transaction(async (tx: any) => {
    for (const model of models) {
      const price = priceByModelId.get(model.id);
      const remote = remoteByModelId.get(model.modelId);
      if (!remote) {
        if (price) {
          await tx
            .update(catalogModelPrice)
            .set({
              syncStatus: 'reference_missing',
              driftStatus: 'cost_changed',
              updatedAt: now(),
            })
            .where(eq(catalogModelPrice.id, price.id));
          modelStatuses.set(model.id, 'cost_changed');
        }
        continue;
      }
      const reference = remoteToReference(remote);
      if (reference.derived.source === 'fixed-price') fixedPriceCount += 1;
      matchedModelCount += 1;
      const patch = {
        ...reference.patch,
        sourceFingerprint: snapshot.sourceFingerprint,
        updatedAt: now(),
      };
      if (price) {
        await tx
          .update(catalogModelPrice)
          .set(patch)
          .where(eq(catalogModelPrice.id, price.id));
      } else {
        await tx.insert(catalogModelPrice).values({
          id: getUuid(),
          modelId: model.id,
          ...patch,
        });
      }
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
      let costReferenceStatus: CostReferenceStatus = 'ok';
      let reportType: string | null = null;
      if (!cost) {
        costReferenceStatus = 'cost_changed';
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
        if (changed) {
          costReferenceStatus = 'cost_changed';
          reportType = 'cost_changed';
        }
      }

      if (costReferenceStatus !== 'ok') driftCount += 1;
      modelStatuses.set(
        listing.modelPk,
        aggregateCostStatus(
          modelStatuses.get(listing.modelPk),
          costReferenceStatus
        )
      );
      if (reportType) {
        conflicts.push({
          type: reportType,
          modelId: model?.modelId,
          listingId: listing.id,
          newapiGroup,
        });
      }
    }

    for (const model of models) {
      await tx
        .update(catalogModelPrice)
        .set({
          driftStatus: modelStatuses.get(model.id) ?? 'ok',
          updatedAt: now(),
        })
        .where(eq(catalogModelPrice.modelId, model.id));
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
