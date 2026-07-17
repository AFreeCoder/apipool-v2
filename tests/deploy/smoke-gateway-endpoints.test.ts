import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveGatewaySmokeEndpoints } from '../../scripts/smoke-gateway';

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
  assert.deepEqual(
    resolveGatewaySmokeEndpoints(['anthropic', 'messages']),
    ['messages']
  );
});
