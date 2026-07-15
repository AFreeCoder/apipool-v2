import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ceilDiv,
  computeChargeMicroUsd,
  normalizeBackfillUsage,
  normalizeUsage,
} from '@/features/gateway/lib/billing';

const PRICE = {
  inputMicroUsdPerM: 2_500_000,
  cachedInputMicroUsdPerM: 1_250_000,
  cacheWrite5mMicroUsdPerM: 3_125_000,
  cacheWrite1hMicroUsdPerM: 5_000_000,
  outputMicroUsdPerM: 10_000_000,
};

test('Chat：prompt_tokens 含 cached 子集必须扣除', () => {
  const { buckets, unmappedNonZero } = normalizeUsage('chat_completions', {
    prompt_tokens: 1000,
    completion_tokens: 50,
    prompt_tokens_details: {
      cached_tokens: 600,
      cache_creation_tokens: 100,
    },
  });
  assert.deepEqual(buckets, {
    uncachedInput: 400,
    cachedRead: 600,
    cacheWrite5m: 100,
    cacheWrite1h: 0,
    output: 50,
    reasoning: 0,
  });
  assert.deepEqual(unmappedNonZero, []);
});

test('Chat：cached 超过 prompt 时 uncached 钳到 0', () => {
  const { buckets } = normalizeUsage('chat_completions', {
    prompt_tokens: 100,
    completion_tokens: 1,
    prompt_tokens_details: { cached_tokens: 150 },
  });
  assert.equal(buckets.uncachedInput, 0);
});

test('Responses：input_tokens_details 直映（16.2 实测字段）', () => {
  const { buckets } = normalizeUsage('responses', {
    input_tokens: 800,
    output_tokens: 120,
    input_tokens_details: { cached_tokens: 300, cache_write_tokens: 50 },
    output_tokens_details: { reasoning_tokens: 40 },
  });
  assert.deepEqual(buckets, {
    uncachedInput: 500,
    cachedRead: 300,
    cacheWrite5m: 50,
    cacheWrite1h: 0,
    output: 120,
    reasoning: 40,
  });
});

test('Messages：Anthropic 互斥直映、input_tokens 不扣、5m/1h 分桶', () => {
  const { buckets } = normalizeUsage('messages', {
    input_tokens: 200,
    output_tokens: 90,
    cache_read_input_tokens: 500,
    cache_creation: {
      ephemeral_5m_input_tokens: 60,
      ephemeral_1h_input_tokens: 30,
    },
    cache_creation_input_tokens: 90,
  });
  assert.deepEqual(buckets, {
    uncachedInput: 200,
    cachedRead: 500,
    cacheWrite5m: 60,
    cacheWrite1h: 30,
    output: 90,
    reasoning: 0,
  });
});

test('Messages：无 cache_creation 明细时回退 cache_creation_input_tokens → 5m', () => {
  const { buckets } = normalizeUsage('messages', {
    input_tokens: 10,
    output_tokens: 5,
    cache_creation_input_tokens: 40,
  });
  assert.equal(buckets.cacheWrite5m, 40);
  assert.equal(buckets.cacheWrite1h, 0);
});

test('Embeddings：仅 uncached_input', () => {
  const { buckets } = normalizeUsage('embeddings', {
    prompt_tokens: 512,
    total_tokens: 512,
  });
  assert.deepEqual(buckets, {
    uncachedInput: 512,
    cachedRead: 0,
    cacheWrite5m: 0,
    cacheWrite1h: 0,
    output: 0,
    reasoning: 0,
  });
});

test('未映射非零字段被上报（宁少勿错）', () => {
  const { unmappedNonZero } = normalizeUsage('chat_completions', {
    prompt_tokens: 10,
    completion_tokens: 1,
    web_search_requests: 3,
  });
  assert.deepEqual(unmappedNonZero, ['web_search_requests']);
});

test('金额：BigInt 全程、合计一次 ceil、不足 1 计 1', () => {
  assert.equal(ceilDiv(BigInt(1), BigInt(1_000_000)), BigInt(1));
  assert.equal(ceilDiv(BigInt(0), BigInt(1_000_000)), BigInt(0));
  assert.equal(ceilDiv(BigInt(1_000_001), BigInt(1_000_000)), BigInt(2));
  assert.equal(
    computeChargeMicroUsd(
      {
        uncachedInput: 1,
        cachedRead: 0,
        cacheWrite5m: 0,
        cacheWrite1h: 0,
        output: 0,
        reasoning: 0,
      },
      PRICE
    ),
    BigInt(3)
  );
  assert.equal(
    computeChargeMicroUsd(
      {
        uncachedInput: 0,
        cachedRead: 0,
        cacheWrite5m: 0,
        cacheWrite1h: 0,
        output: 0,
        reasoning: 0,
      },
      PRICE
    ),
    BigInt(1)
  );
  const big = computeChargeMicroUsd(
    {
      uncachedInput: 10_000_000,
      cachedRead: 0,
      cacheWrite5m: 0,
      cacheWrite1h: 0,
      output: 0,
      reasoning: 0,
    },
    { ...PRICE, inputMicroUsdPerM: 1_000_000_000 }
  );
  assert.equal(big, BigInt(10_000_000_000));
});

test('连续小额逐笔和 = 逐笔 ceil 之和（不跨请求携余数）', () => {
  const one = computeChargeMicroUsd(
    {
      uncachedInput: 1,
      cachedRead: 0,
      cacheWrite5m: 0,
      cacheWrite1h: 0,
      output: 0,
      reasoning: 0,
    },
    PRICE
  );
  let sum = BigInt(0);
  for (let index = 0; index < 10; index += 1) sum += one;
  assert.equal(sum, BigInt(30));
});

test('日志回填口径：cache 明细缺失时降级两桶', () => {
  assert.deepEqual(
    normalizeBackfillUsage({ inputTokens: 100, outputTokens: 20 }),
    {
      uncachedInput: 100,
      cachedRead: 0,
      cacheWrite5m: 0,
      cacheWrite1h: 0,
      output: 20,
      reasoning: 0,
    }
  );
  assert.deepEqual(
    normalizeBackfillUsage({
      inputTokens: 100,
      outputTokens: 20,
      cacheTokens: 30,
      cacheCreationTokens5m: 5,
      cacheCreationTokens1h: 2,
    }),
    {
      uncachedInput: 70,
      cachedRead: 30,
      cacheWrite5m: 5,
      cacheWrite1h: 2,
      output: 20,
      reasoning: 0,
    }
  );
});
