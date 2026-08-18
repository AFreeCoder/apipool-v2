import 'server-only';

import { createHash } from 'node:crypto';
import { and, asc, count, eq } from 'drizzle-orm';

import {
  catalogModel,
  catalogModelListing,
  catalogModelPricingProfile,
  catalogModelPricingRate,
} from '@/config/db/schema';
import { db } from '@/core/db';
import {
  dollarsToMicroUsd,
  microUsdToDollars,
  scaleMicroUsdByBps,
} from '@/features/api-catalog/lib/pricing';
import {
  compileSkuRule,
  SKU_RULE_COMPILER_VERSION,
  type CompiledSkuRule,
} from '@/features/api-catalog/lib/sku-rule';
import {
  LONG_TOKEN_METER_KEYS,
  TOKEN_METER_KEYS,
  type MeterKey,
} from '@/features/gateway/lib/meters';
import {
  PRICING_SPEC_VERSION,
  validatePricingSpec,
  type PricingBasis,
  type PricingRate,
  type PricingSpec,
  type QuantityMeter,
} from '@/features/gateway/lib/pricing-spec';
import { getUuid } from '@/shared/lib/hash';

export type PricingProfile = typeof catalogModelPricingProfile.$inferSelect;
export type PricingProfileRate = typeof catalogModelPricingRate.$inferSelect;

export type PricingProfileConfig = {
  profile: PricingProfile;
  rates: PricingProfileRate[];
};

export type PricingProfileFormInput = {
  name: string;
  pricingBasis: PricingBasis;
  quantityMeter: QuantityMeter | null;
  ratesJson: string;
  skuRuleSource: string;
  longContextThresholdTokens: number | null;
  reviewNote: string | null;
};

export class PricingProfileValidationError extends Error {}
export class PricingProfileDeleteBlockedError extends Error {}

const TOKEN_METERS = new Set<MeterKey>([
  ...TOKEN_METER_KEYS,
  ...LONG_TOKEN_METER_KEYS,
  'web_search',
]);

const CATEGORY_BASIS: Record<string, readonly PricingBasis[]> = {
  llm: ['token'],
  embedding: ['token'],
  image: ['token', 'unit'],
  video: ['token', 'unit', 'duration'],
  audio: ['token', 'unit', 'duration'],
};

const SKU_FACTS: Record<string, readonly string[]> = {
  image: ['quality', 'size', 'resolution'],
  video: ['resolution', 'format'],
  audio: ['format', 'voice'],
};

export function getAllowedPricingBases(category: string): PricingBasis[] {
  return [...(CATEGORY_BASIS[category] ?? ['token'])];
}

export function getAllowedQuantityMeters(
  category: string,
  basis: PricingBasis
): QuantityMeter[] {
  if (basis === 'token') return [];
  if (category === 'image') {
    return basis === 'unit' ? ['output_count'] : [];
  }
  if (category === 'video') {
    return basis === 'duration'
      ? ['video_duration_ms']
      : ['request_count', 'output_count'];
  }
  if (category === 'audio') {
    return basis === 'duration'
      ? ['audio_duration_ms']
      : ['request_count', 'output_count'];
  }
  return [];
}

export function getAllowedSkuFacts(category: string): string[] {
  return [...(SKU_FACTS[category] ?? [])];
}

function parseThreshold(value: FormDataEntryValue | null) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new PricingProfileValidationError('长上下文阈值必须是安全正整数');
  }
  return parsed;
}

function parseBasis(value: FormDataEntryValue | null): PricingBasis {
  const basis = String(value ?? '');
  if (!['token', 'unit', 'duration'].includes(basis)) {
    throw new PricingProfileValidationError('计费方式无效');
  }
  return basis as PricingBasis;
}

function parseQuantityMeter(
  value: FormDataEntryValue | null
): QuantityMeter | null {
  const meter = String(value ?? '').trim();
  if (!meter) return null;
  if (
    ![
      'request_count',
      'output_count',
      'audio_duration_ms',
      'video_duration_ms',
    ].includes(meter)
  ) {
    throw new PricingProfileValidationError('数量计量单位无效');
  }
  return meter as QuantityMeter;
}

export function parsePricingProfileFormData(
  data: FormData
): PricingProfileFormInput {
  const name = String(data.get('name') ?? '').trim();
  if (!name || name.length > 100) {
    throw new PricingProfileValidationError(
      '定价档案名称不能为空且不能超过 100 个字符'
    );
  }
  return {
    name,
    pricingBasis: parseBasis(data.get('pricingBasis')),
    quantityMeter: parseQuantityMeter(data.get('quantityMeter')),
    ratesJson: String(data.get('ratesJson') ?? '').trim(),
    skuRuleSource: String(data.get('skuRuleSource') ?? '').trim(),
    longContextThresholdTokens: parseThreshold(
      data.get('longContextThresholdTokens')
    ),
    reviewNote: String(data.get('reviewNote') ?? '').trim() || null,
  };
}

type ParsedRateInput = {
  meterKey: MeterKey | QuantityMeter;
  skuKey: string;
  unitSize: number;
  priceMicroUsd: number;
  note: string | null;
};

function parseRateValue(
  key: string,
  raw: unknown
): { priceMicroUsd: number; note: string | null } {
  const source =
    raw && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : { price: raw };
  let priceMicroUsd: number;
  try {
    priceMicroUsd = dollarsToMicroUsd(String(source.price ?? ''));
  } catch {
    throw new PricingProfileValidationError(`费率 ${key} 的美元价格无效`);
  }
  const note = String(source.note ?? '').trim() || null;
  return { priceMicroUsd, note };
}

function parseRates(
  raw: string,
  basis: PricingBasis,
  quantityMeter: QuantityMeter | null
): ParsedRateInput[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new PricingProfileValidationError('费率 JSON 无法解析');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new PricingProfileValidationError('费率必须是 JSON 对象');
  }
  const entries = Object.entries(parsed);
  if (entries.length === 0 || entries.length > 128) {
    throw new PricingProfileValidationError('费率必须包含 1 到 128 个项目');
  }

  if (basis === 'token') {
    return entries.map(([meterKey, rawValue]) => {
      if (!TOKEN_METERS.has(meterKey as MeterKey)) {
        throw new PricingProfileValidationError(
          `Token 费率包含未知 meter：${meterKey}`
        );
      }
      const value = parseRateValue(meterKey, rawValue);
      return {
        meterKey: meterKey as MeterKey,
        skuKey: 'default',
        unitSize: meterKey === 'web_search' ? 1 : 1_000_000,
        ...value,
      };
    });
  }

  if (!quantityMeter) {
    throw new PricingProfileValidationError('按次或按时长定价缺少数量 meter');
  }
  return entries.map(([skuKey, rawValue]) => {
    if (!skuKey.trim()) {
      throw new PricingProfileValidationError('SKU 不能为空');
    }
    const value = parseRateValue(skuKey, rawValue);
    if (value.priceMicroUsd <= 0) {
      throw new PricingProfileValidationError(`SKU ${skuKey} 的价格必须大于 0`);
    }
    return {
      meterKey: quantityMeter,
      skuKey,
      unitSize: basis === 'duration' ? 1_000 : 1,
      ...value,
    };
  });
}

function validateCategoryConfiguration(
  category: string,
  basis: PricingBasis,
  quantityMeter: QuantityMeter | null
) {
  if (!getAllowedPricingBases(category).includes(basis)) {
    throw new PricingProfileValidationError(
      `模型分类 ${category} 不支持 ${basis} 计费`
    );
  }
  const allowedMeters = getAllowedQuantityMeters(category, basis);
  if (basis === 'token') {
    if (quantityMeter !== null) {
      throw new PricingProfileValidationError('Token 定价不能设置数量 meter');
    }
    return;
  }
  if (!quantityMeter || !allowedMeters.includes(quantityMeter)) {
    throw new PricingProfileValidationError(
      `模型分类 ${category} 的 ${basis} 计费不支持该数量 meter`
    );
  }
}

function compileProfileInput(
  category: string,
  input: PricingProfileFormInput
): {
  rates: ParsedRateInput[];
  skuRuleSource: string | null;
  skuRule: CompiledSkuRule | null;
  ruleHash: string | null;
} {
  validateCategoryConfiguration(
    category,
    input.pricingBasis,
    input.quantityMeter
  );
  if (
    input.pricingBasis !== 'token' &&
    input.longContextThresholdTokens !== null
  ) {
    throw new PricingProfileValidationError(
      '只有 Token 定价可以设置长上下文阈值'
    );
  }
  const rates = parseRates(
    input.ratesJson,
    input.pricingBasis,
    input.quantityMeter
  );

  if (input.pricingBasis === 'token') {
    if (input.skuRuleSource) {
      throw new PricingProfileValidationError('Token 定价不能设置 SKU 规则');
    }
    return {
      rates,
      skuRuleSource: null,
      skuRule: null,
      ruleHash: null,
    };
  }

  const skuRuleSource = input.skuRuleSource || 'else => "default"';
  let skuRule: CompiledSkuRule;
  try {
    skuRule = compileSkuRule(skuRuleSource, {
      allowedFields: getAllowedSkuFacts(category),
    });
  } catch (error) {
    throw new PricingProfileValidationError(
      error instanceof Error ? error.message : 'SKU 规则无法编译'
    );
  }
  if (!rates.some((rate) => rate.skuKey === 'default')) {
    throw new PricingProfileValidationError(
      '按次或按时长费率必须包含 default SKU'
    );
  }
  return {
    rates,
    skuRuleSource,
    skuRule,
    ruleHash: createHash('sha256')
      .update(JSON.stringify(skuRule))
      .digest('hex'),
  };
}

async function requireModel(modelId: string) {
  const [model] = await db()
    .select()
    .from(catalogModel)
    .where(eq(catalogModel.id, modelId))
    .limit(1);
  if (!model) throw new PricingProfileValidationError('模型不存在');
  return model;
}

export async function getPricingProfilesByModel(
  modelId: string
): Promise<PricingProfile[]> {
  return await db()
    .select()
    .from(catalogModelPricingProfile)
    .where(eq(catalogModelPricingProfile.modelId, modelId))
    .orderBy(asc(catalogModelPricingProfile.name));
}

export async function getPricingProfileConfig(
  profileId: string
): Promise<PricingProfileConfig | undefined> {
  const [profile] = await db()
    .select()
    .from(catalogModelPricingProfile)
    .where(eq(catalogModelPricingProfile.id, profileId))
    .limit(1);
  if (!profile) return undefined;
  const rates = await db()
    .select()
    .from(catalogModelPricingRate)
    .where(eq(catalogModelPricingRate.profileId, profile.id))
    .orderBy(
      asc(catalogModelPricingRate.meterKey),
      asc(catalogModelPricingRate.skuKey)
    );
  return { profile, rates };
}

export async function getPricingProfileReferenceCount(profileId: string) {
  const [result] = await db()
    .select({ value: count() })
    .from(catalogModelListing)
    .where(eq(catalogModelListing.pricingProfileId, profileId));
  return Number(result?.value ?? 0);
}

export async function upsertPricingProfile(input: {
  profileId?: string;
  modelId: string;
  operatorUserId?: string | null;
  form: PricingProfileFormInput;
}): Promise<PricingProfileConfig> {
  const model = await requireModel(input.modelId);
  const compiled = compileProfileInput(model.category, input.form);
  const now = new Date();

  return await db().transaction(async (tx: any) => {
    if (input.profileId) {
      const [existing] = await tx
        .select()
        .from(catalogModelPricingProfile)
        .where(eq(catalogModelPricingProfile.id, input.profileId))
        .limit(1);
      if (!existing || existing.modelId !== model.id) {
        throw new PricingProfileValidationError('定价档案不存在');
      }
    }

    const profilePatch = {
      modelId: model.id,
      name: input.form.name,
      pricingBasis: input.form.pricingBasis,
      quantityMeter: input.form.quantityMeter,
      skuRuleSource: compiled.skuRuleSource,
      skuRuleAstJson: compiled.skuRule
        ? JSON.stringify(compiled.skuRule)
        : null,
      compilerVersion: compiled.skuRule ? SKU_RULE_COMPILER_VERSION : null,
      ruleHash: compiled.ruleHash,
      longContextThresholdTokens: input.form.longContextThresholdTokens,
      reviewedBy: input.operatorUserId ?? null,
      reviewedAt: now,
      reviewNote: input.form.reviewNote,
      updatedAt: now,
    };
    const [profile] = input.profileId
      ? await tx
          .update(catalogModelPricingProfile)
          .set(profilePatch)
          .where(
            and(
              eq(catalogModelPricingProfile.id, input.profileId),
              eq(catalogModelPricingProfile.modelId, model.id)
            )
          )
          .returning()
      : await tx
          .insert(catalogModelPricingProfile)
          .values({ ...profilePatch, id: getUuid() })
          .returning();
    if (!profile) throw new Error('定价档案保存失败');

    await tx
      .delete(catalogModelPricingRate)
      .where(eq(catalogModelPricingRate.profileId, profile.id));
    const rates = await tx
      .insert(catalogModelPricingRate)
      .values(
        compiled.rates.map((rate) => ({
          id: getUuid(),
          profileId: profile.id,
          ...rate,
        }))
      )
      .returning();
    return { profile, rates };
  });
}

export async function deletePricingProfile(
  modelId: string,
  profileId: string
): Promise<void> {
  const references = await getPricingProfileReferenceCount(profileId);
  if (references > 0) {
    throw new PricingProfileDeleteBlockedError(
      `仍有 ${references} 条分组售卖项引用该定价档案`
    );
  }
  await db()
    .delete(catalogModelPricingProfile)
    .where(
      and(
        eq(catalogModelPricingProfile.id, profileId),
        eq(catalogModelPricingProfile.modelId, modelId)
      )
    );
}

export function formatPricingRatesForForm(
  rates: readonly PricingProfileRate[]
): string {
  const value = Object.fromEntries(
    rates.map((rate) => [
      rate.skuKey === 'default' && TOKEN_METERS.has(rate.meterKey as MeterKey)
        ? rate.meterKey
        : rate.skuKey,
      rate.note
        ? {
            price: microUsdToDollars(rate.priceMicroUsd),
            note: rate.note,
          }
        : microUsdToDollars(rate.priceMicroUsd),
    ])
  );
  return JSON.stringify(value, null, 2);
}

export function buildEffectivePricingSpec(
  config: PricingProfileConfig,
  discountRateBps: number
): PricingSpec {
  let skuRule: CompiledSkuRule | undefined;
  if (config.profile.skuRuleAstJson) {
    try {
      skuRule = JSON.parse(config.profile.skuRuleAstJson) as CompiledSkuRule;
    } catch (error) {
      throw new PricingProfileValidationError('已编译 SKU 规则无法解析', {
        cause: error,
      });
    }
  }
  const rates: PricingRate[] = config.rates.map((rate) => {
    const priceMicroUsd = scaleMicroUsdByBps(
      rate.priceMicroUsd,
      discountRateBps
    );
    if (priceMicroUsd === null) {
      throw new PricingProfileValidationError('折后费率无法计算');
    }
    return {
      meterKey: rate.meterKey as MeterKey | QuantityMeter,
      skuKey: rate.skuKey,
      unitSize: rate.unitSize,
      priceMicroUsd,
    };
  });
  return validatePricingSpec({
    version: PRICING_SPEC_VERSION,
    basis: config.profile.pricingBasis,
    ...(config.profile.quantityMeter
      ? { quantityMeter: config.profile.quantityMeter }
      : {}),
    rates,
    ...(skuRule ? { skuRule } : {}),
  });
}
