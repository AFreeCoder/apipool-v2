import 'server-only';

import { optionalDollarsToMicroUsd } from '@/features/api-catalog/lib/pricing';

const BILLING_CAPABILITY_KEYS = [
  'cached_input',
  'cache_write',
  'cache_ttl_split',
  'image_input',
  'cached_image_input',
  'image_output',
  'long_context',
  'web_search',
] as const;

type BillingCapabilityKey = (typeof BILLING_CAPABILITY_KEYS)[number];
type BillingCapabilities = Partial<Record<BillingCapabilityKey, boolean>>;

export class CatalogPricingFormError extends Error {}

function optionalPrice(data: FormData, name: string, message: string) {
  try {
    return optionalDollarsToMicroUsd(data.get(name));
  } catch {
    throw new CatalogPricingFormError(message);
  }
}

function parseCapabilities(raw: FormDataEntryValue | null, message: string) {
  try {
    const parsed = JSON.parse(String(raw ?? '{}'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('invalid');
    }
    const result: BillingCapabilities = {};
    for (const key of BILLING_CAPABILITY_KEYS) {
      if (parsed[key] !== undefined && typeof parsed[key] !== 'boolean') {
        throw new Error('invalid');
      }
      result[key] = parsed[key] === true;
    }
    return result;
  } catch {
    throw new CatalogPricingFormError(message);
  }
}

function parseEndpointTypes(raw: FormDataEntryValue | null) {
  try {
    const parsed = JSON.parse(String(raw ?? '[]'));
    if (
      Array.isArray(parsed) &&
      parsed.every((value) => typeof value === 'string')
    ) {
      return parsed;
    }
  } catch {
    // 无候选参照时沿用文本端点的保守默认值。
  }
  return ['responses'];
}

function requirePrice(value: number | null, label: string, message: string) {
  if (value === null) {
    throw new CatalogPricingFormError(`${message}: ${label}`);
  }
}

function parseThreshold(raw: FormDataEntryValue | null, message: string) {
  const value = String(raw ?? '').trim();
  if (!value) return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new CatalogPricingFormError(message);
  }
  return parsed;
}

function parseTiers(raw: FormDataEntryValue | null, message: string) {
  try {
    const parsed = JSON.parse(String(raw ?? '[]'));
    if (!Array.isArray(parsed)) throw new Error('invalid');
    return parsed.map((tier) => {
      const skuKey = String(tier?.skuKey ?? '').trim();
      const priceMicroUsd = optionalDollarsToMicroUsd(
        String(tier?.price ?? '')
      );
      if (!skuKey || priceMicroUsd === null) throw new Error('invalid');
      return {
        skuKey,
        priceMicroUsd,
        note: String(tier?.note ?? '').trim() || null,
      };
    });
  } catch {
    throw new CatalogPricingFormError(message);
  }
}

export function parseModelPricingFormData(
  data: FormData,
  messages: {
    invalidPrice: string;
    invalidCapabilities: string;
    invalidThreshold: string;
    invalidTiers: string;
    missingRequiredPrice: string;
  }
) {
  const billingSchemeRaw = String(data.get('billingScheme') ?? 'token');
  if (billingSchemeRaw !== 'token' && billingSchemeRaw !== 'per_call') {
    throw new CatalogPricingFormError(messages.invalidPrice);
  }
  const billingScheme: 'token' | 'per_call' = billingSchemeRaw;
  const capabilities = parseCapabilities(
    data.get('billingCapabilitiesJson'),
    messages.invalidCapabilities
  );
  const endpointTypes = parseEndpointTypes(
    data.get('sourceSupportedEndpointTypes')
  );
  const inputMicroUsd = optionalPrice(
    data,
    'inputMicroUsd',
    messages.invalidPrice
  );
  const outputMicroUsd = optionalPrice(
    data,
    'outputMicroUsd',
    messages.invalidPrice
  );
  const cachedInputMicroUsd = optionalPrice(
    data,
    'cachedInputMicroUsd',
    messages.invalidPrice
  );
  const cacheWriteMicroUsd = optionalPrice(
    data,
    'cacheWriteMicroUsd',
    messages.invalidPrice
  );
  const cacheWrite5mMicroUsd = optionalPrice(
    data,
    'cacheWrite5mMicroUsd',
    messages.invalidPrice
  );
  const cacheWrite1hMicroUsd = optionalPrice(
    data,
    'cacheWrite1hMicroUsd',
    messages.invalidPrice
  );
  const imageInputMicroUsd = optionalPrice(
    data,
    'imageInputMicroUsd',
    messages.invalidPrice
  );
  const cachedImageInputMicroUsd = optionalPrice(
    data,
    'cachedImageInputMicroUsd',
    messages.invalidPrice
  );
  const imageOutputMicroUsd = optionalPrice(
    data,
    'imageOutputMicroUsd',
    messages.invalidPrice
  );
  const webSearchMicroUsd = optionalPrice(
    data,
    'webSearchMicroUsd',
    messages.invalidPrice
  );
  const longContextThresholdTokens = parseThreshold(
    data.get('longContextThresholdTokens'),
    messages.invalidThreshold
  );
  const inputLongMicroUsd = optionalPrice(
    data,
    'inputLongMicroUsd',
    messages.invalidPrice
  );
  const cachedInputLongMicroUsd = optionalPrice(
    data,
    'cachedInputLongMicroUsd',
    messages.invalidPrice
  );
  const cacheWriteLongMicroUsd = optionalPrice(
    data,
    'cacheWriteLongMicroUsd',
    messages.invalidPrice
  );
  const outputLongMicroUsd = optionalPrice(
    data,
    'outputLongMicroUsd',
    messages.invalidPrice
  );
  const tiers =
    billingScheme === 'per_call'
      ? parseTiers(data.get('tiersJson'), messages.invalidTiers)
      : [];

  if (billingScheme === 'token') {
    const hasImageEndpoint = endpointTypes.some((value) =>
      value.toLowerCase().includes('image')
    );
    const onlyEmbeddings =
      endpointTypes.length > 0 &&
      endpointTypes.every((value) => value.toLowerCase().includes('embedding'));
    requirePrice(inputMicroUsd, 'input', messages.missingRequiredPrice);
    if (!onlyEmbeddings && !hasImageEndpoint) {
      requirePrice(outputMicroUsd, 'output', messages.missingRequiredPrice);
    }
    if (capabilities.cached_input) {
      requirePrice(
        cachedInputMicroUsd,
        'cached_input',
        messages.missingRequiredPrice
      );
    }
    if (capabilities.cache_ttl_split) {
      requirePrice(
        cacheWrite5mMicroUsd,
        'cache_write_5m',
        messages.missingRequiredPrice
      );
      requirePrice(
        cacheWrite1hMicroUsd,
        'cache_write_1h',
        messages.missingRequiredPrice
      );
    } else if (capabilities.cache_write) {
      requirePrice(
        cacheWriteMicroUsd,
        'cache_write',
        messages.missingRequiredPrice
      );
    }
    if (hasImageEndpoint || capabilities.image_input) {
      requirePrice(
        imageInputMicroUsd,
        'image_input',
        messages.missingRequiredPrice
      );
    }
    if (capabilities.cached_image_input) {
      requirePrice(
        cachedImageInputMicroUsd,
        'cached_image_input',
        messages.missingRequiredPrice
      );
    }
    if (hasImageEndpoint || capabilities.image_output) {
      requirePrice(
        imageOutputMicroUsd,
        'image_output',
        messages.missingRequiredPrice
      );
    }
    if (capabilities.web_search) {
      requirePrice(
        webSearchMicroUsd,
        'web_search',
        messages.missingRequiredPrice
      );
    }
    if (capabilities.long_context || longContextThresholdTokens !== null) {
      if (longContextThresholdTokens === null) {
        throw new CatalogPricingFormError(messages.invalidThreshold);
      }
      for (const [label, value] of [
        ['input_long', inputLongMicroUsd],
        ['cached_input_long', cachedInputLongMicroUsd],
        ['cache_write_long', cacheWriteLongMicroUsd],
        ['output_long', outputLongMicroUsd],
      ] as const) {
        requirePrice(value, label, messages.missingRequiredPrice);
      }
    }
  } else if (!tiers.some((tier) => tier.skuKey === 'default')) {
    throw new CatalogPricingFormError(messages.invalidTiers);
  }

  return {
    billingScheme,
    inputMicroUsd,
    outputMicroUsd,
    cachedInputMicroUsd,
    cacheWriteMicroUsd,
    cacheWrite5mMicroUsd,
    cacheWrite1hMicroUsd,
    imageInputMicroUsd,
    cachedImageInputMicroUsd,
    imageOutputMicroUsd,
    webSearchMicroUsd,
    longContextThresholdTokens,
    inputLongMicroUsd,
    cachedInputLongMicroUsd,
    cacheWriteLongMicroUsd,
    outputLongMicroUsd,
    billingCapabilitiesJson: JSON.stringify(capabilities),
    sourceSupportedEndpointTypes: JSON.stringify(endpointTypes),
    tiers,
  };
}
