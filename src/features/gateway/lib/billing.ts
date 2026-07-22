import type { GatewayEndpointKey } from './endpoints';
import { toLongMeterKey, type MeterKey, type MeterQuantities } from './meters';

export function ceilDiv(a: bigint, b: bigint): bigint {
  return (a + b - BigInt(1)) / b;
}

const num = (value: unknown): number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : 0;

const obj = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : {};

const MAPPED_KEYS: Record<string, Set<string>> = {
  chat_completions: new Set([
    'prompt_tokens',
    'completion_tokens',
    'total_tokens',
    'prompt_tokens_details',
    'completion_tokens_details',
    'cache_creation_input_tokens',
    'server_tool_use',
  ]),
  responses: new Set([
    'input_tokens',
    'output_tokens',
    'total_tokens',
    'input_tokens_details',
    'output_tokens_details',
    'server_tool_use',
  ]),
  messages: new Set([
    'input_tokens',
    'output_tokens',
    'cache_read_input_tokens',
    'cache_creation_input_tokens',
    'cache_creation',
    'server_tool_use',
    'service_tier',
  ]),
  embeddings: new Set(['prompt_tokens', 'total_tokens']),
  images_generations: new Set([
    'input_tokens',
    'output_tokens',
    'total_tokens',
    'input_tokens_details',
    'prompt_tokens',
    'completion_tokens',
    'prompt_tokens_details',
    'completion_tokens_details',
  ]),
  images_edits: new Set([
    'input_tokens',
    'output_tokens',
    'total_tokens',
    'input_tokens_details',
    'prompt_tokens',
    'completion_tokens',
    'prompt_tokens_details',
    'completion_tokens_details',
  ]),
};

export type NormalizedUsage = {
  meters: MeterQuantities;
  webSearchCount: number;
  flags: string[];
};

function collectInvalidNumbers(
  value: unknown,
  path: string,
  flags: string[]
): void {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) {
      flags.push(`invalid_numeric:${path}`);
    }
    return;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  for (const [key, nested] of Object.entries(value)) {
    collectInvalidNumbers(nested, `${path}.${key}`, flags);
  }
}

function addMeter(
  meters: MeterQuantities,
  key: MeterKey,
  quantity: number
): void {
  if (quantity > 0) meters[key] = quantity;
}

function applyLongContextMeters(meters: MeterQuantities): MeterQuantities {
  const longMeters: MeterQuantities = {};
  for (const [key, quantity] of Object.entries(meters) as [
    MeterKey,
    number,
  ][]) {
    const longKey = toLongMeterKey(key);
    longMeters[longKey] = (longMeters[longKey] ?? 0) + quantity;
  }
  return longMeters;
}

export function normalizeUsageMeters(
  endpoint: GatewayEndpointKey,
  usage: Record<string, unknown>,
  opts?: { longContextThresholdTokens?: number | null }
): NormalizedUsage {
  let meters: MeterQuantities = {};
  const flags: string[] = [];
  const mapped = MAPPED_KEYS[endpoint] ?? new Set<string>();
  for (const key of mapped) {
    if (Object.hasOwn(usage, key)) {
      collectInvalidNumbers(usage[key], key, flags);
    }
  }

  switch (endpoint) {
    case 'chat_completions': {
      const details = obj(usage.prompt_tokens_details);
      const cachedInput = num(details.cached_tokens);
      const cacheWrite = Math.max(
        num(details.cache_write_tokens),
        num(details.cache_creation_tokens ?? usage.cache_creation_input_tokens)
      );
      addMeter(
        meters,
        'input',
        Math.max(0, num(usage.prompt_tokens) - cachedInput - cacheWrite)
      );
      addMeter(meters, 'cached_input', cachedInput);
      addMeter(meters, 'cache_write', cacheWrite);
      addMeter(meters, 'output', num(usage.completion_tokens));
      break;
    }
    case 'responses': {
      const inputDetails = obj(usage.input_tokens_details);
      const cachedInput = num(inputDetails.cached_tokens);
      const cacheWrite = num(inputDetails.cache_write_tokens);
      addMeter(
        meters,
        'input',
        Math.max(0, num(usage.input_tokens) - cachedInput - cacheWrite)
      );
      addMeter(meters, 'cached_input', cachedInput);
      addMeter(meters, 'cache_write', cacheWrite);
      addMeter(meters, 'output', num(usage.output_tokens));
      break;
    }
    case 'messages': {
      const creation = obj(usage.cache_creation);
      const has5m = creation.ephemeral_5m_input_tokens !== undefined;
      const has1h = creation.ephemeral_1h_input_tokens !== undefined;
      const aggregateCacheWrite = num(usage.cache_creation_input_tokens);
      const cacheWrite5m = has5m
        ? num(creation.ephemeral_5m_input_tokens)
        : aggregateCacheWrite;
      const cacheWrite1h = has1h ? num(creation.ephemeral_1h_input_tokens) : 0;

      addMeter(meters, 'input', num(usage.input_tokens));
      addMeter(meters, 'cached_input', num(usage.cache_read_input_tokens));
      addMeter(meters, 'cache_write_5m', cacheWrite5m);
      addMeter(meters, 'cache_write_1h', cacheWrite1h);
      addMeter(meters, 'output', num(usage.output_tokens));

      if (
        (has5m || has1h) &&
        usage.cache_creation_input_tokens !== undefined &&
        aggregateCacheWrite !== cacheWrite5m + cacheWrite1h
      ) {
        flags.push('cache_write_sum_mismatch');
      }
      break;
    }
    case 'embeddings':
      addMeter(meters, 'input', num(usage.prompt_tokens));
      break;
    case 'images_generations':
    case 'images_edits': {
      const details = obj(
        usage.input_tokens_details ?? usage.prompt_tokens_details
      );
      const cachedText = num(details.cached_text_tokens);
      const cachedImage = num(details.cached_image_tokens);
      addMeter(
        meters,
        'input',
        Math.max(0, num(details.text_tokens) - cachedText)
      );
      addMeter(
        meters,
        'image_input',
        Math.max(0, num(details.image_tokens) - cachedImage)
      );
      addMeter(meters, 'cached_input', cachedText);
      addMeter(meters, 'cached_image_input', cachedImage);
      addMeter(
        meters,
        'image_output',
        num(usage.output_tokens ?? usage.completion_tokens)
      );
      break;
    }
  }

  for (const [key, value] of Object.entries(usage)) {
    if (mapped.has(key)) continue;
    if (typeof value === 'number' && value !== 0) {
      flags.push(`unmapped:${key}`);
    } else if (value !== null && typeof value === 'object') {
      flags.push(`unmapped_struct:${key}`);
    }
  }

  const serverToolUse = obj(usage.server_tool_use);
  const webSearchCount = num(serverToolUse.web_search_requests);
  const threshold = opts?.longContextThresholdTokens;
  const inputTotalTokens =
    (meters.input ?? 0) +
    (meters.cached_input ?? 0) +
    (meters.cache_write ?? 0) +
    (meters.cache_write_5m ?? 0) +
    (meters.cache_write_1h ?? 0);
  if (
    typeof threshold === 'number' &&
    Number.isFinite(threshold) &&
    threshold >= 0 &&
    inputTotalTokens >= threshold
  ) {
    meters = applyLongContextMeters(meters);
  }

  return { meters, webSearchCount, flags };
}

const MICRO_PER_M = BigInt(1_000_000);

export type RatesMap = Partial<Record<MeterKey, number>>;

export function computeTokenChargeMicroUsd(
  meters: MeterQuantities,
  rates: RatesMap,
  tool: { webSearchCount: number; webSearchPriceMicroUsd: number | null }
): { charged: bigint; unpricedMeters: MeterKey[] } {
  let total = BigInt(0);
  const unpricedMeters: MeterKey[] = [];
  for (const [key, quantity] of Object.entries(meters) as [
    MeterKey,
    number,
  ][]) {
    if (!quantity) continue;
    const rate = rates[key];
    if (rate === undefined || rate === null) {
      unpricedMeters.push(key);
      continue;
    }
    total += BigInt(quantity) * BigInt(rate);
  }
  if (tool.webSearchCount > 0 && tool.webSearchPriceMicroUsd !== null) {
    total +=
      BigInt(tool.webSearchCount) *
      BigInt(tool.webSearchPriceMicroUsd) *
      MICRO_PER_M;
  }
  const charged = ceilDiv(total, MICRO_PER_M);
  return {
    charged: charged > BigInt(0) ? charged : BigInt(1),
    unpricedMeters,
  };
}

export function computePerCallChargeMicroUsd(
  unitCount: number,
  tierPriceMicroUsd: number
): bigint {
  const charged = BigInt(unitCount) * BigInt(tierPriceMicroUsd);
  return charged > BigInt(0) ? charged : BigInt(1);
}
