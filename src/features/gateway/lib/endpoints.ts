export type GatewayEndpointKey =
  | 'chat_completions'
  | 'responses'
  | 'messages'
  | 'embeddings'
  | 'models';

export type GatewayProtocol = 'openai' | 'anthropic';

export interface GatewayEndpoint {
  key: GatewayEndpointKey;
  method: 'GET' | 'POST';
  upstreamPath: string;
  protocol: GatewayProtocol;
  billable: boolean;
}

export const GATEWAY_ENDPOINTS: readonly GatewayEndpoint[] = [
  {
    key: 'chat_completions',
    method: 'POST',
    upstreamPath: '/v1/chat/completions',
    protocol: 'openai',
    billable: true,
  },
  {
    key: 'responses',
    method: 'POST',
    upstreamPath: '/v1/responses',
    protocol: 'openai',
    billable: true,
  },
  {
    key: 'messages',
    method: 'POST',
    upstreamPath: '/v1/messages',
    protocol: 'anthropic',
    billable: true,
  },
  {
    key: 'embeddings',
    method: 'POST',
    upstreamPath: '/v1/embeddings',
    protocol: 'openai',
    billable: true,
  },
  {
    key: 'models',
    method: 'GET',
    upstreamPath: '/v1/models',
    protocol: 'openai',
    billable: false,
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
