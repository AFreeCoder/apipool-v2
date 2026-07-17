import 'server-only';

import { revalidateCatalog } from '@/features/api-catalog/server/queries';
import { ceilDiv, type PriceVector } from '@/features/gateway/lib/billing';
import {
  createNewApiClient,
  type RemotePricingSnapshot,
} from '@/features/newapi-bridge/server/client';
import { and, desc, eq } from 'drizzle-orm';

import { db } from '@/core/db';
import {
  catalogGroup,
  catalogModel,
  catalogModelListing,
  catalogModelPrice,
  modelPriceVersion,
  modelRoute,
} from '@/config/db/schema';
import { getUuid } from '@/shared/lib/hash';
import { recordPortalAdminAudit } from '@/shared/models/portal-admin-audit';

export interface PublishRouteInput {
  portalGroupId: string;
  portalModelId: string;
  newapiGroup: string;
  newapiModelId?: string;
  operatorUserId: string;
  remapPrice?: PriceVector & { sourceNote?: string };
}

export interface PublishPriceInput {
  portalGroupId: string;
  portalModelId: string;
  price: PriceVector;
  sourceNote?: string;
  operatorUserId: string;
}

export type PublishFailure = { check: string; message: string };
export type PublishResult =
  | { ok: true; version: number }
  | { ok: false; failures: PublishFailure[] };

type RouteServiceDeps = {
  getPricingSnapshot?: () => Promise<RemotePricingSnapshot>;
  getUsableGroups?: () => Promise<string[]>;
  revalidate?: () => void;
  newId?: () => string;
};

type CatalogContext = {
  group: typeof catalogGroup.$inferSelect | undefined;
  model: typeof catalogModel.$inferSelect | undefined;
  basePrice: typeof catalogModelPrice.$inferSelect | undefined;
  activeRoute: typeof modelRoute.$inferSelect | undefined;
  activePrice: typeof modelPriceVersion.$inferSelect | undefined;
};

type PriceReferences = {
  input: number;
  cachedInput: number;
  cacheWrite5m: number | null;
  cacheWrite1h: number | null;
  output: number;
};

const CALLABLE_ENDPOINT_TYPES = new Set([
  'chat',
  'openai',
  'responses',
  'openai-response',
  'messages',
  'anthropic',
  'embedding',
  'embeddings',
]);

export class ConcurrentPublishError extends Error {
  constructor() {
    super('配置已变更，请刷新重试');
    this.name = 'ConcurrentPublishError';
  }
}

function success(version: number): PublishResult {
  return { ok: true, version };
}

function failure(check: string, message: string): PublishFailure {
  return { check, message };
}

function affectedRows(result: any): number {
  if (typeof result?.rowsAffected === 'number') return result.rowsAffected;
  if (typeof result?.affectedRows === 'number') return result.affectedRows;
  if (Array.isArray(result)) {
    const nested = result[0];
    if (typeof nested?.rowsAffected === 'number') return nested.rowsAffected;
    if (typeof nested?.affectedRows === 'number') return nested.affectedRows;
  }
  return 0;
}

function isConcurrentDatabaseError(error: unknown) {
  const message = String(error instanceof Error ? error.message : error);
  return /unique|duplicate|constraint|busy|locked/i.test(message);
}

async function translateConcurrent<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof ConcurrentPublishError) throw error;
    if (isConcurrentDatabaseError(error)) throw new ConcurrentPublishError();
    throw error;
  }
}

async function loadContext(
  portalGroupId: string,
  portalModelId: string
): Promise<CatalogContext> {
  const database = db();
  const [[group], [model], [activeRoute], [activePrice]] = await Promise.all([
    database
      .select()
      .from(catalogGroup)
      .where(eq(catalogGroup.id, portalGroupId))
      .limit(1),
    database
      .select()
      .from(catalogModel)
      .where(eq(catalogModel.modelId, portalModelId))
      .limit(1),
    database
      .select()
      .from(modelRoute)
      .where(
        and(
          eq(modelRoute.portalGroupId, portalGroupId),
          eq(modelRoute.portalModelId, portalModelId),
          eq(modelRoute.status, 'active')
        )
      )
      .limit(1),
    database
      .select()
      .from(modelPriceVersion)
      .where(
        and(
          eq(modelPriceVersion.portalGroupId, portalGroupId),
          eq(modelPriceVersion.portalModelId, portalModelId),
          eq(modelPriceVersion.status, 'active')
        )
      )
      .limit(1),
  ]);
  const [basePrice] = model
    ? await database
        .select()
        .from(catalogModelPrice)
        .where(eq(catalogModelPrice.modelId, model.id))
        .limit(1)
    : [];
  return { group, model, basePrice, activeRoute, activePrice };
}

function validateCatalogContext(context: CatalogContext): PublishFailure[] {
  const failures: PublishFailure[] = [];
  if (!context.group) {
    failures.push(failure('group_missing', '门户分组不存在'));
  } else if (context.group.pricingSyncStatus !== 'synced') {
    failures.push(failure('group_sync', '分组价格倍率尚未同步'));
  }
  if (!context.model) {
    failures.push(failure('model_missing', '门户模型不存在'));
  }
  if (!context.basePrice) {
    failures.push(failure('price_sync', '模型基准价格不存在'));
  } else if (
    context.basePrice.syncStatus !== 'synced' &&
    !(context.basePrice.syncStatus === 'manual' && context.basePrice.reviewedAt)
  ) {
    failures.push(
      failure('price_sync', '模型基准价格未同步或人工价格尚未复核')
    );
  }
  return failures;
}

function getRatioBps(
  snapshot: RemotePricingSnapshot,
  targetGroup: string
): number | null {
  const bps = snapshot.groupRatios[targetGroup]?.bps;
  return Number.isSafeInteger(bps) && bps > 0 ? bps : null;
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function referencePrice(base: number, ratioBps: number): number {
  return Number(ceilDiv(BigInt(base) * BigInt(ratioBps), BigInt(10_000)));
}

function validatePrice(
  price: PriceVector,
  basePrice: typeof catalogModelPrice.$inferSelect,
  ratioBps: number
): { failures: PublishFailure[]; references?: PriceReferences } {
  const failures: PublishFailure[] = [];
  const portalDimensions: Array<[keyof PriceVector, string]> = [
    ['inputMicroUsdPerM', 'input'],
    ['cachedInputMicroUsdPerM', 'cached_input'],
    ['outputMicroUsdPerM', 'output'],
  ];
  for (const [key, label] of portalDimensions) {
    if (!positiveInteger(price[key])) {
      failures.push(failure(`price:${label}`, `${label} 单价必须为正整数`));
    }
  }

  if (!positiveInteger(basePrice.baseCachedInputMicroUsd)) {
    failures.push(
      failure('cache_reference', 'cached input 基准价必须完整并经管理员复核')
    );
  }
  if (
    !positiveInteger(basePrice.baseInputMicroUsd) ||
    !positiveInteger(basePrice.baseOutputMicroUsd)
  ) {
    failures.push(failure('base_reference', 'input/output 基准价必须为正整数'));
  }
  const writeDimensions: Array<{
    key: keyof PriceVector;
    label: string;
    base: number | null;
  }> = [
    {
      key: 'cacheWrite5mMicroUsdPerM',
      label: 'cache_write_5m',
      base: basePrice.baseCacheWrite5mMicroUsd,
    },
    {
      key: 'cacheWrite1hMicroUsdPerM',
      label: 'cache_write_1h',
      base: basePrice.baseCacheWrite1hMicroUsd,
    },
  ];
  const endpointTypes = parseEndpointTypes(
    basePrice.sourceSupportedEndpointTypes
  );
  const requiresSplitCacheWrite = endpointTypes.some(
    (endpoint) => endpoint === 'messages' || endpoint === 'anthropic'
  );
  for (const dimension of writeDimensions) {
    if (dimension.base === null) {
      if (requiresSplitCacheWrite) {
        failures.push(
          failure(
            'cache_reference',
            `${dimension.label} 基准价必须完整并经管理员复核`
          )
        );
        continue;
      }
      if (price[dimension.key] !== 0) {
        failures.push(
          failure(
            `price:${dimension.label}`,
            `${dimension.label} 不适用于当前模型，单价必须为 0`
          )
        );
      }
      continue;
    }
    if (!positiveInteger(dimension.base)) {
      failures.push(
        failure('cache_reference', `${dimension.label} 基准价必须为正整数`)
      );
    }
    if (!positiveInteger(price[dimension.key])) {
      failures.push(
        failure(
          `price:${dimension.label}`,
          `${dimension.label} 单价必须为正整数`
        )
      );
    }
  }
  if (
    failures.some(
      (item) =>
        item.check.startsWith('price:') ||
        item.check === 'cache_reference' ||
        item.check === 'base_reference'
    )
  ) {
    return { failures };
  }

  const references: PriceReferences = {
    input: referencePrice(basePrice.baseInputMicroUsd!, ratioBps),
    cachedInput: referencePrice(basePrice.baseCachedInputMicroUsd!, ratioBps),
    cacheWrite5m:
      basePrice.baseCacheWrite5mMicroUsd === null
        ? null
        : referencePrice(basePrice.baseCacheWrite5mMicroUsd, ratioBps),
    cacheWrite1h:
      basePrice.baseCacheWrite1hMicroUsd === null
        ? null
        : referencePrice(basePrice.baseCacheWrite1hMicroUsd, ratioBps),
    output: referencePrice(basePrice.baseOutputMicroUsd!, ratioBps),
  };
  const directions: Array<[number, number | null, string]> = [
    [price.inputMicroUsdPerM, references.input, 'input'],
    [price.cachedInputMicroUsdPerM, references.cachedInput, 'cached_input'],
    [price.cacheWrite5mMicroUsdPerM, references.cacheWrite5m, 'cache_write_5m'],
    [price.cacheWrite1hMicroUsdPerM, references.cacheWrite1h, 'cache_write_1h'],
    [price.outputMicroUsdPerM, references.output, 'output'],
  ];
  for (const [portal, reference, label] of directions) {
    if (reference === null) continue;
    if (portal < reference) {
      failures.push(
        failure(
          `direction:${label}`,
          `${label} 门户价格 ${portal} 低于 New API 成本参照 ${reference}`
        )
      );
    }
  }
  return { failures, references };
}

function parseEndpointTypes(value: string | null): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : [];
  } catch {
    return [];
  }
}

async function assertCapturedActive(
  tx: any,
  table: typeof modelRoute | typeof modelPriceVersion,
  captured: { id: string } | undefined,
  portalGroupId: string,
  portalModelId: string,
  retiredAt: Date
) {
  if (captured) {
    const result = await tx
      .update(table)
      .set({ status: 'retired', retiredAt })
      .where(and(eq(table.id, captured.id), eq(table.status, 'active')));
    if (affectedRows(result) !== 1) throw new ConcurrentPublishError();
    return;
  }
  const [active] = await tx
    .select({ id: table.id })
    .from(table)
    .where(
      and(
        eq(table.portalGroupId, portalGroupId),
        eq(table.portalModelId, portalModelId),
        eq(table.status, 'active')
      )
    )
    .limit(1);
  if (active) throw new ConcurrentPublishError();
}

async function nextVersion(
  tx: any,
  table: typeof modelRoute | typeof modelPriceVersion,
  portalGroupId: string,
  portalModelId: string
) {
  const [latest] = await tx
    .select({ version: table.version })
    .from(table)
    .where(
      and(
        eq(table.portalGroupId, portalGroupId),
        eq(table.portalModelId, portalModelId)
      )
    )
    .orderBy(desc(table.version))
    .limit(1);
  return (latest?.version ?? 0) + 1;
}

function priceAuditShape(
  version: number,
  price: PriceVector,
  references: PriceReferences,
  refNewapiGroup: string
) {
  return { version, ...price, references, refNewapiGroup };
}

async function insertPriceVersionInTx(input: {
  tx: any;
  capturedActive: typeof modelPriceVersion.$inferSelect | undefined;
  portalGroupId: string;
  portalModelId: string;
  modelPk: string;
  price: PriceVector;
  references: PriceReferences;
  refNewapiGroup: string;
  sourceNote?: string;
  operatorUserId: string;
  newId: () => string;
  now: Date;
}) {
  await assertCapturedActive(
    input.tx,
    modelPriceVersion,
    input.capturedActive,
    input.portalGroupId,
    input.portalModelId,
    input.now
  );
  const version = await nextVersion(
    input.tx,
    modelPriceVersion,
    input.portalGroupId,
    input.portalModelId
  );
  await input.tx.insert(modelPriceVersion).values({
    id: input.newId(),
    portalGroupId: input.portalGroupId,
    portalModelId: input.portalModelId,
    version,
    status: 'active',
    ...input.price,
    newapiRefInputMicroUsdPerM: input.references.input,
    newapiRefCachedInputMicroUsdPerM: input.references.cachedInput,
    newapiRefCacheWrite5mMicroUsdPerM: input.references.cacheWrite5m,
    newapiRefCacheWrite1hMicroUsdPerM: input.references.cacheWrite1h,
    newapiRefOutputMicroUsdPerM: input.references.output,
    refNewapiGroup: input.refNewapiGroup,
    sourceNote: input.sourceNote,
    publishedBy: input.operatorUserId,
  });
  await input.tx
    .update(catalogModelListing)
    .set({
      inputMicroUsd: input.price.inputMicroUsdPerM,
      outputMicroUsd: input.price.outputMicroUsdPerM,
    })
    .where(
      and(
        eq(catalogModelListing.modelId, input.modelPk),
        eq(catalogModelListing.groupId, input.portalGroupId)
      )
    );
  await recordPortalAdminAudit(
    {
      action: 'price.publish',
      operatorUserId: input.operatorUserId,
      targetType: 'model_price_version',
      targetId: `${input.portalGroupId}:${input.portalModelId}`,
      beforeJson: input.capturedActive
        ? { version: input.capturedActive.version }
        : undefined,
      afterJson: priceAuditShape(
        version,
        input.price,
        input.references,
        input.refNewapiGroup
      ),
    },
    input.tx
  );
  return version;
}

async function insertRouteInTx(input: {
  tx: any;
  capturedActive: typeof modelRoute.$inferSelect | undefined;
  portalGroupId: string;
  portalModelId: string;
  newapiGroup: string;
  newapiModelId: string;
  operatorUserId: string;
  newId: () => string;
  now: Date;
}) {
  await assertCapturedActive(
    input.tx,
    modelRoute,
    input.capturedActive,
    input.portalGroupId,
    input.portalModelId,
    input.now
  );
  const version = await nextVersion(
    input.tx,
    modelRoute,
    input.portalGroupId,
    input.portalModelId
  );
  await input.tx.insert(modelRoute).values({
    id: input.newId(),
    portalGroupId: input.portalGroupId,
    portalModelId: input.portalModelId,
    newapiGroup: input.newapiGroup,
    newapiModelId: input.newapiModelId,
    version,
    status: 'active',
    publishedBy: input.operatorUserId,
  });
  await recordPortalAdminAudit(
    {
      action: 'routing.publish',
      operatorUserId: input.operatorUserId,
      targetType: 'model_route',
      targetId: `${input.portalGroupId}:${input.portalModelId}`,
      beforeJson: input.capturedActive
        ? {
            version: input.capturedActive.version,
            newapiGroup: input.capturedActive.newapiGroup,
            newapiModelId: input.capturedActive.newapiModelId,
          }
        : undefined,
      afterJson: {
        version,
        newapiGroup: input.newapiGroup,
        newapiModelId: input.newapiModelId,
      },
    },
    input.tx
  );
  return version;
}

async function pricingSnapshot(deps: RouteServiceDeps) {
  return deps.getPricingSnapshot
    ? deps.getPricingSnapshot()
    : createNewApiClient().getPricingSnapshot();
}

export async function publishPriceVersion(
  input: PublishPriceInput,
  deps: RouteServiceDeps = {}
): Promise<PublishResult> {
  const context = await loadContext(input.portalGroupId, input.portalModelId);
  const failures = validateCatalogContext(context);
  if (!context.group || !context.model || !context.basePrice) {
    return { ok: false, failures };
  }

  const snapshot = await pricingSnapshot(deps);
  const targetGroup =
    context.activeRoute?.newapiGroup ?? context.group.newapiGroup;
  const ratioBps = getRatioBps(snapshot, targetGroup);
  if (ratioBps === null) {
    failures.push(
      failure(
        'target_group_ratio',
        `目标 New API 分组 ${targetGroup} 缺少有效倍率`
      )
    );
  }
  const validation =
    ratioBps === null
      ? undefined
      : validatePrice(input.price, context.basePrice, ratioBps);
  if (validation) failures.push(...validation.failures);
  if (failures.length > 0 || !validation?.references) {
    return { ok: false, failures };
  }

  const newId = deps.newId ?? getUuid;
  const version = await translateConcurrent<number>(() =>
    db().transaction((tx: any) =>
      insertPriceVersionInTx({
        tx,
        capturedActive: context.activePrice,
        portalGroupId: input.portalGroupId,
        portalModelId: input.portalModelId,
        modelPk: context.model!.id,
        price: input.price,
        references: validation.references!,
        refNewapiGroup: targetGroup,
        sourceNote: input.sourceNote,
        operatorUserId: input.operatorUserId,
        newId,
        now: new Date(),
      })
    )
  );
  (deps.revalidate ?? revalidateCatalog)();
  return success(version);
}

export async function publishModelRoute(
  input: PublishRouteInput,
  deps: RouteServiceDeps = {}
): Promise<PublishResult> {
  const context = await loadContext(input.portalGroupId, input.portalModelId);
  const failures = validateCatalogContext(context);
  if (!context.group || !context.model || !context.basePrice) {
    return { ok: false, failures };
  }

  const snapshot = await pricingSnapshot(deps);
  const ratioBps = getRatioBps(snapshot, input.newapiGroup);
  if (ratioBps === null) {
    failures.push(
      failure(
        'target_group_ratio',
        `目标 New API 分组 ${input.newapiGroup} 缺少有效倍率`
      )
    );
  }
  const usableGroups = deps.getUsableGroups
    ? await deps.getUsableGroups()
    : snapshot.usableGroups;
  if (!usableGroups.includes(input.newapiGroup)) {
    failures.push(
      failure('usable_groups', '目标 New API 分组不在可用分组列表中')
    );
  }
  const endpointTypes = parseEndpointTypes(
    context.basePrice.sourceSupportedEndpointTypes
  );
  if (!endpointTypes.some((item) => CALLABLE_ENDPOINT_TYPES.has(item))) {
    failures.push(
      failure('endpoint_intersection', '模型没有一期网关支持的调用端点')
    );
  }
  if (!context.activePrice) {
    failures.push(failure('price_missing', '缺少 active 价格版本'));
  }
  const newapiModelId = input.newapiModelId ?? input.portalModelId;
  if (newapiModelId !== input.portalModelId) {
    failures.push(
      failure(
        'model_id_identity',
        '一期要求门户模型 ID 与 New API 模型 ID 恒等'
      )
    );
  }

  const remapping = Boolean(
    context.activePrice &&
      input.newapiGroup !== context.activePrice.refNewapiGroup
  );
  let remapValidation:
    | { failures: PublishFailure[]; references?: PriceReferences }
    | undefined;
  if (remapping && !input.remapPrice) {
    failures.push(
      failure('remap_requires_price', '跨分组重映射必须原子发布配套价格')
    );
  } else if (!remapping && input.remapPrice) {
    failures.push(
      failure('remap_price_ambiguous', '同分组路由重发不得携带 remapPrice')
    );
  } else if (remapping && input.remapPrice && ratioBps !== null) {
    remapValidation = validatePrice(
      input.remapPrice,
      context.basePrice,
      ratioBps
    );
    if (remapValidation.failures.length > 0) {
      failures.push(
        failure(
          'price_direction_on_target_group',
          remapValidation.failures.map((item) => item.message).join('；')
        )
      );
    }
  }
  if (failures.length > 0) return { ok: false, failures };

  const newId = deps.newId ?? getUuid;
  const version = await translateConcurrent<number>(() =>
    db().transaction(async (tx: any) => {
      const now = new Date();
      if (remapping) {
        await insertPriceVersionInTx({
          tx,
          capturedActive: context.activePrice,
          portalGroupId: input.portalGroupId,
          portalModelId: input.portalModelId,
          modelPk: context.model!.id,
          price: input.remapPrice!,
          references: remapValidation!.references!,
          refNewapiGroup: input.newapiGroup,
          sourceNote: input.remapPrice!.sourceNote,
          operatorUserId: input.operatorUserId,
          newId,
          now,
        });
      }
      return insertRouteInTx({
        tx,
        capturedActive: context.activeRoute,
        portalGroupId: input.portalGroupId,
        portalModelId: input.portalModelId,
        newapiGroup: input.newapiGroup,
        newapiModelId,
        operatorUserId: input.operatorUserId,
        newId,
        now,
      });
    })
  );
  (deps.revalidate ?? revalidateCatalog)();
  return success(version);
}

export async function retireModelRoute(
  input: {
    portalGroupId: string;
    portalModelId: string;
    operatorUserId: string;
    reason: string;
  },
  deps: Pick<RouteServiceDeps, 'revalidate'> = {}
): Promise<boolean> {
  if (!input.reason.trim()) throw new Error('retire reason is required');
  const [captured] = await db()
    .select()
    .from(modelRoute)
    .where(
      and(
        eq(modelRoute.portalGroupId, input.portalGroupId),
        eq(modelRoute.portalModelId, input.portalModelId),
        eq(modelRoute.status, 'active')
      )
    )
    .limit(1);
  if (!captured) return false;

  await translateConcurrent(() =>
    db().transaction(async (tx: any) => {
      const result = await tx
        .update(modelRoute)
        .set({ status: 'retired', retiredAt: new Date() })
        .where(
          and(eq(modelRoute.id, captured.id), eq(modelRoute.status, 'active'))
        );
      if (affectedRows(result) !== 1) throw new ConcurrentPublishError();
      await recordPortalAdminAudit(
        {
          action: 'routing.retire',
          operatorUserId: input.operatorUserId,
          targetType: 'model_route',
          targetId: `${input.portalGroupId}:${input.portalModelId}`,
          beforeJson: {
            version: captured.version,
            newapiGroup: captured.newapiGroup,
            newapiModelId: captured.newapiModelId,
          },
          afterJson: { status: 'retired' },
          reason: input.reason.trim(),
        },
        tx
      );
    })
  );
  (deps.revalidate ?? revalidateCatalog)();
  return true;
}
