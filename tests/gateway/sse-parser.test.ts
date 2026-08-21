import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import {
  createUsageExtractor,
  extractTopLevelImageCount,
  extractTopLevelModel,
  extractTopLevelStream,
} from '@/features/gateway/lib/sse-parser';

const enc = new TextEncoder();

test('extractTopLevelModel：只取顶层 model、恰好一个', () => {
  assert.deepEqual(
    extractTopLevelModel(enc.encode('{"model":"gpt-5.4","messages":[]}')),
    { ok: true, model: 'gpt-5.4' }
  );
  assert.deepEqual(
    extractTopLevelModel(
      enc.encode('{"messages":[{"model":"fake"}],"model":"real"}')
    ),
    { ok: true, model: 'real' }
  );
  assert.deepEqual(
    extractTopLevelModel(
      enc.encode('{"input":"say \\"model\\": x","model":"m1"}')
    ),
    { ok: true, model: 'm1' }
  );
  assert.deepEqual(
    extractTopLevelModel(enc.encode('{"messages":[{"model":"nested-only"}]}')),
    { ok: false, reason: 'missing' }
  );
  assert.equal(extractTopLevelModel(enc.encode('not json')).ok, false);
});

test('重复 model 键拒绝（评审 R6-F1：上游后值覆盖会造成计费/执行分叉）', () => {
  assert.deepEqual(
    extractTopLevelModel(
      enc.encode('{"model":"cheap","messages":[],"model":"expensive"}')
    ),
    { ok: false, reason: 'ambiguous' }
  );
});

test('Unicode 转义键规范解码', () => {
  assert.deepEqual(extractTopLevelModel(enc.encode('{"\\u006dodel":"m1"}')), {
    ok: true,
    model: 'm1',
  });
  assert.deepEqual(
    extractTopLevelModel(
      enc.encode('{"model":"cheap","\\u006dodel":"expensive"}')
    ),
    { ok: false, reason: 'ambiguous' }
  );
});

test('extractTopLevelStream：只读取顶层布尔值并拒绝重复/错误类型', () => {
  assert.deepEqual(
    extractTopLevelStream(
      enc.encode('{"model":"m1","stream":true,"metadata":{"stream":false}}')
    ),
    { ok: true, isStream: true }
  );
  assert.deepEqual(
    extractTopLevelStream(enc.encode('{"model":"m1","\\u0073tream":false}')),
    { ok: true, isStream: false }
  );
  assert.deepEqual(extractTopLevelStream(enc.encode('{"model":"m1"}')), {
    ok: false,
    reason: 'missing',
  });
  assert.deepEqual(
    extractTopLevelStream(
      enc.encode('{"model":"m1","stream":true,"stream":false}')
    ),
    { ok: false, reason: 'ambiguous' }
  );
  assert.deepEqual(
    extractTopLevelStream(enc.encode('{"model":"m1","stream":"true"}')),
    { ok: false, reason: 'malformed' }
  );
});

test('extractTopLevelImageCount：只读取顶层正整数并拒绝歧义值', () => {
  assert.deepEqual(
    extractTopLevelImageCount(enc.encode('{"model":"m1","n":2}')),
    { ok: true, count: 2 }
  );
  assert.deepEqual(
    extractTopLevelImageCount(enc.encode('{"metadata":{"n":4}}')),
    { ok: false, reason: 'missing' }
  );
  assert.deepEqual(extractTopLevelImageCount(enc.encode('{"n":1,"n":2}')), {
    ok: false,
    reason: 'ambiguous',
  });
  for (const value of ['0', '-1', '1.5', '"2"', '2 true']) {
    assert.deepEqual(extractTopLevelImageCount(enc.encode(`{"n":${value}}`)), {
      ok: false,
      reason: 'malformed',
    });
  }
});

test('全量扫描：model 在大 body 尾部仍可达', () => {
  const huge = `{"padding":"${'x'.repeat(500_000)}","model":"late"}`;
  assert.deepEqual(extractTopLevelModel(enc.encode(huge)), {
    ok: true,
    model: 'late',
  });
});

test('Chat 流式：末尾 chunk usage 提取即 complete，畸形行不抛', () => {
  const extractor = createUsageExtractor('chat_completions', true, 1 << 20);
  extractor.push(
    enc.encode('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n')
  );
  extractor.push(enc.encode('data: {broken json\n\n'));
  extractor.push(
    enc.encode(
      'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":2}}\n\n'
    )
  );
  extractor.push(enc.encode('data: [DONE]\n\n'));
  const { usage, complete } = extractor.finish();
  assert.equal(usage?.prompt_tokens, 10);
  assert.equal(complete, true);
});

test('Messages 流式：start+delta 合并且 complete=true', () => {
  const extractor = createUsageExtractor('messages', true, 1 << 20);
  extractor.push(
    enc.encode(
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":25,"cache_read_input_tokens":100,"output_tokens":1}}}\n\n'
    )
  );
  extractor.push(
    enc.encode(
      'event: content_block_delta\ndata: {"type":"content_block_delta"}\n\n'
    )
  );
  extractor.push(
    enc.encode(
      'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":77}}\n\n'
    )
  );
  const { usage, complete } = extractor.finish();
  assert.equal(usage?.input_tokens, 25);
  assert.equal(usage?.cache_read_input_tokens, 100);
  assert.equal(usage?.output_tokens, 77);
  assert.equal(complete, true);
});

test('Messages 仅 message_start → usage 非空但 complete=false', () => {
  const extractor = createUsageExtractor('messages', true, 1 << 20);
  extractor.push(
    enc.encode(
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":25,"output_tokens":1}}}\n\n'
    )
  );
  const { usage, complete } = extractor.finish();
  assert.equal(usage?.input_tokens, 25);
  assert.equal(complete, false);
});

test('Responses 流式：response.completed 事件内 usage → complete=true', () => {
  const extractor = createUsageExtractor('responses', true, 1 << 20);
  extractor.push(
    enc.encode(
      'event: response.completed\ndata: {"type":"response.completed","response":{"usage":{"input_tokens":5,"output_tokens":9}}}\n\n'
    )
  );
  const done = extractor.finish();
  assert.equal(done.usage?.input_tokens, 5);
  assert.equal(done.complete, true);
});

test('非流式：定位根级 usage 子树，提取成功即 complete', () => {
  const extractor = createUsageExtractor('chat_completions', false, 1 << 20);
  extractor.push(
    enc.encode('{"id":"cmpl","choices":[{"message":{"content":"hello"}}],')
  );
  extractor.push(
    enc.encode(
      '"usage":{"prompt_tokens":3,"completion_tokens":7,"prompt_tokens_details":{"cached_tokens":1}}}'
    )
  );
  const { usage, complete } = extractor.finish();
  assert.equal(usage?.prompt_tokens, 3);
  assert.deepEqual(usage?.prompt_tokens_details, { cached_tokens: 1 });
  assert.equal(complete, true);
});

test('非流式 usage 伪造防御：深处假 usage 不被采信', () => {
  const extractor = createUsageExtractor('messages', false, 1 << 20);
  extractor.push(
    enc.encode(
      '{"content":[{"type":"tool_use","input":{"usage":{"input_tokens":1,"output_tokens":1}}}],'
    )
  );
  extractor.push(
    enc.encode('"usage":{"input_tokens":9000,"output_tokens":8000}}')
  );
  const { usage, complete } = extractor.finish();
  assert.equal(usage?.input_tokens, 9000);
  assert.equal(complete, true);
});

test('非流式仅深处 usage（无根级）→ complete=false 转回填', () => {
  const extractor = createUsageExtractor('messages', false, 1 << 20);
  extractor.push(
    enc.encode(
      '{"content":[{"type":"tool_use","input":{"usage":{"input_tokens":1,"output_tokens":1}}}]}'
    )
  );
  assert.deepEqual(extractor.finish(), { usage: null, complete: false });
});

test('非流式无 usage 仍可独立提取顶层 data 实际数量', () => {
  const extractor = createUsageExtractor('responses', false, 1 << 20);
  extractor.push(
    enc.encode(
      '{"data":[{"url":"https://example.test/a"},{"url":"https://example.test/b"}]}'
    )
  );
  assert.deepEqual(extractor.finish(), {
    usage: null,
    complete: false,
    unitCount: 2,
  });
});

test('Images URL fixture：提取 usage、实际张数与 URL 形态', async () => {
  const fixture = await readFile(
    join(process.cwd(), 'tests/fixtures/newapi/images-generations-runapi.json')
  );
  const extractor = createUsageExtractor('images_generations', false, 1 << 20);
  extractor.push(fixture);
  const result = extractor.finish();
  assert.equal(result.complete, true);
  assert.equal(result.unitCount, 1);
  assert.equal(result.allDataItemsHaveUrl, true);
  assert.equal(result.usage?.output_tokens, 1000);
});

test('Images b64_json 跨 chunk 跳过正文，响应大于解析窗仍可结算', () => {
  const extractor = createUsageExtractor('images_edits', false, 256);
  extractor.push(enc.encode('{"data":[{"b64_json":"'));
  extractor.push(enc.encode('A'.repeat(10_000)));
  extractor.push(
    enc.encode(
      '"}],"usage":{"input_tokens":2,"input_tokens_details":{"text_tokens":1,"image_tokens":1},"output_tokens":3}}'
    )
  );
  const result = extractor.finish();
  assert.equal(extractor.overflowed, false);
  assert.equal(result.complete, true);
  assert.equal(result.unitCount, 1);
  assert.equal(result.allDataItemsHaveUrl, false);
  assert.equal(result.usage?.output_tokens, 3);
});

test('Images 长签名 URL 不受元数据字符串长度上限影响', () => {
  const extractor = createUsageExtractor('images_generations', false, 1 << 20);
  const longUrl = `https://example.com/image?signature=${'a'.repeat(4096)}`;
  extractor.push(enc.encode(JSON.stringify({ data: [{ url: longUrl }] })));
  const result = extractor.finish();
  assert.equal(result.complete, false);
  assert.equal(result.unitCount, 1);
  assert.equal(result.allDataItemsHaveUrl, true);
});

test('字节级扫描内存有界：25MB body（大量短串）提取 model 正确', () => {
  const big = `{"model":"gpt-5.4","messages":[${'{"role":"user","content":"x"},'.repeat(400_000)}{"role":"user","content":"end"}]}`;
  assert.deepEqual(extractTopLevelModel(enc.encode(big)), {
    ok: true,
    model: 'gpt-5.4',
  });
});

test('零分配跳过大字符串：单个约 25MB content 串不物化', () => {
  const huge = `{"model":"gpt-5.4","input":"${'y'.repeat(25 * 1024 * 1024)}"}`;
  assert.deepEqual(extractTopLevelModel(enc.encode(huge)), {
    ok: true,
    model: 'gpt-5.4',
  });
});

test('model 值超 512B → malformed', () => {
  const longValue = `{"model":"${'m'.repeat(600)}"}`;
  assert.deepEqual(extractTopLevelModel(enc.encode(longValue)), {
    ok: false,
    reason: 'malformed',
  });
});

test('海量重复顶层 model 键遇第二个即 ambiguous', () => {
  const flood = `{${'"model":"x",'.repeat(2_000_000)}"end":1}`;
  assert.deepEqual(extractTopLevelModel(enc.encode(flood)), {
    ok: false,
    reason: 'ambiguous',
  });
});

test('跨 chunk 切割的 usage 行仍可提取', () => {
  const extractor = createUsageExtractor('chat_completions', true, 1 << 20);
  extractor.push(enc.encode('data: {"usage":{"prompt_'));
  extractor.push(enc.encode('tokens":42,"completion_tokens":1}}\n\n'));
  assert.equal(extractor.finish().usage?.prompt_tokens, 42);
});

test('超出扫描窗口 → overflowed 且 finish 不返回 usage', () => {
  const extractor = createUsageExtractor('chat_completions', true, 64);
  extractor.push(
    enc.encode(
      `data: {"choices":[{"delta":{"content":"${'y'.repeat(200)}"}}]}\n\n`
    )
  );
  extractor.push(
    enc.encode('data: {"usage":{"prompt_tokens":1,"completion_tokens":1}}\n\n')
  );
  assert.equal(extractor.overflowed, true);
  assert.deepEqual(extractor.finish(), { usage: null, complete: false });
});
