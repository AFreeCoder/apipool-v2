export type GatewayEndpointKey =
  | 'chat_completions'
  | 'responses'
  | 'messages'
  | 'embeddings'
  | 'images_generations'
  | 'images_edits'
  | 'models';

export type GatewayProtocol = 'openai' | 'anthropic';

export interface GatewayEndpoint {
  key: GatewayEndpointKey;
  method: 'GET' | 'POST';
  upstreamPath: string;
  protocol: GatewayProtocol;
  billable: boolean;
  requestFormat: 'none' | 'json' | 'multipart';
  responseMode: 'none' | 'json_or_sse' | 'json';
  timeoutProfile: 'default' | 'images';
}

export const GATEWAY_ENDPOINTS: readonly GatewayEndpoint[] = [
  {
    key: 'chat_completions',
    method: 'POST',
    upstreamPath: '/v1/chat/completions',
    protocol: 'openai',
    billable: true,
    requestFormat: 'json',
    responseMode: 'json_or_sse',
    timeoutProfile: 'default',
  },
  {
    key: 'responses',
    method: 'POST',
    upstreamPath: '/v1/responses',
    protocol: 'openai',
    billable: true,
    requestFormat: 'json',
    responseMode: 'json_or_sse',
    timeoutProfile: 'default',
  },
  {
    key: 'messages',
    method: 'POST',
    upstreamPath: '/v1/messages',
    protocol: 'anthropic',
    billable: true,
    requestFormat: 'json',
    responseMode: 'json_or_sse',
    timeoutProfile: 'default',
  },
  {
    key: 'embeddings',
    method: 'POST',
    upstreamPath: '/v1/embeddings',
    protocol: 'openai',
    billable: true,
    requestFormat: 'json',
    responseMode: 'json',
    timeoutProfile: 'default',
  },
  {
    key: 'images_generations',
    method: 'POST',
    upstreamPath: '/v1/images/generations',
    protocol: 'openai',
    billable: true,
    requestFormat: 'json',
    responseMode: 'json',
    timeoutProfile: 'images',
  },
  {
    key: 'images_edits',
    method: 'POST',
    upstreamPath: '/v1/images/edits',
    protocol: 'openai',
    billable: true,
    requestFormat: 'multipart',
    responseMode: 'json',
    timeoutProfile: 'images',
  },
  {
    key: 'models',
    method: 'GET',
    upstreamPath: '/v1/models',
    protocol: 'openai',
    billable: false,
    requestFormat: 'none',
    responseMode: 'none',
    timeoutProfile: 'default',
  },
];

export function resolveEndpoint(
  method: string,
  pathSegments: string[]
): GatewayEndpoint | null {
  const path = `/v1/${pathSegments.join('/')}`;
  const verb = method.toUpperCase();
  return (
    GATEWAY_ENDPOINTS.find(
      (endpoint) => endpoint.method === verb && endpoint.upstreamPath === path
    ) ?? null
  );
}
