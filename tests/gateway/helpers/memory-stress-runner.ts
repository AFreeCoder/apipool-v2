import assert from 'node:assert/strict';

import { extractTopLevelModel } from '@/features/gateway/lib/sse-parser';
import { readBodyBounded } from '@/features/gateway/server/handler';

const MB = 1024 * 1024;
const BODY_SIZE = 25 * MB;

function singleModelBody(model: string): Uint8Array {
  const prefix = Buffer.from(`{"model":"${model}","input":"`);
  const suffix = Buffer.from('"}');
  const body = Buffer.allocUnsafe(BODY_SIZE);
  prefix.copy(body, 0);
  body.fill(0x78, prefix.length, BODY_SIZE - suffix.length);
  suffix.copy(body, BODY_SIZE - suffix.length);
  return body;
}

function repeatedModelBody(): Uint8Array {
  const prefix = Buffer.from('{');
  const pattern = Buffer.from('"model":"x",');
  const suffix = Buffer.from('"tail":true}');
  const body = Buffer.allocUnsafe(BODY_SIZE);
  prefix.copy(body, 0);
  let offset = prefix.length;
  while (offset + pattern.length + suffix.length <= BODY_SIZE) {
    pattern.copy(body, offset);
    offset += pattern.length;
  }
  body.fill(0x20, offset, BODY_SIZE - suffix.length);
  suffix.copy(body, BODY_SIZE - suffix.length);
  return body;
}

async function runParserStress() {
  const singleBodies = Array.from({ length: 3 }, (_, index) =>
    singleModelBody(`giant-${index}`)
  );
  const singleResults = await Promise.all(
    singleBodies.map(async (body) => extractTopLevelModel(body))
  );
  for (const [index, result] of singleResults.entries()) {
    assert.deepEqual(result, { ok: true, model: `giant-${index}` });
  }

  const repeatedBodies = Array.from({ length: 3 }, () => repeatedModelBody());
  const repeatedResults = await Promise.all(
    repeatedBodies.map(async (body) => extractTopLevelModel(body))
  );
  for (const result of repeatedResults) {
    assert.deepEqual(result, { ok: false, reason: 'ambiguous' });
  }

  process.stdout.write(
    `${JSON.stringify({ mode: 'parser', bodies: 6, bodySize: BODY_SIZE })}\n`
  );
}

async function waitUntil(predicate: () => boolean, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('内存压力同步屏障超时');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

async function runBodyStress(withContentLength: boolean) {
  globalThis.gc?.();
  const before = process.memoryUsage();
  const count = 16;
  let entered = 0;
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });

  const reads = Array.from({ length: count }, () => {
    let blocked = false;
    let sent = 0;
    const chunk = new Uint8Array(256 * 1024);
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (!blocked) {
          blocked = true;
          entered += 1;
          await barrier;
        }
        if (sent >= BODY_SIZE) {
          controller.close();
          return;
        }
        const length = Math.min(256 * 1024, BODY_SIZE - sent);
        sent += length;
        controller.enqueue(
          length === chunk.byteLength ? chunk : chunk.subarray(0, length)
        );
      },
    });
    const request = new Request('http://portal.test/v1/chat/completions', {
      method: 'POST',
      headers: withContentLength
        ? { 'content-length': String(BODY_SIZE) }
        : undefined,
      body,
      duplex: 'half',
    } as RequestInit);
    return readBodyBounded(request, BODY_SIZE, {
      idleMs: 30_000,
      totalMs: 60_000,
      signal: new AbortController().signal,
    });
  });

  await waitUntil(() => entered === count);
  const resident = process.memoryUsage();
  const residentExternalDelta = resident.external - before.external;
  assert.ok(
    residentExternalDelta >= 350 * MB,
    `同步屏障未形成 16×25MB 常驻：external Δ=${residentExternalDelta}`
  );
  assert.ok(
    residentExternalDelta < 600 * MB,
    `同步屏障 external 超限：Δ=${residentExternalDelta}`
  );

  release();
  const results = await Promise.all(reads);
  assert.equal(
    results.every((result) => result.ok),
    true
  );
  for (const result of results) {
    if (result.ok) assert.equal(result.body.byteLength, BODY_SIZE);
  }

  globalThis.gc?.();
  const after = process.memoryUsage();
  const externalDelta = after.external - before.external;
  const heapDelta = after.heapUsed - before.heapUsed;
  const rssDelta = after.rss - before.rss;
  assert.ok(externalDelta < 600 * MB, `external Δ 超限：${externalDelta}`);
  assert.ok(heapDelta < 128 * MB, `heapUsed Δ 超限：${heapDelta}`);
  assert.ok(rssDelta < 750 * MB, `rss Δ 超限：${rssDelta}`);

  process.stdout.write(
    `${JSON.stringify({
      mode: withContentLength ? 'content-length' : 'chunked',
      count,
      bodySize: BODY_SIZE,
      residentExternalDelta,
      externalDelta,
      heapDelta,
      rssDelta,
    })}\n`
  );
}

async function main() {
  const mode = process.argv[2];
  if (mode === 'parser') {
    await runParserStress();
  } else if (mode === 'content-length') {
    await runBodyStress(true);
  } else if (mode === 'chunked') {
    await runBodyStress(false);
  } else {
    throw new Error(`未知内存压力模式：${mode ?? '<missing>'}`);
  }
}

void main();
