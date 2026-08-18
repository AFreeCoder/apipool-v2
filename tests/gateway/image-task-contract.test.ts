import assert from 'node:assert/strict';
import test from 'node:test';

import {
  flattenNewApiImageResult,
  parseNewApiTaskSnapshot,
  validateImageTokenUsage,
} from '@/features/gateway/lib/image-task-contract';

test('New API 图片任务结果按实际 URL 数量展开', () => {
  const parsed = parseNewApiTaskSnapshot({
    id: 'task-1',
    status: 'completed',
    result_expires_at: 2000,
    result: {
      images: [
        { url: ['https://r2.test/1', 'https://r2.test/2'], expires_at: 1900 },
      ],
    },
  });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  const flattened = flattenNewApiImageResult(parsed.snapshot);
  assert.equal(flattened.ok, true);
  if (!flattened.ok) return;
  assert.equal(flattened.outputCount, 2);
  assert.deepEqual(
    flattened.result.data.map((item) => item.url),
    ['https://r2.test/1', 'https://r2.test/2']
  );
});

test('官方图片 token usage 必须含可闭合的模态明细', () => {
  assert.equal(
    validateImageTokenUsage({
      input_tokens: 1500,
      input_tokens_details: {
        cached_tokens: 200,
        text_tokens: 1000,
        image_tokens: 500,
      },
      output_tokens: 2000,
      output_tokens_details: { image_tokens: 2000, text_tokens: 0 },
      total_tokens: 3500,
    }),
    true
  );
  assert.equal(
    validateImageTokenUsage({
      input_tokens: 1500,
      input_tokens_details: { text_tokens: 1000, image_tokens: 100 },
      output_tokens: 2000,
      output_tokens_details: { image_tokens: 2000 },
      total_tokens: 3500,
    }),
    false
  );
});
