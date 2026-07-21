import type { GatewayEndpointKey } from './endpoints';
import {
  type MeterKey,
  type MeterQuantities,
  toLongMeterKey,
} from './meters';

export interface UsageBuckets {
  uncachedInput: number;
  cachedRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  output: number;
  reasoning: number;
}

/** @deprecated 由 T12 收尾统一删除。 */
export interface PriceVector {
  inputMicroUsdPerM: number;
  cachedInputMicroUsdPerM: number;
  cacheWrite5mMicroUsdPerM: number;
  cacheWrite1hMicroUsdPerM: number;
  outputMicroUsdPerM: number;
}

/** @deprecated 仅供 T6/T7/T12 切换完成前读取旧五桶消费者。 */
export function priceVectorFromRatesJson(ratesJson: string): PriceVector {
  let rates: Record<string, unknown>;
  try {
    const parsed = JSON.parse(ratesJson);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('价格 rates_json 必须是对象');
    }
    rates = parsed as Record<string, unknown>;
  } catch (error) {
    throw new Error('价格 rates_json 无法解析', { cause: error });
  }

  const readRate = (key: string) => {
    const value = rates[key];
    if (!Number.isSafeInteger(value) || Number(value) < 0) {
      throw new Error(`价格 rates_json 缺少有效 ${key}`);
    }
    return Number(value);
  };
  return {
    inputMicroUsdPerM: readRate('input'),
    cachedInputMicroUsdPerM: readRate('cached_input'),
    cacheWrite5mMicroUsdPerM: readRate('cache_write_5m'),
    cacheWrite1hMicroUsdPerM: readRate('cache_write_1h'),
    outputMicroUsdPerM: readRate('output'),
  };
}

export function ceilDiv(a: bigint, b: bigint): bigint {
  return (a + b - BigInt(1)) / b;
}

const num = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;

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
  ]),
  responses: new Set([
    'input_tokens',
    'output_tokens',
    'total_tokens',
    'input_tokens_details',
    'output_tokens_details',
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
};

export type NormalizedUsage = {
  meters: MeterQuantities;
  webSearchCount: number;
  flags: string[];
};

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
      const cacheWrite1h = has1h
        ? num(creation.ephemeral_1h_input_tokens)
        : 0;

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
  }

  const mapped = MAPPED_KEYS[endpoint] ?? new Set<string>();
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

export function normalizeUsage(
  endpoint: GatewayEndpointKey,
  usage: Record<string, unknown>
): { buckets: UsageBuckets; unmappedNonZero: string[] } {
  let buckets: UsageBuckets;
  switch (endpoint) {
    case 'chat_completions': {
      const details = obj(usage.prompt_tokens_details);
      const completionDetails = obj(usage.completion_tokens_details);
      const cachedRead = num(details.cached_tokens);
      const cacheWrite = Math.max(
        num(details.cache_write_tokens),
        num(details.cache_creation_tokens ?? usage.cache_creation_input_tokens)
      );
      buckets = {
        uncachedInput: Math.max(
          0,
          num(usage.prompt_tokens) - cachedRead - cacheWrite
        ),
        cachedRead,
        cacheWrite5m: cacheWrite,
        cacheWrite1h: 0,
        output: num(usage.completion_tokens),
        reasoning: num(completionDetails.reasoning_tokens),
      };
      break;
    }
    case 'responses': {
      const inputDetails = obj(usage.input_tokens_details);
      const outputDetails = obj(usage.output_tokens_details);
      const cachedRead = num(inputDetails.cached_tokens);
      const cacheWrite = num(inputDetails.cache_write_tokens);
      buckets = {
        uncachedInput: Math.max(
          0,
          num(usage.input_tokens) - cachedRead - cacheWrite
        ),
        cachedRead,
        cacheWrite5m: cacheWrite,
        cacheWrite1h: 0,
        output: num(usage.output_tokens),
        reasoning: num(outputDetails.reasoning_tokens),
      };
      break;
    }
    case 'messages': {
      const creation = obj(usage.cache_creation);
      const has5m = creation.ephemeral_5m_input_tokens !== undefined;
      const has1h = creation.ephemeral_1h_input_tokens !== undefined;
      buckets = {
        uncachedInput: num(usage.input_tokens),
        cachedRead: num(usage.cache_read_input_tokens),
        cacheWrite5m: has5m
          ? num(creation.ephemeral_5m_input_tokens)
          : num(usage.cache_creation_input_tokens),
        cacheWrite1h: has1h ? num(creation.ephemeral_1h_input_tokens) : 0,
        output: num(usage.output_tokens),
        reasoning: 0,
      };
      break;
    }
    case 'embeddings':
      buckets = {
        uncachedInput: num(usage.prompt_tokens),
        cachedRead: 0,
        cacheWrite5m: 0,
        cacheWrite1h: 0,
        output: 0,
        reasoning: 0,
      };
      break;
    default:
      buckets = {
        uncachedInput: 0,
        cachedRead: 0,
        cacheWrite5m: 0,
        cacheWrite1h: 0,
        output: 0,
        reasoning: 0,
      };
  }
  const mapped = MAPPED_KEYS[endpoint] ?? new Set<string>();
  const unmappedNonZero = Object.entries(usage)
    .filter(
      ([key, value]) =>
        !mapped.has(key) && typeof value === 'number' && value !== 0
    )
    .map(([key]) => key);
  return { buckets, unmappedNonZero };
}

export function normalizeBackfillUsage(log: {
  inputTokens: number;
  outputTokens: number;
  cacheTokens?: number;
  cacheCreationTokens?: number;
  cacheCreationTokens5m?: number;
  cacheCreationTokens1h?: number;
  usageSemantic?: string;
}): UsageBuckets {
  const cachedRead = num(log.cacheTokens);
  const cacheWrite5m = num(
    log.cacheCreationTokens5m ?? log.cacheCreationTokens
  );
  const cacheWrite1h = num(log.cacheCreationTokens1h);
  const anthropicSemantic = log.usageSemantic?.toLowerCase() === 'anthropic';
  return {
    uncachedInput: anthropicSemantic
      ? num(log.inputTokens)
      : Math.max(
          0,
          num(log.inputTokens) - cachedRead - cacheWrite5m - cacheWrite1h
        ),
    cachedRead,
    cacheWrite5m,
    cacheWrite1h,
    output: num(log.outputTokens),
    reasoning: 0,
  };
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

/** @deprecated 由 T12 收尾统一删除。 */
export function computeChargeMicroUsd(
  buckets: UsageBuckets,
  price: PriceVector
): bigint {
  const total =
    BigInt(buckets.uncachedInput) * BigInt(price.inputMicroUsdPerM) +
    BigInt(buckets.cachedRead) * BigInt(price.cachedInputMicroUsdPerM) +
    BigInt(buckets.cacheWrite5m) * BigInt(price.cacheWrite5mMicroUsdPerM) +
    BigInt(buckets.cacheWrite1h) * BigInt(price.cacheWrite1hMicroUsdPerM) +
    BigInt(buckets.output) * BigInt(price.outputMicroUsdPerM);
  const charged = ceilDiv(total, MICRO_PER_M);
  return charged > BigInt(0) ? charged : BigInt(1);
}
