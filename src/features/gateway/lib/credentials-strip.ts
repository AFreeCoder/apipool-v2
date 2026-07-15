const CREDENTIAL_HEADERS = new Set([
  'authorization',
  'x-api-key',
  'x-goog-api-key',
  'api-key',
  'cookie',
  'sec-websocket-protocol',
]);

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'te',
  'upgrade',
  'trailer',
  'host',
  'content-length',
]);

const DOWNSTREAM_STRIP = new Set([
  'x-oneapi-request-id',
  'server',
  'content-encoding',
  'content-length',
  'transfer-encoding',
  'connection',
  'keep-alive',
]);

export function buildUpstreamHeaders(
  incoming: Headers,
  runtimeKey: string
): Headers {
  const out = new Headers();
  incoming.forEach((value, name) => {
    if (CREDENTIAL_HEADERS.has(name) || HOP_BY_HOP.has(name)) return;
    if (name.startsWith('proxy-') || name.startsWith('x-apipool-')) return;
    out.set(name, value);
  });
  out.set('authorization', `Bearer ${runtimeKey}`);
  out.set('accept-encoding', 'identity');
  return out;
}

export function sanitizeDownstreamHeaders(
  upstream: Headers,
  portalRequestId: string
): Headers {
  const out = new Headers();
  upstream.forEach((value, name) => {
    if (DOWNSTREAM_STRIP.has(name)) return;
    out.set(name, value);
  });
  out.set('x-apipool-request-id', portalRequestId);
  out.set('cache-control', 'no-store');
  return out;
}
