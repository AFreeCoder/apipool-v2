export function dollarsToMicroUsd(value: number | string): number {
  return decimalToScaledInteger(value, 1_000_000, 'price');
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
  supported_endpoint_types?: string[] | string | null;
};

export type DerivedNewApiPricing = {
  source: NewApiPricingSource;
  inputMicroUsd: number | null;
  outputMicroUsd: number | null;
  imageInputMicroUsd: number | null;
  imageOutputMicroUsd: number | null;
  fixedPriceMicroUsd?: number | null;
};

export type NormalizedDecimal = {
  raw: unknown;
  decimal: string;
};

export type NormalizedGroupRatio = NormalizedDecimal & {
  bps: number;
  sourceKey?: string;
};

export type PricePresentation = {
  showPrice: boolean;
  showStrikethrough: boolean;
  discountLabel?: string;
  note?: string;
};

export type EffectiveCatalogPriceInput = {
  baseInputMicroUsd?: number | null;
  baseOutputMicroUsd?: number | null;
  baseImageInputMicroUsd?: number | null;
  baseImageOutputMicroUsd?: number | null;
  groupRatioBps?: number | null;
  pricePolicy?: string | null;
  discountRateBps?: number | null;
  overrideInputMicroUsd?: number | null;
  overrideOutputMicroUsd?: number | null;
  overrideImageInputMicroUsd?: number | null;
  overrideImageOutputMicroUsd?: number | null;
  overrideStatus?: string | null;
  priceDriftStatus?: string | null;
  listInputMicroUsd?: number | null;
  listOutputMicroUsd?: number | null;
  discountNote?: string | null;
};

export type EffectiveCatalogPrice = {
  publicConfirmed: boolean;
  effectiveInputMicroUsd: number | null;
  effectiveOutputMicroUsd: number | null;
  effectiveImageInputMicroUsd: number | null;
  effectiveImageOutputMicroUsd: number | null;
  listInputMicroUsd: number | null;
  listOutputMicroUsd: number | null;
  pricePresentation: PricePresentation;
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
      fixedPriceMicroUsd:
        pricing.model_price === null || pricing.model_price === undefined
          ? null
          : dollarsToMicroUsd(pricing.model_price),
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
  const shouldDeriveImagePrices =
    imageInputUsdPerMillion !== null ||
    supportsImageEndpoint(pricing.supported_endpoint_types);

  return {
    source: 'ratio',
    inputMicroUsd: dollarsToMicroUsd(baseUsdPerMillion),
    outputMicroUsd: dollarsToMicroUsd(outputUsdPerMillion),
    imageInputMicroUsd:
      imageInputUsdPerMillion === null
        ? null
        : dollarsToMicroUsd(imageInputUsdPerMillion),
    imageOutputMicroUsd: shouldDeriveImagePrices
      ? dollarsToMicroUsd(outputUsdPerMillion)
      : null,
  };
}

export function normalizeDecimalString(
  value: number | string,
  label = 'decimal'
): string {
  let raw = typeof value === 'number' ? numberToDecimalInput(value) : value;
  raw = raw.trim();
  if (!raw) {
    throw new Error(`${label} must be a finite decimal`);
  }
  if (raw.startsWith('+')) raw = raw.slice(1);
  if (raw.startsWith('-')) {
    throw new Error(`${label} must be non-negative`);
  }
  if (!/^\d+(?:\.\d+)?$/.test(raw)) {
    throw new Error(`${label} must be a finite decimal`);
  }

  let [integer, fraction = ''] = raw.split('.');
  integer = integer.replace(/^0+(?=\d)/, '') || '0';
  fraction = fraction.replace(/0+$/, '');

  return fraction ? `${integer}.${fraction}` : integer;
}

export function decimalToScaledInteger(
  value: number | string,
  scale: number,
  label = 'decimal'
): number {
  if (!Number.isSafeInteger(scale) || scale <= 0) {
    throw new Error('scale must be a positive safe integer');
  }

  const decimal = normalizeDecimalString(value, label);
  const [integer, fraction = ''] = decimal.split('.');
  const numerator = BigInt(`${integer}${fraction || ''}`) * BigInt(scale);
  const denominator = BigInt(10) ** BigInt(fraction.length);
  let result = numerator / denominator;
  const remainder = numerator % denominator;
  if (remainder * BigInt(2) >= denominator) {
    result += BigInt(1);
  }
  const asNumber = Number(result);
  if (!Number.isSafeInteger(asNumber)) {
    throw new Error(`${label} scaled value exceeds safe integer range`);
  }
  return asNumber;
}

export function normalizeGroupRatio(
  value: number | string,
  sourceKey?: string
): NormalizedGroupRatio {
  const decimal = normalizeDecimalString(value, 'group ratio');
  return {
    raw: value,
    decimal,
    bps: decimalToScaledInteger(decimal, 10_000, 'group ratio'),
    sourceKey,
  };
}

export function deriveBasePriceFromNewApiPricing(
  pricing: NewApiPricingLike
): DerivedNewApiPricing {
  return derivePricingFromNewApiPricing(pricing);
}

export function resolveEffectiveCatalogPrice(
  input: EffectiveCatalogPriceInput
): EffectiveCatalogPrice {
  const policy = input.pricePolicy || 'inherit_group';
  const driftStatus = input.priceDriftStatus || 'unknown';
  const isMatched = driftStatus === 'matched';

  const hidden = (): EffectiveCatalogPrice => ({
    publicConfirmed: false,
    effectiveInputMicroUsd: null,
    effectiveOutputMicroUsd: null,
    effectiveImageInputMicroUsd: null,
    effectiveImageOutputMicroUsd: null,
    listInputMicroUsd: null,
    listOutputMicroUsd: null,
    pricePresentation: {
      showPrice: false,
      showStrikethrough: false,
    },
  });

  if (!isMatched) return hidden();

  let effectiveInput: number | null = null;
  let effectiveOutput: number | null = null;
  let effectiveImageInput: number | null = null;
  let effectiveImageOutput: number | null = null;

  if (policy === 'inherit_group') {
    if (!input.groupRatioBps) return hidden();
    effectiveInput = scaleMicroUsd(
      input.baseInputMicroUsd,
      input.groupRatioBps
    );
    effectiveOutput = scaleMicroUsd(
      input.baseOutputMicroUsd,
      input.groupRatioBps
    );
    effectiveImageInput = scaleMicroUsd(
      input.baseImageInputMicroUsd,
      input.groupRatioBps
    );
    effectiveImageOutput = scaleMicroUsd(
      input.baseImageOutputMicroUsd,
      input.groupRatioBps
    );
  } else if (policy === 'listing_multiplier') {
    if (!input.discountRateBps) return hidden();
    effectiveInput = scaleMicroUsd(
      input.baseInputMicroUsd,
      input.discountRateBps
    );
    effectiveOutput = scaleMicroUsd(
      input.baseOutputMicroUsd,
      input.discountRateBps
    );
    effectiveImageInput = scaleMicroUsd(
      input.baseImageInputMicroUsd,
      input.discountRateBps
    );
    effectiveImageOutput = scaleMicroUsd(
      input.baseImageOutputMicroUsd,
      input.discountRateBps
    );
  } else if (policy === 'price_override') {
    if (input.overrideStatus !== 'verified') return hidden();
    effectiveInput = input.overrideInputMicroUsd ?? null;
    effectiveOutput = input.overrideOutputMicroUsd ?? null;
    effectiveImageInput = input.overrideImageInputMicroUsd ?? null;
    effectiveImageOutput = input.overrideImageOutputMicroUsd ?? null;
  } else {
    return hidden();
  }

  if (effectiveInput === null || effectiveOutput === null) {
    return hidden();
  }

  const listInput = input.listInputMicroUsd ?? input.baseInputMicroUsd ?? null;
  const listOutput =
    input.listOutputMicroUsd ?? input.baseOutputMicroUsd ?? null;
  const showStrikethrough =
    effectiveInput !== null &&
    listInput !== null &&
    effectiveInput < listInput &&
    effectiveOutput !== null &&
    listOutput !== null &&
    effectiveOutput < listOutput;

  return {
    publicConfirmed: true,
    effectiveInputMicroUsd: effectiveInput,
    effectiveOutputMicroUsd: effectiveOutput,
    effectiveImageInputMicroUsd: effectiveImageInput,
    effectiveImageOutputMicroUsd: effectiveImageOutput,
    listInputMicroUsd: listInput,
    listOutputMicroUsd: listOutput,
    pricePresentation: {
      showPrice: true,
      showStrikethrough,
      discountLabel: showStrikethrough
        ? formatEffectiveDiscountLabel(effectiveInput, listInput)
        : undefined,
      note: input.discountNote || undefined,
    },
  };
}

export function quotaSpendFromEffectivePrice(input: {
  inputTokens: number;
  outputTokens: number;
  effectiveInputMicroUsd: number;
  effectiveOutputMicroUsd: number;
  quotaPerUnit: number;
}): number {
  const usd =
    (input.inputTokens * input.effectiveInputMicroUsd) / 1_000_000 / 1_000_000 +
    (input.outputTokens * input.effectiveOutputMicroUsd) /
      1_000_000 /
      1_000_000;
  return Math.round(usd * input.quotaPerUnit);
}

function finiteOrDefault(value: number | null | undefined, fallback: number) {
  if (value === null || value === undefined) return fallback;
  return Number.isFinite(value) ? value : fallback;
}

function numberToDecimalInput(value: number) {
  if (!Number.isFinite(value)) {
    throw new Error('decimal must be a finite decimal');
  }
  if (value < 0) {
    throw new Error('decimal must be non-negative');
  }
  if (String(value).includes('e')) {
    return value.toFixed(12).replace(/0+$/, '').replace(/\.$/, '');
  }
  return String(value);
}

function scaleMicroUsd(value: number | null | undefined, bps: number) {
  if (value === null || value === undefined) return null;
  return Math.round((value * bps) / 10_000);
}

function formatEffectiveDiscountLabel(
  effective: number | null,
  list: number | null
) {
  if (!effective || !list || effective >= list) return undefined;
  return formatDiscountRate(Math.round((effective / list) * 10000));
}

function supportsImageEndpoint(value: string[] | string | null | undefined) {
  const endpointTypes = Array.isArray(value) ? value : value ? [value] : [];

  return endpointTypes.some((endpointType) =>
    endpointType.toLowerCase().includes('image')
  );
}

function formatDecimal(value: number): string {
  return String(Number(value.toFixed(4)));
}
