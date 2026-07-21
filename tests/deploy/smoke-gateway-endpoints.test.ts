import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildLongContextSmokeInput,
  resolveGatewaySmokeEndpoints,
} from '../../scripts/smoke-gateway';

test('gateway smoke 只运行 OpenAI 模型元数据声明可承载的协议', () => {
  assert.deepEqual(
    resolveGatewaySmokeEndpoints(['openai', 'openai-response']),
    ['chat', 'messages', 'responses']
  );
});

test('gateway smoke 不为普通 OpenAI 文本模型假定 embeddings 能力', () => {
  assert.deepEqual(resolveGatewaySmokeEndpoints(['openai']), [
    'chat',
    'messages',
  ]);
  assert.deepEqual(resolveGatewaySmokeEndpoints(['openai-embedding']), [
    'embeddings',
  ]);
});

test('gateway smoke 支持 Anthropic messages 元数据并去重', () => {
  assert.deepEqual(resolveGatewaySmokeEndpoints(['anthropic', 'messages']), [
    'messages',
  ]);
});

test('gateway smoke 识别 images 端点并生成超过 272K 的长上下文载荷', () => {
  assert.deepEqual(resolveGatewaySmokeEndpoints(['image']), [
    'images_generations',
  ]);
  const input = buildLongContextSmokeInput(272_001);
  assert.equal(input.split(' ').length - 1, 272_001);
  assert.throws(() => buildLongContextSmokeInput(272_000), /exceed 272K/);
});
