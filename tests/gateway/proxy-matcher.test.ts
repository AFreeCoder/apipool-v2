import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

async function loadMatcher(): Promise<RegExp> {
  const source = await readFile(join(process.cwd(), 'src/proxy.ts'), 'utf8');
  const match = source.match(/matcher:\s*'([^']+)'/);
  assert.ok(match, 'proxy.ts 含 matcher 字符串');
  return new RegExp(`^${match[1]}$`);
}

test('matcher 不吞 /v1（网关路径不得进 intl middleware）', async () => {
  const matcher = await loadMatcher();
  assert.equal(matcher.test('/v1/chat/completions'), false);
  assert.equal(matcher.test('/v1/messages'), false);
  assert.equal(matcher.test('/v1/models'), false);
});

test('matcher 仍覆盖门户页面路径', async () => {
  const matcher = await loadMatcher();
  assert.equal(matcher.test('/dashboard'), true);
  assert.equal(matcher.test('/zh/models'), true);
  assert.equal(matcher.test('/api/apipool/keys'), false);
});
