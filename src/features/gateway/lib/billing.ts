import type { GatewayEndpointKey } from './endpoints';

export interface UsageBuckets {
  uncachedInput: number;
  cachedRead: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  output: number;
  reasoning: number;
}

export interface PriceVector {
  inputMicroUsdPerM: number;
  cachedInputMicroUsdPerM: number;
  cacheWrite5mMicroUsdPerM: number;
  cacheWrite1hMicroUsdPerM: number;
  outputMicroUsdPerM: number;
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
      buckets = {
        uncachedInput: Math.max(0, num(usage.prompt_tokens) - cachedRead),
        cachedRead,
        cacheWrite5m: num(
          details.cache_creation_tokens ?? usage.cache_creation_input_tokens
        ),
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
      buckets = {
        uncachedInput: Math.max(0, num(usage.input_tokens) - cachedRead),
        cachedRead,
        cacheWrite5m: num(inputDetails.cache_write_tokens),
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
}): UsageBuckets {
  const cachedRead = num(log.cacheTokens);
  const cacheWrite5m = num(
    log.cacheCreationTokens5m ?? log.cacheCreationTokens
  );
  const cacheWrite1h = num(log.cacheCreationTokens1h);
  return {
    uncachedInput: Math.max(0, num(log.inputTokens) - cachedRead),
    cachedRead,
    cacheWrite5m,
    cacheWrite1h,
    output: num(log.outputTokens),
    reasoning: 0,
  };
}

const MICRO_PER_M = BigInt(1_000_000);

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
