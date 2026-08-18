import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import {
  IMAGE_UAT_CASES,
  validateObjectStorageImageUrl,
} from '../../scripts/smoke-image';

test('图片 UAT 覆盖官方低质量 1K、高质量 2K、Codex 双图 2K 与图生图 4K', () => {
  assert.deepEqual(
    IMAGE_UAT_CASES.map(({ id, group, endpoint, resolution, n }) => ({
      id,
      group,
      endpoint,
      resolution,
      n,
    })),
    [
      {
        id: 'official-low-1k',
        group: 'official',
        endpoint: 'generations',
        resolution: '1k',
        n: 1,
      },
      {
        id: 'official-high-2k',
        group: 'official',
        endpoint: 'generations',
        resolution: '2k',
        n: 1,
      },
      {
        id: 'codex-multi-2k',
        group: 'codex-discount',
        endpoint: 'generations',
        resolution: '2k',
        n: 2,
      },
      {
        id: 'codex-edit-4k',
        group: 'codex-discount',
        endpoint: 'edits',
        resolution: '4k',
        n: 1,
      },
    ]
  );
});

test('图片 UAT 只接受未过期的 HTTPS 对象存储签名链接', () => {
  const now = Date.UTC(2026, 7, 18, 20, 0, 0);
  const signed =
    'https://example.r2.cloudflarestorage.com/private/result.png' +
    '?X-Amz-Date=20260818T195900Z&X-Amz-Expires=3600&X-Amz-Signature=abc';
  assert.equal(
    validateObjectStorageImageUrl(signed, now).hostname,
    'example.r2.cloudflarestorage.com'
  );
  assert.throws(
    () =>
      validateObjectStorageImageUrl(
        'https://api.apimart.ai/result.png?X-Amz-Signature=abc&X-Amz-Expires=3600',
        now
      ),
    /APIMart/
  );
  assert.throws(
    () => validateObjectStorageImageUrl('https://example.com/result.png', now),
    /signed URL/
  );
});

test('生产镜像内置但不会自动执行图片 UAT bundle', async () => {
  const dockerfile = await readFile(join(process.cwd(), 'Dockerfile'), 'utf8');
  assert.match(dockerfile, /smoke-image-runner\.ts/);
  assert.match(dockerfile, /smoke-image\.cjs/);
  assert.doesNotMatch(dockerfile, /CMD .*smoke-image/);
});
