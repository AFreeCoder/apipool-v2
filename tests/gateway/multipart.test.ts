import assert from 'node:assert/strict';
import test from 'node:test';
import { extractImageMultipartRequest } from '@/features/gateway/lib/multipart';

async function encodedForm(form: FormData) {
  const request = new Request('http://portal.test/v1/images/edits', {
    method: 'POST',
    body: form,
  });
  return {
    body: new Uint8Array(await request.arrayBuffer()),
    contentType: request.headers.get('content-type'),
  };
}

test('multipart 任意字段顺序：只提取白名单文本，忽略图片二进制正文', async () => {
  const form = new FormData();
  form.append('quality', 'high');
  form.append(
    'image',
    new Blob([new Uint8Array([0xff, 0x00, 0x80, 0x01])]),
    'source.bin'
  );
  form.append('prompt', '把背景改成纯白');
  form.append('n', '2');
  form.append('model', 'gpt-image-2');
  form.append('size', '1024x1024');
  const encoded = await encodedForm(form);

  const result = extractImageMultipartRequest(
    encoded.body,
    encoded.contentType
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.fields, {
    model: 'gpt-image-2',
    quality: 'high',
    size: '1024x1024',
    n: 2,
    promptBytes: new TextEncoder().encode('把背景改成纯白').byteLength,
  });
  assert.equal(result.admissionMetadata.hasServerTool, false);
  assert.equal(
    result.admissionMetadata.totalRequestChars,
    'high'.length +
      new TextEncoder().encode('把背景改成纯白').byteLength +
      '2'.length +
      'gpt-image-2'.length +
      '1024x1024'.length
  );
});

test('multipart 缺 model、重复白名单字段与超长 prompt 均 fail-closed', async () => {
  const missing = new FormData();
  missing.append('image', new Blob(['image']), 'source.png');
  const missingEncoded = await encodedForm(missing);
  assert.deepEqual(
    extractImageMultipartRequest(
      missingEncoded.body,
      missingEncoded.contentType
    ),
    { ok: false, reason: 'missing_model' }
  );

  const duplicate = new FormData();
  duplicate.append('model', 'first');
  duplicate.append('model', 'second');
  const duplicateEncoded = await encodedForm(duplicate);
  assert.deepEqual(
    extractImageMultipartRequest(
      duplicateEncoded.body,
      duplicateEncoded.contentType
    ),
    { ok: false, reason: 'malformed' }
  );

  const oversized = new FormData();
  oversized.append('model', 'gpt-image-2');
  oversized.append('prompt', 'x'.repeat(1024 * 1024 + 1));
  const oversizedEncoded = await encodedForm(oversized);
  assert.deepEqual(
    extractImageMultipartRequest(
      oversizedEncoded.body,
      oversizedEncoded.contentType
    ),
    { ok: false, reason: 'field_too_large' }
  );
});
