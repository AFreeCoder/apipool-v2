import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ceilDiv,
  computePerCallChargeMicroUsd,
  computeTokenChargeMicroUsd,
  normalizeUsageMeters,
} from '@/features/gateway/lib/billing';

const PRICE = {
  input: 2_500_000,
  cached_input: 1_250_000,
  cache_write_5m: 3_125_000,
  cache_write_1h: 5_000_000,
  output: 10_000_000,
};

test('Chat：prompt_tokens 子集语义拆桶并输出 meter 向量', () => {
  const result = normalizeUsageMeters('chat_completions', {
    prompt_tokens: 1000,
    completion_tokens: 50,
    prompt_tokens_details: {
      cached_tokens: 600,
      cache_creation_tokens: 100,
    },
  });
  assert.deepEqual(result.meters, {
    input: 300,
    cached_input: 600,
    cache_write: 100,
    output: 50,
  });
  assert.equal(result.webSearchCount, 0);
  assert.deepEqual(result.flags, []);
});

test('Chat：识别 OpenAI 原生 cache_write_tokens，且不与兼容字段重复计数', () => {
  const { meters } = normalizeUsageMeters('chat_completions', {
    prompt_tokens: 1000,
    completion_tokens: 50,
    prompt_tokens_details: {
      cached_tokens: 600,
      cache_write_tokens: 350,
      cache_creation_tokens: 100,
    },
  });
  assert.deepEqual(meters, {
    input: 50,
    cached_input: 600,
    cache_write: 350,
    output: 50,
  });
});

test('Chat：cached 超过 prompt 时 uncached 钳到 0', () => {
  const { meters } = normalizeUsageMeters('chat_completions', {
    prompt_tokens: 100,
    completion_tokens: 1,
    prompt_tokens_details: { cached_tokens: 150 },
  });
  assert.equal(meters.input ?? 0, 0);
});

test('Responses：input_tokens_details 直映（16.2 实测字段）', () => {
  const { meters } = normalizeUsageMeters('responses', {
    input_tokens: 800,
    output_tokens: 120,
    input_tokens_details: { cached_tokens: 300, cache_write_tokens: 50 },
    output_tokens_details: { reasoning_tokens: 40 },
  });
  assert.deepEqual(meters, {
    input: 450,
    cached_input: 300,
    cache_write: 50,
    output: 120,
  });
});

test('Messages：Anthropic 互斥直映、input_tokens 不扣、5m/1h 分桶', () => {
  const { meters, flags } = normalizeUsageMeters('messages', {
    input_tokens: 200,
    output_tokens: 90,
    cache_read_input_tokens: 500,
    cache_creation: {
      ephemeral_5m_input_tokens: 60,
      ephemeral_1h_input_tokens: 30,
    },
    cache_creation_input_tokens: 90,
  });
  assert.deepEqual(meters, {
    input: 200,
    cached_input: 500,
    cache_write_5m: 60,
    cache_write_1h: 30,
    output: 90,
  });
  assert.deepEqual(flags, []);
});

test('Messages：无 cache_creation 明细时回退 cache_creation_input_tokens → 5m', () => {
  const { meters } = normalizeUsageMeters('messages', {
    input_tokens: 10,
    output_tokens: 5,
    cache_creation_input_tokens: 40,
  });
  assert.equal(meters.cache_write_5m, 40);
  assert.equal(meters.cache_write_1h ?? 0, 0);
});

test('Embeddings：仅 input', () => {
  const { meters } = normalizeUsageMeters('embeddings', {
    prompt_tokens: 512,
    total_tokens: 512,
  });
  assert.deepEqual(meters, { input: 512 });
});

test('Images：文本/图片输入与图片输出分 meter，缓存细分预留可照记', () => {
  const result = normalizeUsageMeters('images_generations', {
    input_tokens: 28,
    input_tokens_details: {
      text_tokens: 10,
      image_tokens: 18,
      cached_text_tokens: 3,
      cached_image_tokens: 5,
    },
    output_tokens: 20,
    total_tokens: 48,
  });
  assert.deepEqual(result.meters, {
    input: 7,
    image_input: 13,
    cached_input: 3,
    cached_image_input: 5,
    image_output: 20,
  });
  assert.deepEqual(result.flags, []);
});

test('Images：兼容 New API prompt_tokens_details 实际字段', () => {
  const result = normalizeUsageMeters('images_generations', {
    input_tokens: 1000,
    prompt_tokens: 1000,
    prompt_tokens_details: {
      cached_tokens: 0,
      text_tokens: 0,
      image_tokens: 1000,
    },
    output_tokens: 4000,
    completion_tokens: 4000,
    completion_tokens_details: { reasoning_tokens: 0 },
    total_tokens: 5000,
  });
  assert.deepEqual(result.meters, {
    image_input: 1000,
    image_output: 4000,
  });
  assert.deepEqual(result.flags, []);
});

test('非整数 token 不进入 BigInt 计费并留下异常标记', () => {
  const result = normalizeUsageMeters('responses', {
    input_tokens: 1.5,
    output_tokens: 2,
  });
  assert.deepEqual(result.meters, { output: 2 });
  assert.deepEqual(result.flags, ['invalid_numeric:input_tokens']);
});

test('未映射非零字段被上报（宁少勿错）', () => {
  const { flags } = normalizeUsageMeters('chat_completions', {
    prompt_tokens: 10,
    completion_tokens: 1,
    web_search_requests: 3,
  });
  assert.deepEqual(flags, ['unmapped:web_search_requests']);
});

test('Messages：聚合与细分不一致时按细分结算并打标记', () => {
  const result = normalizeUsageMeters('messages', {
    input_tokens: 100,
    output_tokens: 10,
    cache_creation_input_tokens: 10_000,
    cache_creation: { ephemeral_5m_input_tokens: 3000 },
  });
  assert.equal(result.meters.cache_write_5m, 3000);
  assert.equal(result.meters.cache_write_1h ?? 0, 0);
  assert.ok(result.flags.includes('cache_write_sum_mismatch'));
});

test('Messages：iterations 数组与 server_tool_use 不再静默逃逸', () => {
  const result = normalizeUsageMeters('messages', {
    input_tokens: 100,
    output_tokens: 10,
    iterations: [{ input_tokens: 50 }],
    server_tool_use: { web_search_requests: 3 },
  });
  assert.equal(result.webSearchCount, 3);
  assert.ok(result.flags.includes('unmapped_struct:iterations'));
});

test('长档：inputTotalTokens（含缓存）达阈值时全部键改写为 _long', () => {
  const result = normalizeUsageMeters(
    'responses',
    {
      input_tokens: 280_000,
      output_tokens: 10,
      input_tokens_details: { cached_tokens: 100_000, cache_write_tokens: 0 },
    },
    { longContextThresholdTokens: 272_000 }
  );
  assert.deepEqual(result.meters, {
    input_long: 180_000,
    cached_input_long: 100_000,
    output_long: 10,
  });
});

test('长档：无阈值参数时永不判长档', () => {
  const result = normalizeUsageMeters('responses', {
    input_tokens: 500_000,
    output_tokens: 1,
  });
  assert.deepEqual(result.meters, { input: 500_000, output: 1 });
});

test('金额：BigInt 全程、合计一次 ceil、不足 1 计 1', () => {
  assert.equal(ceilDiv(BigInt(1), BigInt(1_000_000)), BigInt(1));
  assert.equal(ceilDiv(BigInt(0), BigInt(1_000_000)), BigInt(0));
  assert.equal(ceilDiv(BigInt(1_000_001), BigInt(1_000_000)), BigInt(2));
  assert.equal(
    computeTokenChargeMicroUsd({ input: 1 }, PRICE, {
      webSearchCount: 0,
      webSearchPriceMicroUsd: null,
    }).charged,
    BigInt(3)
  );
  assert.equal(
    computeTokenChargeMicroUsd({}, PRICE, {
      webSearchCount: 0,
      webSearchPriceMicroUsd: null,
    }).charged,
    BigInt(1)
  );
  const big = computeTokenChargeMicroUsd(
    { input: 10_000_000 },
    { ...PRICE, input: 1_000_000_000 },
    { webSearchCount: 0, webSearchPriceMicroUsd: null }
  ).charged;
  assert.equal(big, BigInt(10_000_000_000));
});

test('连续小额逐笔和 = 逐笔 ceil 之和（不跨请求携余数）', () => {
  const one = computeTokenChargeMicroUsd({ input: 1 }, PRICE, {
    webSearchCount: 0,
    webSearchPriceMicroUsd: null,
  }).charged;
  let sum = BigInt(0);
  for (let index = 0; index < 10; index += 1) sum += one;
  assert.equal(sum, BigInt(30));
});

test('token 计费：按 rates map 求和、未定价键零计并回报', () => {
  const { charged, unpricedMeters } = computeTokenChargeMicroUsd(
    { input: 1000, output: 50, image_output: 999 },
    { input: 2_500_000, output: 10_000_000 },
    { webSearchCount: 0, webSearchPriceMicroUsd: null }
  );
  assert.equal(charged, BigInt(3000));
  assert.deepEqual(unpricedMeters, ['image_output']);
});

test('token 计费：web_search 附加费与 token 费同分母一次取整', () => {
  const { charged } = computeTokenChargeMicroUsd(
    { input: 1 },
    { input: 2_500_000 },
    { webSearchCount: 3, webSearchPriceMicroUsd: 10_000 }
  );
  assert.equal(charged, BigInt(30_003));
});

test('per_call：单价×实际张数，最低 1 micro-USD', () => {
  assert.equal(computePerCallChargeMicroUsd(2, 300_000), BigInt(600_000));
  assert.equal(computePerCallChargeMicroUsd(0, 300_000), BigInt(1));
});
