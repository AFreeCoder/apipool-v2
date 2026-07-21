import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveEndpoint } from '@/features/gateway/lib/endpoints';
import { gatewayErrorResponse } from '@/features/gateway/lib/errors';

test('端点白名单：文本、images 与 models 七端点命中，其余 null', () => {
  assert.equal(
    resolveEndpoint('POST', ['chat', 'completions'])?.key,
    'chat_completions'
  );
  assert.equal(resolveEndpoint('POST', ['responses'])?.key, 'responses');
  assert.equal(resolveEndpoint('POST', ['messages'])?.protocol, 'anthropic');
  assert.equal(resolveEndpoint('POST', ['embeddings'])?.key, 'embeddings');
  assert.equal(
    resolveEndpoint('POST', ['images', 'generations'])?.requestFormat,
    'json'
  );
  assert.equal(
    resolveEndpoint('POST', ['images', 'edits'])?.requestFormat,
    'multipart'
  );
  assert.equal(
    resolveEndpoint('POST', ['images', 'edits'])?.timeoutProfile,
    'images'
  );
  assert.equal(resolveEndpoint('GET', ['models'])?.billable, false);
  assert.equal(resolveEndpoint('GET', ['chat', 'completions']), null);
  assert.equal(resolveEndpoint('POST', ['completions']), null);
  assert.equal(resolveEndpoint('POST', ['audio', 'speech']), null);
});

test('OpenAI 协议错误体含 request_id 且带 no-store', async () => {
  const response = gatewayErrorResponse('openai', 'insufficient_quota', {
    status: 429,
    portalRequestId: 'preq_1',
  });
  assert.equal(response.status, 429);
  assert.equal(response.headers.get('x-apipool-request-id'), 'preq_1');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const body = await response.json();
  assert.equal(body.error.code, 'insufficient_quota');
  assert.equal(body.error.request_id, 'preq_1');
});

test('Anthropic 协议错误体形态 + Retry-After', async () => {
  const response = gatewayErrorResponse(
    'anthropic',
    'concurrency_limit_exceeded',
    {
      status: 429,
      portalRequestId: 'preq_2',
      retryAfterSeconds: 5,
    }
  );
  assert.equal(response.headers.get('retry-after'), '5');
  const body = await response.json();
  assert.equal(body.type, 'error');
  assert.equal(body.error.type, 'concurrency_limit_exceeded');
  assert.equal(body.request_id, 'preq_2');
});

test('错误文案不泄漏内部信息', async () => {
  const response = gatewayErrorResponse('openai', 'model_not_found', {
    status: 404,
    portalRequestId: 'preq_3',
  });
  const text = JSON.stringify(await response.json()).toLowerCase();
  for (const banned of ['newapi', 'new-api', 'oneapi', 'upstream_host']) {
    assert.ok(!text.includes(banned), `不含 ${banned}`);
  }
});
