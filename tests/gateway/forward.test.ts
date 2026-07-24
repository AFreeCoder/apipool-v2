import assert from 'node:assert/strict';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import test from 'node:test';

import { GATEWAY_ENDPOINTS } from '@/features/gateway/lib/endpoints';

const endpoint = GATEWAY_ENDPOINTS.find(
  (item) => item.key === 'chat_completions'
)!;
const imageEndpoint = GATEWAY_ENDPOINTS.find(
  (item) => item.key === 'images_generations'
)!;

async function listen(
  handler: (request: IncomingMessage, response: ServerResponse) => void
) {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function loadForward() {
  return import('@/features/gateway/server/forward');
}

function input(controller = new AbortController()) {
  return {
    endpoint,
    rawBody: new TextEncoder().encode('{"model":"portal-model"}'),
    headers: new Headers({
      'content-type': 'application/json',
      'x-test': 'ok',
    }),
    isStream: false,
    clientSignal: controller.signal,
  };
}

test.afterEach(() => {
  delete process.env.NEWAPI_BASE_URL;
  delete process.env.GATEWAY_FIRST_BYTE_TIMEOUT_MS;
});

test('正常转发 method/path/body 原样并捕获 X-Oneapi-Request-Id', async () => {
  let received: any;
  const upstream = await listen(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    received = {
      method: request.method,
      path: request.url,
      body: Buffer.concat(chunks).toString('utf8'),
      header: request.headers['x-test'],
    };
    response.setHeader('x-oneapi-request-id', 'rid-1');
    response.end('ok');
  });
  process.env.NEWAPI_BASE_URL = upstream.baseUrl;
  const forward = await loadForward();

  const result = await forward.forwardToUpstream(input());

  assert.equal(result.kind, 'responded');
  assert.equal(result.newapiRequestId, 'rid-1');
  assert.deepEqual(received, {
    method: 'POST',
    path: '/v1/chat/completions',
    body: '{"model":"portal-model"}',
    header: 'ok',
  });
  await upstream.close();
});

test('连接拒绝分类为 no_response stage=connect', async () => {
  const temporary = await listen((_request, response) => response.end());
  const port = new URL(temporary.baseUrl).port;
  await temporary.close();
  process.env.NEWAPI_BASE_URL = `http://127.0.0.1:${port}`;
  const forward = await loadForward();

  const result = await forward.forwardToUpstream(input());

  assert.equal(result.kind, 'no_response');
  assert.equal(result.stage, 'connect');
});

test('首包超时分类为 no_response stage=sent', async () => {
  const upstream = await listen((_request, response) => {
    setTimeout(() => response.end('late'), 300);
  });
  process.env.NEWAPI_BASE_URL = upstream.baseUrl;
  process.env.GATEWAY_FIRST_BYTE_TIMEOUT_MS = '100';
  const forward = await loadForward();

  const result = await forward.forwardToUpstream(input());

  assert.equal(result.kind, 'no_response');
  assert.equal(result.stage, 'sent');
  await upstream.close();
});

test('images 端点使用至少 180 秒的独立首包预算，不受文本 120 秒预算截断', async () => {
  const upstream = await listen((_request, response) => {
    setTimeout(() => response.end('image'), 300);
  });
  process.env.NEWAPI_BASE_URL = upstream.baseUrl;
  process.env.GATEWAY_FIRST_BYTE_TIMEOUT_MS = '100';
  const forward = await loadForward();

  const result = await forward.forwardToUpstream({
    ...input(),
    endpoint: imageEndpoint,
  });

  assert.equal(result.kind, 'responded');
  assert.equal(await result.upstream.text(), 'image');
  await upstream.close();
});

test('响应头及时后清除首包计时器，慢 body 仍完整', async () => {
  const upstream = await listen((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.flushHeaders();
    response.write('first-');
    setTimeout(() => response.end('last'), 350);
  });
  process.env.NEWAPI_BASE_URL = upstream.baseUrl;
  process.env.GATEWAY_FIRST_BYTE_TIMEOUT_MS = '100';
  const forward = await loadForward();

  const result = await forward.forwardToUpstream(input());

  assert.equal(result.kind, 'responded');
  assert.equal(await result.upstream.text(), 'first-last');
  await upstream.close();
});

test('clientSignal abort 会中断上游请求', async () => {
  let observeAbort!: () => void;
  const aborted = new Promise<void>((resolve) => (observeAbort = resolve));
  const upstream = await listen((request) => {
    request.on('aborted', observeAbort);
  });
  process.env.NEWAPI_BASE_URL = upstream.baseUrl;
  process.env.GATEWAY_FIRST_BYTE_TIMEOUT_MS = '1000';
  const forward = await loadForward();
  const controller = new AbortController();
  const promise = forward.forwardToUpstream(input(controller));
  setTimeout(() => controller.abort(), 30);

  const result = await promise;

  assert.equal(result.kind, 'no_response');
  await Promise.race([
    aborted,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error('未观察到上游 abort')), 500)
    ),
  ]);
  await upstream.close();
});

test('SSE body 可按 chunk 流式读取', async () => {
  const upstream = await listen((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.flushHeaders();
    response.write('data: one\n\n');
    setTimeout(() => response.end('data: two\n\n'), 30);
  });
  process.env.NEWAPI_BASE_URL = upstream.baseUrl;
  const forward = await loadForward();

  const result = await forward.forwardToUpstream({
    ...input(),
    isStream: true,
  });

  assert.equal(result.kind, 'responded');
  const reader = result.upstream.body!.getReader();
  const first = await reader.read();
  const second = await reader.read();
  assert.equal(new TextDecoder().decode(first.value), 'data: one\n\n');
  assert.equal(new TextDecoder().decode(second.value), 'data: two\n\n');
  await upstream.close();
});
