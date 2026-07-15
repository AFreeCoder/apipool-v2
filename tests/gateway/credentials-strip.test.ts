import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildUpstreamHeaders,
  sanitizeDownstreamHeaders,
} from '@/features/gateway/lib/credentials-strip';

test('全载体零残留 + 注入唯一 Authorization（需求 14.6）', () => {
  const incoming = new Headers({
    Authorization: 'Bearer sk-ap-user-key',
    'X-Api-Key': 'sk-ap-user-key',
    'x-goog-api-key': 'g-key',
    'api-key': 'azure-key',
    Cookie: 'session=abc',
    'X-Apipool-Trace': 'x',
    Connection: 'keep-alive',
    'Transfer-Encoding': 'chunked',
    Host: 'api2.apipool.dev',
    'Proxy-Authorization': 'p',
    'Content-Type': 'application/json',
    'User-Agent': 'openai-node/4.0',
    'anthropic-version': '2023-06-01',
  });
  const out = buildUpstreamHeaders(incoming, 'sk-runtime-secret');
  assert.equal(out.get('authorization'), 'Bearer sk-runtime-secret');
  for (const gone of [
    'x-api-key',
    'x-goog-api-key',
    'api-key',
    'cookie',
    'x-apipool-trace',
    'connection',
    'transfer-encoding',
    'host',
    'proxy-authorization',
    'content-length',
  ]) {
    assert.equal(out.get(gone), null, `${gone} 已剥离`);
  }
  assert.equal(out.get('content-type'), 'application/json');
  assert.equal(out.get('anthropic-version'), '2023-06-01');
  assert.equal(out.get('user-agent'), 'openai-node/4.0');
  assert.equal(out.get('accept-encoding'), 'identity');
  assert.equal(out.get('new-api-user'), null);
  out.forEach((value) => assert.ok(!value.includes('sk-ap-user-key')));
});

test('sec-websocket-protocol 备用凭证覆盖被剥离（评审 R7-F1）', () => {
  const incoming = new Headers({
    Authorization: 'Bearer sk-ap-user-key',
    'Sec-WebSocket-Protocol':
      'openai-insecure-api-key.sk-leaked-newapi-token, openai-beta',
    'Content-Type': 'application/json',
  });
  const out = buildUpstreamHeaders(incoming, 'sk-runtime-secret');
  assert.equal(out.get('sec-websocket-protocol'), null);
  assert.equal(out.get('authorization'), 'Bearer sk-runtime-secret');
  out.forEach((value) => assert.ok(!value.includes('sk-leaked-newapi-token')));
});

test('下发响应头剥内部痕迹 + 压缩三头 + 加门户请求 ID', () => {
  const upstream = new Headers({
    'X-Oneapi-Request-Id': 'oneapi-123',
    Server: 'nginx',
    'Content-Encoding': 'gzip',
    'Content-Length': '999',
    'Transfer-Encoding': 'chunked',
    'Content-Type': 'text/event-stream',
  });
  const out = sanitizeDownstreamHeaders(upstream, 'preq_abc');
  for (const gone of [
    'x-oneapi-request-id',
    'server',
    'content-encoding',
    'content-length',
    'transfer-encoding',
  ]) {
    assert.equal(out.get(gone), null);
  }
  assert.equal(out.get('x-apipool-request-id'), 'preq_abc');
  assert.equal(out.get('cache-control'), 'no-store');
  assert.equal(out.get('content-type'), 'text/event-stream');
});
