import 'server-only';

import { gatewayConfig } from '@/features/gateway/lib/config';
import type { GatewayEndpoint } from '@/features/gateway/lib/endpoints';

export type ForwardOutcome =
  | { kind: 'no_response'; stage: 'connect' | 'sent'; error: unknown }
  | {
      kind: 'responded';
      upstream: Response;
      newapiRequestId: string | null;
    };

const CONNECT_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EAI_AGAIN',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_CONNECT',
]);

export async function forwardToUpstream(input: {
  endpoint: GatewayEndpoint;
  rawBody: Uint8Array | null;
  headers: Headers;
  isStream: boolean;
  clientSignal: AbortSignal;
}): Promise<ForwardOutcome> {
  const config = gatewayConfig();
  const firstByteController = new AbortController();
  const firstByteTimer = setTimeout(
    () => firstByteController.abort(new Error('first_byte_timeout')),
    config.firstByteTimeoutMs
  );
  const signal = AbortSignal.any([
    input.clientSignal,
    firstByteController.signal,
  ]);

  try {
    const upstream = await fetch(
      `${config.newapiBaseUrl}${input.endpoint.upstreamPath}`,
      {
        method: input.endpoint.method,
        headers: input.headers,
        body: input.rawBody ? Uint8Array.from(input.rawBody).buffer : undefined,
        signal,
        redirect: 'manual',
      }
    );
    return {
      kind: 'responded',
      upstream,
      newapiRequestId: upstream.headers.get('x-oneapi-request-id'),
    };
  } catch (error: any) {
    const code = error?.cause?.code ?? error?.code;
    return {
      kind: 'no_response',
      stage: CONNECT_ERROR_CODES.has(String(code)) ? 'connect' : 'sent',
      error,
    };
  } finally {
    clearTimeout(firstByteTimer);
  }
}
