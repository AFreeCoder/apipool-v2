import 'server-only';

import { and, asc, eq } from 'drizzle-orm';

import {
  catalogGroup,
  catalogModel,
  catalogModelListing,
  catalogModelPricingProfile,
  catalogModelPricingRate,
  catalogStatus,
} from '@/config/db/schema';
import { db } from '@/core/db';
import {
  buildEffectivePricingSpec,
  getAllowedPricingBases,
  getAllowedQuantityMeters,
  type PricingProfile,
  type PricingProfileRate,
} from '@/features/api-catalog/server/pricing-profile-service';
import {
  legacyBillingSchemeForBasis,
  type PricingBasis,
  type PricingSpec,
} from '@/features/gateway/lib/pricing-spec';

type PublishSnapshot = {
  newapiGroup: string;
  newapiModelId: string;
  pricingBasis: PricingBasis;
  billingScheme: 'token' | 'per_call';
  pricingSpecJson: string;
  pricingProfileId: string;
  pricingProfileRuleHash: string | null;
  ratesJson: string;
  tiersJson: string;
  longContextThresholdTokens: number | null;
  admissionLongContextThreshold: number | null;
  allowLongContext: boolean;
};

export type PublishReadiness =
  | { ready: true; snapshot: PublishSnapshot }
  | { ready: false; reasons: string[] };

type PublishRow = {
  listingId: string;
  listingModelId: string;
  pricingProfileId: string | null;
  newapiGroup: string;
  newapiModelId: string;
  category: string;
  isCallable: boolean;
  discountRateBps: number | null;
  allowLongContext: boolean;
  profileId: string | null;
  profileModelId: string | null;
  profileName: string | null;
  pricingBasis: string | null;
  quantityMeter: string | null;
  skuRuleSource: string | null;
  skuRuleAstJson: string | null;
  compilerVersion: number | null;
  ruleHash: string | null;
  longContextThresholdTokens: number | null;
  reviewedBy: string | null;
  reviewedAt: Date | null;
  reviewNote: string | null;
  profileCreatedAt: Date | null;
  profileUpdatedAt: Date | null;
  rateId: string | null;
  rateMeterKey: string | null;
  rateSkuKey: string | null;
  rateUnitSize: number | null;
  ratePriceMicroUsd: number | null;
  rateNote: string | null;
};

function validDiscount(value: number) {
  return Number.isSafeInteger(value) && value > 0 && value <= 10_000;
}

function validateCategoryAndMeter(row: PublishRow, reasons: Set<string>) {
  if (!row.pricingBasis) return;
  const basis = row.pricingBasis as PricingBasis;
  if (!getAllowedPricingBases(row.category).includes(basis)) {
    reasons.add(`模型分类 ${row.category} 不支持 ${basis} 计费`);
    return;
  }
  const allowedMeters = getAllowedQuantityMeters(row.category, basis);
  if (basis === 'token') {
    if (row.quantityMeter !== null) reasons.add('Token 定价不能设置数量 meter');
    return;
  }
  if (!row.quantityMeter || !allowedMeters.includes(row.quantityMeter as any)) {
    reasons.add('数量 meter 与模型分类或计费方式不匹配');
  }
}

function validateRequiredTokenMeters(
  category: string,
  spec: PricingSpec,
  allowLongContext: boolean,
  longContextThresholdTokens: number | null,
  reasons: Set<string>
) {
  if (spec.basis !== 'token') return;
  const meters = new Set(spec.rates.map((rate) => rate.meterKey));
  const required =
    category === 'embedding'
      ? ['input']
      : category === 'image'
        ? ['input', 'image_input', 'image_output']
        : category === 'llm'
          ? ['input', 'output']
          : [];
  for (const meter of required) {
    if (!meters.has(meter as any)) reasons.add(`缺少计价项：${meter}`);
  }
  if (allowLongContext) {
    if (
      longContextThresholdTokens === null ||
      !Number.isSafeInteger(longContextThresholdTokens) ||
      longContextThresholdTokens <= 0
    ) {
      reasons.add('开放长上下文时必须配置有效阈值');
    }
    for (const meter of ['input_long', 'output_long']) {
      if (!meters.has(meter as any)) reasons.add(`缺少计价项：${meter}`);
    }
  }
}

function legacyMaps(spec: PricingSpec) {
  if (spec.basis === 'token') {
    return {
      ratesJson: JSON.stringify(
        Object.fromEntries(
          spec.rates.map((rate) => [rate.meterKey, rate.priceMicroUsd])
        )
      ),
      tiersJson: '{}',
    };
  }
  return {
    ratesJson: '{}',
    tiersJson: JSON.stringify(
      Object.fromEntries(
        spec.rates.map((rate) => [rate.skuKey, rate.priceMicroUsd])
      )
    ),
  };
}

export async function assessPublishReadiness(
  portalGroupId: string,
  portalModelId: string
): Promise<PublishReadiness> {
  const rows = (await db()
    .select({
      listingId: catalogModelListing.id,
      listingModelId: catalogModelListing.modelId,
      pricingProfileId: catalogModelListing.pricingProfileId,
      newapiGroup: catalogModelListing.newapiGroup,
      newapiModelId: catalogModel.modelId,
      category: catalogModel.category,
      isCallable: catalogStatus.isCallable,
      discountRateBps: catalogModelListing.discountRateBps,
      allowLongContext: catalogModelListing.allowLongContext,
      profileId: catalogModelPricingProfile.id,
      profileModelId: catalogModelPricingProfile.modelId,
      profileName: catalogModelPricingProfile.name,
      pricingBasis: catalogModelPricingProfile.pricingBasis,
      quantityMeter: catalogModelPricingProfile.quantityMeter,
      skuRuleSource: catalogModelPricingProfile.skuRuleSource,
      skuRuleAstJson: catalogModelPricingProfile.skuRuleAstJson,
      compilerVersion: catalogModelPricingProfile.compilerVersion,
      ruleHash: catalogModelPricingProfile.ruleHash,
      longContextThresholdTokens:
        catalogModelPricingProfile.longContextThresholdTokens,
      reviewedBy: catalogModelPricingProfile.reviewedBy,
      reviewedAt: catalogModelPricingProfile.reviewedAt,
      reviewNote: catalogModelPricingProfile.reviewNote,
      profileCreatedAt: catalogModelPricingProfile.createdAt,
      profileUpdatedAt: catalogModelPricingProfile.updatedAt,
      rateId: catalogModelPricingRate.id,
      rateMeterKey: catalogModelPricingRate.meterKey,
      rateSkuKey: catalogModelPricingRate.skuKey,
      rateUnitSize: catalogModelPricingRate.unitSize,
      ratePriceMicroUsd: catalogModelPricingRate.priceMicroUsd,
      rateNote: catalogModelPricingRate.note,
    })
    .from(catalogModelListing)
    .innerJoin(catalogGroup, eq(catalogModelListing.groupId, catalogGroup.id))
    .innerJoin(catalogModel, eq(catalogModelListing.modelId, catalogModel.id))
    .innerJoin(
      catalogStatus,
      eq(catalogModelListing.statusId, catalogStatus.id)
    )
    .leftJoin(
      catalogModelPricingProfile,
      eq(catalogModelListing.pricingProfileId, catalogModelPricingProfile.id)
    )
    .leftJoin(
      catalogModelPricingRate,
      eq(catalogModelPricingRate.profileId, catalogModelPricingProfile.id)
    )
    .where(
      and(
        eq(catalogGroup.id, portalGroupId),
        eq(catalogModel.modelId, portalModelId)
      )
    )
    .orderBy(
      asc(catalogModelPricingRate.meterKey),
      asc(catalogModelPricingRate.skuKey)
    )) as PublishRow[];

  if (rows.length === 0) {
    return { ready: false, reasons: ['未找到目录售卖项'] };
  }

  const row = rows[0];
  const reasons = new Set<string>();
  if (!row.isCallable) reasons.add('售卖状态不可调用');
  if (!row.newapiGroup.trim()) reasons.add('缺少 New API 分组映射');
  if (!row.pricingProfileId || !row.profileId) reasons.add('缺少定价档案');
  if (
    row.profileId &&
    (row.profileId !== row.pricingProfileId ||
      row.profileModelId !== row.listingModelId)
  ) {
    reasons.add('定价档案不属于当前模型');
  }
  if (row.reviewedAt === null) reasons.add('定价档案尚未人工确认');

  const discountRateBps = row.discountRateBps ?? 10_000;
  if (!validDiscount(discountRateBps)) {
    reasons.add('上架折扣必须是 1 到 10000 bps');
  }
  validateCategoryAndMeter(row, reasons);

  const profile =
    row.profileId &&
    row.profileModelId &&
    row.profileName &&
    row.pricingBasis &&
    row.profileCreatedAt &&
    row.profileUpdatedAt
      ? ({
          id: row.profileId,
          modelId: row.profileModelId,
          name: row.profileName,
          pricingBasis: row.pricingBasis,
          quantityMeter: row.quantityMeter,
          skuRuleSource: row.skuRuleSource,
          skuRuleAstJson: row.skuRuleAstJson,
          compilerVersion: row.compilerVersion,
          ruleHash: row.ruleHash,
          longContextThresholdTokens: row.longContextThresholdTokens,
          reviewedBy: row.reviewedBy,
          reviewedAt: row.reviewedAt,
          reviewNote: row.reviewNote,
          createdAt: row.profileCreatedAt,
          updatedAt: row.profileUpdatedAt,
        } satisfies PricingProfile)
      : null;
  const rates = rows.flatMap((candidate) =>
    candidate.rateId &&
    candidate.profileId &&
    candidate.rateMeterKey &&
    candidate.rateSkuKey &&
    candidate.rateUnitSize !== null &&
    candidate.ratePriceMicroUsd !== null
      ? [
          {
            id: candidate.rateId,
            profileId: candidate.profileId,
            meterKey: candidate.rateMeterKey,
            skuKey: candidate.rateSkuKey,
            unitSize: candidate.rateUnitSize,
            priceMicroUsd: candidate.ratePriceMicroUsd,
            note: candidate.rateNote,
          } satisfies PricingProfileRate,
        ]
      : []
  );
  if (rates.length === 0) reasons.add('定价档案没有费率');

  let spec: PricingSpec | null = null;
  if (profile && rates.length > 0 && validDiscount(discountRateBps)) {
    try {
      spec = buildEffectivePricingSpec({ profile, rates }, discountRateBps);
      validateRequiredTokenMeters(
        row.category,
        spec,
        Boolean(row.allowLongContext),
        row.longContextThresholdTokens,
        reasons
      );
    } catch (error) {
      reasons.add(
        error instanceof Error ? error.message : '定价档案无法生成发布规格'
      );
    }
  }

  if (!spec || !profile || reasons.size > 0) {
    return { ready: false, reasons: [...reasons] };
  }

  const allowLongContext = Boolean(row.allowLongContext);
  const legacy = legacyMaps(spec);
  return {
    ready: true,
    snapshot: {
      newapiGroup: row.newapiGroup,
      newapiModelId: row.newapiModelId,
      pricingBasis: spec.basis,
      billingScheme: legacyBillingSchemeForBasis(spec.basis),
      pricingSpecJson: JSON.stringify(spec),
      pricingProfileId: profile.id,
      pricingProfileRuleHash: profile.ruleHash,
      ...legacy,
      longContextThresholdTokens:
        allowLongContext && spec.basis === 'token'
          ? profile.longContextThresholdTokens
          : null,
      admissionLongContextThreshold:
        spec.basis === 'token' ? profile.longContextThresholdTokens : null,
      allowLongContext,
    },
  };
}
