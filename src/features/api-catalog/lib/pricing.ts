export function dollarsToMicroUsd(value: number | string): number {
  const amount = typeof value === 'number' ? value : Number(value);

  if (!Number.isFinite(amount)) {
    throw new Error('price must be a finite number');
  }

  if (amount < 0) {
    throw new Error('price must be non-negative');
  }

  return Math.round(amount * 1_000_000);
}

export function optionalDollarsToMicroUsd(
  value: FormDataEntryValue | null
): number | null {
  if (value === null) return null;

  const raw = String(value).trim();
  if (!raw) return null;

  return dollarsToMicroUsd(raw);
}

export function microUsdToDollars(value: number | null | undefined): string {
  if (value === null || value === undefined) return '';

  return String(value / 1_000_000);
}

export type NewApiPricingSource = 'ratio' | 'fixed-price';

export type NewApiPricingLike = {
  model_name?: string;
  quota_type: number;
  model_ratio?: number | null;
  model_price?: number | null;
  completion_ratio?: number | null;
  image_ratio?: number | null;
};

export type DerivedNewApiPricing = {
  source: NewApiPricingSource;
  inputMicroUsd: number | null;
  outputMicroUsd: number | null;
  imageInputMicroUsd: number | null;
  imageOutputMicroUsd: number | null;
};

const NEW_API_QUOTA_TYPE_FIXED_PRICE = 1;
const NEW_API_USD_PER_MILLION_RATIO_MULTIPLIER = 2;

export function discountFoldToBps(
  value: number | string | FormDataEntryValue | null | undefined
): number | null {
  if (value === null || value === undefined) return null;

  const raw = String(value).trim();
  if (!raw) return null;

  const amount = Number(raw);
  if (!Number.isFinite(amount)) {
    throw new Error('discount fold must be a finite number');
  }

  if (amount < 0.01 || amount > 10) {
    throw new Error('discount fold must be between 0.01 and 10');
  }

  return Math.round(amount * 1000);
}

export function bpsToDiscountFold(value: number | null | undefined): string {
  if (value === null || value === undefined) return '';

  return formatDecimal(value / 1000);
}

export function formatDiscountRate(value: number | null | undefined): string {
  if (value === null || value === undefined) return '';

  return `${formatDecimal(value / 1000)} 折 (${formatDecimal(value / 100)}%)`;
}

export function derivePricingFromNewApiPricing(
  pricing: NewApiPricingLike
): DerivedNewApiPricing {
  if (pricing.quota_type === NEW_API_QUOTA_TYPE_FIXED_PRICE) {
    return {
      source: 'fixed-price',
      inputMicroUsd: null,
      outputMicroUsd: null,
      imageInputMicroUsd: null,
      imageOutputMicroUsd: null,
    };
  }

  const modelRatio = finiteOrDefault(pricing.model_ratio, 0);
  const completionRatio = finiteOrDefault(pricing.completion_ratio, 1);
  const baseUsdPerMillion =
    modelRatio * NEW_API_USD_PER_MILLION_RATIO_MULTIPLIER;
  const outputUsdPerMillion = baseUsdPerMillion * completionRatio;
  const imageInputUsdPerMillion =
    pricing.image_ratio === null || pricing.image_ratio === undefined
      ? null
      : baseUsdPerMillion * finiteOrDefault(pricing.image_ratio, 0);

  return {
    source: 'ratio',
    inputMicroUsd: dollarsToMicroUsd(baseUsdPerMillion),
    outputMicroUsd: dollarsToMicroUsd(outputUsdPerMillion),
    imageInputMicroUsd:
      imageInputUsdPerMillion === null
        ? null
        : dollarsToMicroUsd(imageInputUsdPerMillion),
    imageOutputMicroUsd: dollarsToMicroUsd(outputUsdPerMillion),
  };
}

function finiteOrDefault(value: number | null | undefined, fallback: number) {
  if (value === null || value === undefined) return fallback;
  return Number.isFinite(value) ? value : fallback;
}

function formatDecimal(value: number): string {
  return String(Number(value.toFixed(4)));
}
