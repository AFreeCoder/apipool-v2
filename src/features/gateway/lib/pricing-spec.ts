import {
  validateCompiledSkuRule,
  type CompiledSkuRule,
} from '@/features/api-catalog/lib/sku-rule';

import { ceilDiv } from './billing';
import {
  LONG_TOKEN_METER_KEYS,
  TOKEN_METER_KEYS,
  type MeterKey,
  type MeterQuantities,
} from './meters';

export const PRICING_SPEC_VERSION = 1;

export type PricingBasis = 'token' | 'unit' | 'duration';
export type QuantityMeter =
  | 'request_count'
  | 'output_count'
  | 'audio_duration_ms'
  | 'video_duration_ms';

export type PricingRate = {
  meterKey: MeterKey | QuantityMeter;
  skuKey: string;
  unitSize: number;
  priceMicroUsd: number;
};

export type PricingSpec = {
  version: typeof PRICING_SPEC_VERSION;
  basis: PricingBasis;
  quantityMeter?: QuantityMeter;
  rates: PricingRate[];
  skuRule?: CompiledSkuRule;
};

export type PricingChargeInput = {
  meters: MeterQuantities;
  webSearchCount: number;
  skuKey?: string | null;
  quantity?: number | null;
};

export type PricingChargeResult = {
  charged: bigint;
  unpricedMeters: Array<MeterKey | 'web_search'>;
};

const TOKEN_METERS = new Set<string>([
  ...TOKEN_METER_KEYS,
  ...LONG_TOKEN_METER_KEYS,
  'web_search',
]);
const QUANTITY_METERS = new Set<QuantityMeter>([
  'request_count',
  'output_count',
  'audio_duration_ms',
  'video_duration_ms',
]);

function assertSafePositiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new Error(`${label} 必须是安全正整数`);
  }
  return Number(value);
}

function assertSafeNonnegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`${label} 必须是安全非负整数`);
  }
  return Number(value);
}

export function validatePricingSpec(value: unknown): PricingSpec {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('定价规格必须是对象');
  }
  const raw = value as Record<string, unknown>;
  if (raw.version !== PRICING_SPEC_VERSION) {
    throw new Error('不支持的定价规格版本');
  }
  if (!['token', 'unit', 'duration'].includes(String(raw.basis))) {
    throw new Error('未知定价基准');
  }
  const basis = raw.basis as PricingBasis;
  if (!Array.isArray(raw.rates) || raw.rates.length === 0) {
    throw new Error('定价规格必须包含费率');
  }
  if (raw.rates.length > 128) {
    throw new Error('定价规格费率过多');
  }

  const quantityMeter =
    raw.quantityMeter === undefined
      ? undefined
      : (String(raw.quantityMeter) as QuantityMeter);
  if (basis === 'token' && quantityMeter !== undefined) {
    throw new Error('Token 定价不能设置数量 meter');
  }
  if (
    basis !== 'token' &&
    (!quantityMeter || !QUANTITY_METERS.has(quantityMeter))
  ) {
    throw new Error('按次或按时长定价缺少合法数量 meter');
  }
  if (basis === 'duration' && !quantityMeter?.endsWith('_duration_ms')) {
    throw new Error('按时长定价必须使用 duration_ms meter');
  }
  if (basis === 'unit' && quantityMeter?.endsWith('_duration_ms')) {
    throw new Error('按次定价不能使用 duration_ms meter');
  }

  const keys = new Set<string>();
  const rates = raw.rates.map((candidate, index): PricingRate => {
    if (
      !candidate ||
      typeof candidate !== 'object' ||
      Array.isArray(candidate)
    ) {
      throw new Error(`费率 ${index + 1} 不是对象`);
    }
    const rate = candidate as Record<string, unknown>;
    const meterKey = String(rate.meterKey ?? '');
    const skuKey = String(rate.skuKey ?? '');
    if (!skuKey) throw new Error(`费率 ${index + 1} 缺少 SKU`);
    if (basis === 'token') {
      if (!TOKEN_METERS.has(meterKey) || skuKey !== 'default') {
        throw new Error(`Token 费率 ${index + 1} 的 meter 或 SKU 无效`);
      }
    } else if (meterKey !== quantityMeter) {
      throw new Error(`费率 ${index + 1} 与数量 meter 不一致`);
    }
    const unitSize = assertSafePositiveInteger(
      rate.unitSize,
      `费率 ${index + 1} unitSize`
    );
    const priceMicroUsd = assertSafeNonnegativeInteger(
      rate.priceMicroUsd,
      `费率 ${index + 1} priceMicroUsd`
    );
    if (basis !== 'token' && priceMicroUsd === 0) {
      throw new Error(`费率 ${index + 1} 的价格必须大于 0`);
    }
    const key = `${meterKey}\u0000${skuKey}`;
    if (keys.has(key)) throw new Error(`重复费率：${meterKey}/${skuKey}`);
    keys.add(key);
    return {
      meterKey: meterKey as MeterKey | QuantityMeter,
      skuKey,
      unitSize,
      priceMicroUsd,
    };
  });

  const skuRule =
    raw.skuRule === undefined ? undefined : validateCompiledSkuRule(raw.skuRule);
  if (basis === 'token' && skuRule !== undefined) {
    throw new Error('Token 定价不能设置 SKU 规则');
  }
  if (basis !== 'token' && !skuRule) {
    throw new Error('按次或按时长定价缺少已编译 SKU 规则');
  }
  if (basis !== 'token' && !rates.some((rate) => rate.skuKey === 'default')) {
    throw new Error('按次或按时长定价必须包含 default SKU');
  }

  return {
    version: PRICING_SPEC_VERSION,
    basis,
    ...(quantityMeter ? { quantityMeter } : {}),
    rates,
    ...(skuRule ? { skuRule } : {}),
  };
}

export function parsePricingSpec(raw: string): PricingSpec {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    throw new Error('定价规格无法解析', { cause: error });
  }
  return validatePricingSpec(value);
}

export function computePricingCharge(
  spec: PricingSpec,
  input: PricingChargeInput
): PricingChargeResult {
  if (spec.basis === 'token') {
    const quantities = new Map<string, number>(
      Object.entries(input.meters).filter(([, quantity]) =>
        Boolean(quantity)
      ) as [string, number][]
    );
    if (input.webSearchCount > 0) {
      quantities.set('web_search', input.webSearchCount);
    }
    const rates = new Map(
      spec.rates.map((rate) => [rate.meterKey, rate] as const)
    );
    const numerators = new Map<number, bigint>();
    const unpricedMeters: Array<MeterKey | 'web_search'> = [];

    for (const [meterKey, quantityRaw] of quantities) {
      const quantity = assertSafeNonnegativeInteger(
        quantityRaw,
        `${meterKey} 数量`
      );
      if (quantity === 0) continue;
      const rate = rates.get(meterKey as MeterKey);
      if (!rate) {
        unpricedMeters.push(meterKey as MeterKey | 'web_search');
        continue;
      }
      const numerator =
        BigInt(quantity) *
        BigInt(
          assertSafeNonnegativeInteger(rate.priceMicroUsd, `${meterKey} 单价`)
        );
      numerators.set(
        rate.unitSize,
        (numerators.get(rate.unitSize) ?? BigInt(0)) + numerator
      );
    }

    let charged = BigInt(0);
    for (const [unitSize, numerator] of numerators) {
      charged += ceilDiv(numerator, BigInt(unitSize));
    }
    return {
      charged: charged > BigInt(0) ? charged : BigInt(1),
      unpricedMeters,
    };
  }

  const quantity = assertSafePositiveInteger(
    input.quantity,
    `${spec.quantityMeter} 数量`
  );
  const skuKey = input.skuKey || 'default';
  const rate = spec.rates.find(
    (candidate) =>
      candidate.meterKey === spec.quantityMeter && candidate.skuKey === skuKey
  );
  if (!rate) throw new Error(`定价规格缺少 SKU 价格：${skuKey}`);
  const charged = ceilDiv(
    BigInt(quantity) * BigInt(rate.priceMicroUsd),
    BigInt(rate.unitSize)
  );
  return {
    charged: charged > BigInt(0) ? charged : BigInt(1),
    unpricedMeters: [],
  };
}

export function legacyBillingSchemeForBasis(
  basis: PricingBasis
): 'token' | 'per_call' {
  return basis === 'token' ? 'token' : 'per_call';
}
