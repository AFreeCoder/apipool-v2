import 'server-only';

import { scaleMicroUsdByBps } from '@/features/api-catalog/lib/pricing';
import type { BillingScheme, MeterKey } from '@/features/gateway/lib/meters';
import { and, asc, eq } from 'drizzle-orm';

import { db } from '@/core/db';
import {
  catalogGroup,
  catalogModel,
  catalogModelListing,
  catalogModelPrice,
  catalogModelPriceTier,
  catalogStatus,
} from '@/config/db/schema';

type PublishSnapshot = {
  newapiGroup: string;
  newapiModelId: string;
  billingScheme: BillingScheme;
  ratesJson: string;
  tiersJson: string;
  longContextThresholdTokens: number | null;
  admissionLongContextThreshold: number | null;
  allowLongContext: boolean;
};

export type PublishReadiness =
  | { ready: true; snapshot: PublishSnapshot }
  | { ready: false; reasons: string[] };

const CAPABILITY_KEYS = [
  'cached_input',
  'cache_write',
  'cache_ttl_split',
  'image_input',
  'cached_image_input',
  'image_output',
  'long_context',
  'web_search',
] as const;

type CapabilityKey = (typeof CAPABILITY_KEYS)[number];
type BillingCapabilities = Partial<Record<CapabilityKey, boolean>>;

type PublishRow = {
  newapiGroup: string;
  newapiModelId: string;
  category: string;
  isCallable: boolean;
  discountRateBps: number | null;
  allowLongContext: boolean;
  priceId: string | null;
  billingScheme: string | null;
  endpointTypesJson: string | null;
  syncStatus: string | null;
  reviewedAt: Date | null;
  billingCapabilitiesJson: string | null;
  baseInput: number | null;
  baseCachedInput: number | null;
  baseCacheWrite: number | null;
  baseCacheWrite5m: number | null;
  baseCacheWrite1h: number | null;
  baseOutput: number | null;
  baseImageInput: number | null;
  baseCachedImageInput: number | null;
  baseImageOutput: number | null;
  baseWebSearch: number | null;
  longContextThreshold: number | null;
  baseInputLong: number | null;
  baseCachedInputLong: number | null;
  baseCacheWriteLong: number | null;
  baseOutputLong: number | null;
  tierSkuKey: string | null;
  tierPrice: number | null;
};

function parseCapabilities(
  raw: string | null,
  reasons: Set<string>
): BillingCapabilities | null {
  if (!raw?.trim()) {
    reasons.add('缺少计费能力声明');
    return null;
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      reasons.add('计费能力声明不是合法 JSON 对象');
      return null;
    }
    const allowed = new Set<string>(CAPABILITY_KEYS);
    for (const [key, value] of Object.entries(parsed)) {
      if (!allowed.has(key) || typeof value !== 'boolean') {
        reasons.add('计费能力声明包含未知键或非布尔值');
        return null;
      }
    }
    return parsed as BillingCapabilities;
  } catch {
    reasons.add('计费能力声明不是合法 JSON 对象');
    return null;
  }
}

function parseEndpointTypes(raw: string | null, category: string): string[] {
  if (raw?.trim()) {
    try {
      const parsed = JSON.parse(raw);
      if (
        Array.isArray(parsed) &&
        parsed.every((value) => typeof value === 'string')
      ) {
        return parsed.map((value) => value.toLowerCase());
      }
    } catch {
      // 旧目录可能没有可靠的端点元数据，按模型分类采用保守基础集。
    }
  }
  return category.toLowerCase().includes('image') ? ['images'] : ['responses'];
}

function validPrice(value: number | null): value is number {
  return value !== null && Number.isSafeInteger(value) && Number(value) >= 0;
}

function requireRate(
  rates: Partial<Record<MeterKey, number>>,
  key: MeterKey,
  value: number | null,
  discountRateBps: number,
  reasons: Set<string>
) {
  if (!validPrice(value)) {
    reasons.add(`缺少计价项：${key}`);
    return;
  }
  rates[key] = scaleMicroUsdByBps(value, discountRateBps)!;
}

function buildTokenRates(
  row: PublishRow,
  capabilities: BillingCapabilities,
  discountRateBps: number,
  reasons: Set<string>
) {
  const rates: Partial<Record<MeterKey, number>> = {};
  const endpointTypes = parseEndpointTypes(row.endpointTypesJson, row.category);
  const hasImageEndpoint = endpointTypes.some((value) =>
    value.includes('image')
  );
  const onlyEmbeddings =
    endpointTypes.length > 0 &&
    endpointTypes.every((value) => value.includes('embedding'));
  const requiresOutput = !onlyEmbeddings && !hasImageEndpoint;

  requireRate(rates, 'input', row.baseInput, discountRateBps, reasons);
  if (capabilities.cached_input) {
    requireRate(
      rates,
      'cached_input',
      row.baseCachedInput,
      discountRateBps,
      reasons
    );
  }
  if (capabilities.cache_ttl_split) {
    requireRate(
      rates,
      'cache_write_5m',
      row.baseCacheWrite5m,
      discountRateBps,
      reasons
    );
    requireRate(
      rates,
      'cache_write_1h',
      row.baseCacheWrite1h,
      discountRateBps,
      reasons
    );
  } else if (capabilities.cache_write) {
    requireRate(
      rates,
      'cache_write',
      row.baseCacheWrite,
      discountRateBps,
      reasons
    );
  }
  if (requiresOutput) {
    requireRate(rates, 'output', row.baseOutput, discountRateBps, reasons);
  }

  if (hasImageEndpoint || capabilities.image_input) {
    requireRate(
      rates,
      'image_input',
      row.baseImageInput,
      discountRateBps,
      reasons
    );
  }
  if (capabilities.cached_image_input) {
    requireRate(
      rates,
      'cached_image_input',
      row.baseCachedImageInput,
      discountRateBps,
      reasons
    );
  }
  if (hasImageEndpoint || capabilities.image_output) {
    requireRate(
      rates,
      'image_output',
      row.baseImageOutput,
      discountRateBps,
      reasons
    );
  }
  if (capabilities.web_search) {
    requireRate(
      rates,
      'web_search',
      row.baseWebSearch,
      discountRateBps,
      reasons
    );
  }

  const requiresLongContext =
    capabilities.long_context || row.longContextThreshold !== null;
  if (requiresLongContext) {
    if (
      row.longContextThreshold === null ||
      !Number.isSafeInteger(row.longContextThreshold) ||
      row.longContextThreshold <= 0
    ) {
      reasons.add('缺少有效的长上下文阈值');
    }
    const longRates: Array<[MeterKey, number | null]> = [
      ['input_long', row.baseInputLong],
      ['cached_input_long', row.baseCachedInputLong],
      ['cache_write_long', row.baseCacheWriteLong],
      ['output_long', row.baseOutputLong],
    ];
    for (const [key, value] of longRates) {
      if (row.allowLongContext) {
        requireRate(rates, key, value, discountRateBps, reasons);
      } else if (!validPrice(value)) {
        reasons.add(`缺少计价项：${key}`);
      }
    }
  }

  return rates;
}

function buildTiers(
  rows: PublishRow[],
  discountRateBps: number,
  reasons: Set<string>
) {
  const tiers: Record<string, number> = {};
  for (const row of rows) {
    if (!row.tierSkuKey || !validPrice(row.tierPrice)) continue;
    tiers[row.tierSkuKey] = scaleMicroUsdByBps(row.tierPrice, discountRateBps)!;
  }
  if (!Object.hasOwn(tiers, 'default')) {
    reasons.add('缺少按次默认档：default');
  }
  return tiers;
}

export async function assessPublishReadiness(
  portalGroupId: string,
  portalModelId: string
): Promise<PublishReadiness> {
  const rows = (await db()
    .select({
      newapiGroup: catalogGroup.newapiGroup,
      newapiModelId: catalogModel.modelId,
      category: catalogModel.category,
      isCallable: catalogStatus.isCallable,
      discountRateBps: catalogModelListing.discountRateBps,
      allowLongContext: catalogModelListing.allowLongContext,
      priceId: catalogModelPrice.id,
      billingScheme: catalogModelPrice.billingScheme,
      endpointTypesJson: catalogModelPrice.sourceSupportedEndpointTypes,
      syncStatus: catalogModelPrice.syncStatus,
      reviewedAt: catalogModelPrice.reviewedAt,
      billingCapabilitiesJson: catalogModelPrice.billingCapabilitiesJson,
      baseInput: catalogModelPrice.baseInputMicroUsd,
      baseCachedInput: catalogModelPrice.baseCachedInputMicroUsd,
      baseCacheWrite: catalogModelPrice.baseCacheWriteMicroUsd,
      baseCacheWrite5m: catalogModelPrice.baseCacheWrite5mMicroUsd,
      baseCacheWrite1h: catalogModelPrice.baseCacheWrite1hMicroUsd,
      baseOutput: catalogModelPrice.baseOutputMicroUsd,
      baseImageInput: catalogModelPrice.baseImageInputMicroUsd,
      baseCachedImageInput: catalogModelPrice.baseCachedImageInputMicroUsd,
      baseImageOutput: catalogModelPrice.baseImageOutputMicroUsd,
      baseWebSearch: catalogModelPrice.baseWebSearchMicroUsd,
      longContextThreshold: catalogModelPrice.longContextThresholdTokens,
      baseInputLong: catalogModelPrice.baseInputLongMicroUsd,
      baseCachedInputLong: catalogModelPrice.baseCachedInputLongMicroUsd,
      baseCacheWriteLong: catalogModelPrice.baseCacheWriteLongMicroUsd,
      baseOutputLong: catalogModelPrice.baseOutputLongMicroUsd,
      tierSkuKey: catalogModelPriceTier.skuKey,
      tierPrice: catalogModelPriceTier.priceMicroUsd,
    })
    .from(catalogModelListing)
    .innerJoin(catalogGroup, eq(catalogModelListing.groupId, catalogGroup.id))
    .innerJoin(catalogModel, eq(catalogModelListing.modelId, catalogModel.id))
    .innerJoin(
      catalogStatus,
      eq(catalogModelListing.statusId, catalogStatus.id)
    )
    .leftJoin(catalogModelPrice, eq(catalogModelPrice.modelId, catalogModel.id))
    .leftJoin(
      catalogModelPriceTier,
      eq(catalogModelPriceTier.modelId, catalogModel.id)
    )
    .where(
      and(
        eq(catalogGroup.id, portalGroupId),
        eq(catalogModel.modelId, portalModelId)
      )
    )
    .orderBy(asc(catalogModelPriceTier.skuKey))) as PublishRow[];

  if (rows.length === 0) {
    return { ready: false, reasons: ['未找到目录售卖项'] };
  }

  const row = rows[0];
  const reasons = new Set<string>();
  if (!row.isCallable) reasons.add('售卖状态不可调用');
  if (!row.newapiGroup.trim()) reasons.add('缺少 New API 分组映射');
  if (!row.priceId) reasons.add('缺少模型基础价');
  // syncStatus 自成本守卫起只表示参照新鲜度；人工锁定的唯一持久证据是
  // reviewedAt，New API 参照缺失或变化不得反向阻断已复核售价。
  if (row.reviewedAt === null) {
    reasons.add('基础价尚未人工锁定并复核');
  }
  const discountRateBps = row.discountRateBps ?? 10_000;
  if (
    !Number.isSafeInteger(discountRateBps) ||
    discountRateBps <= 0 ||
    discountRateBps > 10_000
  ) {
    reasons.add('上架折扣必须是 1 到 10000 bps');
  }

  const capabilities = parseCapabilities(row.billingCapabilitiesJson, reasons);
  const billingScheme = row.billingScheme;
  let rates: Partial<Record<MeterKey, number>> = {};
  let tiers: Record<string, number> = {};
  if (capabilities && billingScheme === 'token') {
    rates = buildTokenRates(row, capabilities, discountRateBps, reasons);
  } else if (capabilities && billingScheme === 'per_call') {
    tiers = buildTiers(rows, discountRateBps, reasons);
  } else if (billingScheme !== 'token' && billingScheme !== 'per_call') {
    reasons.add('未知计费方案');
  }

  if (reasons.size > 0) {
    return { ready: false, reasons: [...reasons] };
  }

  const allowLongContext = Boolean(row.allowLongContext);
  return {
    ready: true,
    snapshot: {
      newapiGroup: row.newapiGroup,
      newapiModelId: row.newapiModelId,
      billingScheme: billingScheme as BillingScheme,
      ratesJson: JSON.stringify(rates),
      tiersJson: JSON.stringify(tiers),
      longContextThresholdTokens: allowLongContext
        ? row.longContextThreshold
        : null,
      admissionLongContextThreshold: row.longContextThreshold,
      allowLongContext,
    },
  };
}
