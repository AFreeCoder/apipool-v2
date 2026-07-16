import 'server-only';

import { normalizeUsage } from '@/features/gateway/lib/billing';
import { gatewayConfig } from '@/features/gateway/lib/config';
import {
  buildUpstreamHeaders,
  sanitizeDownstreamHeaders,
} from '@/features/gateway/lib/credentials-strip';
import {
  resolveEndpoint,
  type GatewayProtocol,
} from '@/features/gateway/lib/endpoints';
import { gatewayErrorResponse } from '@/features/gateway/lib/errors';
import {
  createUsageExtractor,
  extractTopLevelModel,
  extractTopLevelStream,
} from '@/features/gateway/lib/sse-parser';

import { getUuidV7 } from '@/shared/lib/hash';

import {
  admitRequest,
  captureRequestId,
  markFailedUnbilled,
  markPendingBackfill,
  resolveRiskLimit,
} from './admission';
import { authenticateGatewayRequest } from './auth';
import { ensureRuntimeCredential, markCredentialInvalid } from './credentials';
import { forwardToUpstream } from './forward';
import { buildModelsResponse } from './models-endpoint';
import { resolveActiveRoute } from './routing';
import { settleByLedgerId } from './settlement';

const DEFAULT_TERMINAL_RETRY_DELAYS_MS = [100, 500, 2000];

let inflight = 0;

function tryAcquire(max: number): boolean {
  if (inflight >= max) return false;
  inflight += 1;
  return true;
}

function release() {
  inflight = Math.max(0, inflight - 1);
}

export type BoundedBody =
  | { ok: true; body: Uint8Array }
  | { ok: false; reason: 'over_limit' | 'timeout' };

export async function readBodyBounded(
  req: Request,
  maxBytes: number,
  opts: { idleMs: number; totalMs: number; signal: AbortSignal }
): Promise<BoundedBody> {
  const rawContentLength = req.headers.get('content-length');
  const declared = rawContentLength === null ? null : Number(rawContentLength);
  const hasValidContentLength =
    declared !== null && Number.isFinite(declared) && declared >= 0;
  if (hasValidContentLength && declared > maxBytes) {
    return { ok: false, reason: 'over_limit' };
  }
  if (!req.body) return { ok: true, body: new Uint8Array(0) };

  const reader = req.body.getReader();
  const deadline = Date.now() + opts.totalMs;
  const abortPromise = new Promise<'timeout'>((resolve) => {
    if (opts.signal.aborted) resolve('timeout');
    else {
      opts.signal.addEventListener('abort', () => resolve('timeout'), {
        once: true,
      });
    }
  });
  const capacity = hasValidContentLength ? declared : maxBytes;
  const buffer = new Uint8Array(capacity);
  let total = 0;

  try {
    while (true) {
      let idleTimer: ReturnType<typeof setTimeout> | undefined;
      const idlePromise = new Promise<'timeout'>((resolve) => {
        const remaining = Math.min(opts.idleMs, deadline - Date.now());
        idleTimer = setTimeout(
          () => resolve('timeout'),
          Math.max(0, remaining)
        );
      });
      const raced = await Promise.race([
        reader.read(),
        idlePromise,
        abortPromise,
      ]);
      clearTimeout(idleTimer);
      if (raced === 'timeout') {
        await reader.cancel().catch(() => {});
        return { ok: false, reason: 'timeout' };
      }
      const { done, value } = raced as ReadableStreamReadResult<Uint8Array>;
      if (done) break;
      if (
        total + value.byteLength > maxBytes ||
        total + value.byteLength > capacity
      ) {
        await reader.cancel().catch(() => {});
        return { ok: false, reason: 'over_limit' };
      }
      buffer.set(value, total);
      total += value.byteLength;
    }
  } catch {
    await reader.cancel().catch(() => {});
    return { ok: false, reason: 'timeout' };
  }

  return {
    ok: true,
    body: total === capacity ? buffer : buffer.subarray(0, total),
  };
}

export async function persistTerminal<T>(
  fn: () => Promise<T>,
  fallback: T,
  context: string,
  delays = DEFAULT_TERMINAL_RETRY_DELAYS_MS
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      if (attempt >= delays.length) {
        console.error(
          `[gateway] terminal write failed after retries (${context}); sweeper will converge`,
          { error: String(error) }
        );
        return fallback;
      }
      console.error(`[gateway] terminal write failed, retrying (${context})`, {
        attempt,
        error: String(error),
      });
      await new Promise<void>((resolve) =>
        setTimeout(resolve, delays[attempt])
      );
    }
  }
}

type HandlerDeps = {
  authenticate: typeof authenticateGatewayRequest;
  resolveRoute: typeof resolveActiveRoute;
  ensureCredential: typeof ensureRuntimeCredential;
  resolveRisk: typeof resolveRiskLimit;
  admit: typeof admitRequest;
  capture: typeof captureRequestId;
  markFailed: typeof markFailedUnbilled;
  markPending: typeof markPendingBackfill;
  settle: typeof settleByLedgerId;
  markInvalid: typeof markCredentialInvalid;
  forward: typeof forwardToUpstream;
  buildModels: typeof buildModelsResponse;
  terminalRetryDelaysMs: number[];
};

const defaultDeps: HandlerDeps = {
  authenticate: authenticateGatewayRequest,
  resolveRoute: resolveActiveRoute,
  ensureCredential: ensureRuntimeCredential,
  resolveRisk: resolveRiskLimit,
  admit: admitRequest,
  capture: captureRequestId,
  markFailed: markFailedUnbilled,
  markPending: markPendingBackfill,
  settle: settleByLedgerId,
  markInvalid: markCredentialInvalid,
  forward: forwardToUpstream,
  buildModels: buildModelsResponse,
  terminalRetryDelaysMs: DEFAULT_TERMINAL_RETRY_DELAYS_MS,
};

function gatewayError(
  protocol: GatewayProtocol,
  code: Parameters<typeof gatewayErrorResponse>[1],
  status: number,
  portalRequestId: string,
  retryAfterSeconds?: number
) {
  return gatewayErrorResponse(protocol, code, {
    status,
    portalRequestId,
    retryAfterSeconds,
  });
}

export async function handleGatewayRequest(
  req: Request,
  pathSegments: string[],
  overrides: Partial<HandlerDeps> = {}
): Promise<Response> {
  const deps = { ...defaultDeps, ...overrides };
  const config = gatewayConfig();
  const portalRequestId = `preq_${getUuidV7()}`;
  const endpoint = resolveEndpoint(req.method, pathSegments);
  if (!endpoint) {
    return gatewayError('openai', 'unknown_endpoint', 404, portalRequestId);
  }
  const protocol = endpoint.protocol;

  if (endpoint.key === 'models') {
    try {
      const auth = await deps.authenticate(
        req.headers,
        protocol,
        portalRequestId
      );
      if (!auth.ok) return auth.response;
      return deps.buildModels(auth.key, portalRequestId);
    } catch (error) {
      console.error('[gateway] models handler failed', {
        portalRequestId,
        error: String(error),
      });
      return gatewayError(protocol, 'internal_error', 500, portalRequestId);
    }
  }

  if (!tryAcquire(config.maxInflight)) {
    return gatewayError(
      protocol,
      'concurrency_limit_exceeded',
      429,
      portalRequestId,
      5
    );
  }

  const upstreamController = new AbortController();
  const onClientAbort = () => upstreamController.abort();
  req.signal.addEventListener('abort', onClientAbort, { once: true });
  const hardTimer = setTimeout(
    () => upstreamController.abort(new Error('hard_timeout')),
    config.hardTimeoutMs
  );
  let bodyTimer: ReturnType<typeof setTimeout> | undefined;
  let cleaned = false;
  let bodyOwnershipTransferred = false;
  let admittedLedgerId: string | null = null;

  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    clearTimeout(hardTimer);
    clearTimeout(bodyTimer);
    req.signal.removeEventListener('abort', onClientAbort);
    release();
  };
  const early = (response: Response) => {
    cleanup();
    return response;
  };
  const terminal = <T>(fn: () => Promise<T>, fallback: T, context: string) =>
    persistTerminal(fn, fallback, context, deps.terminalRetryDelaysMs);

  try {
    const auth = await deps.authenticate(
      req.headers,
      protocol,
      portalRequestId
    );
    if (!auth.ok) return early(auth.response);

    const bodyResult = await readBodyBounded(req, config.maxBodyBytes, {
      idleMs: config.streamIdleTimeoutMs,
      totalMs: config.nonstreamTotalTimeoutMs,
      signal: upstreamController.signal,
    });
    if (!bodyResult.ok) {
      return early(
        gatewayError(
          protocol,
          bodyResult.reason === 'over_limit'
            ? 'request_too_large'
            : 'request_timeout',
          bodyResult.reason === 'over_limit' ? 413 : 408,
          portalRequestId
        )
      );
    }

    const extraction = extractTopLevelModel(bodyResult.body);
    if (!extraction.ok) {
      const malformed = extraction.reason !== 'missing';
      return early(
        gatewayError(
          protocol,
          malformed ? 'invalid_request' : 'model_not_found',
          malformed ? 400 : 404,
          portalRequestId
        )
      );
    }
    const streamExtraction = extractTopLevelStream(bodyResult.body);
    const requestIsStream = streamExtraction.ok
      ? streamExtraction.isStream
      : false;

    const route = await deps.resolveRoute(auth.key.groupId, extraction.model);
    if (!route) {
      return early(
        gatewayError(protocol, 'model_not_found', 404, portalRequestId)
      );
    }

    const credential = await deps.ensureCredential(
      auth.key.userId,
      route.newapiGroup
    );
    if (credential.status === 'pending') {
      return early(
        gatewayError(protocol, 'upstream_unavailable', 503, portalRequestId, 1)
      );
    }
    if (credential.status === 'disabled') {
      return early(
        gatewayError(protocol, 'account_disabled', 403, portalRequestId)
      );
    }

    const riskLimit = await deps.resolveRisk(auth.key.userId);
    const admitted = await deps.admit(
      {
        id: portalRequestId,
        userId: auth.key.userId,
        portalKeyId: auth.key.id,
        portalGroupId: auth.key.groupId,
        portalModelId: extraction.model,
        newapiGroup: route.newapiGroup,
        newapiModelId: route.newapiModelId,
        credentialId: credential.credentialId,
        routeVersion: route.routeVersion,
        priceVersionId: route.priceVersionId,
        endpoint: endpoint.key,
        isStream: requestIsStream,
      },
      riskLimit
    );
    if (!admitted) {
      return early(
        gatewayError(
          protocol,
          'concurrency_limit_exceeded',
          429,
          portalRequestId,
          5
        )
      );
    }
    admittedLedgerId = portalRequestId;

    const outcome = await deps.forward({
      endpoint,
      rawBody: bodyResult.body,
      headers: buildUpstreamHeaders(req.headers, credential.runtimeKey),
      isStream: requestIsStream,
      clientSignal: upstreamController.signal,
    });
    if (outcome.kind === 'no_response') {
      await terminal(
        () =>
          deps.markFailed(portalRequestId, {
            errorCode: `upstream_${outcome.stage}`,
          }),
        false,
        'failed'
      );
      return early(
        gatewayError(protocol, 'upstream_unavailable', 502, portalRequestId)
      );
    }

    const upstream = outcome.upstream;
    const captured = outcome.newapiRequestId
      ? await terminal(
          () => deps.capture(portalRequestId, outcome.newapiRequestId!),
          false,
          'capture'
        )
      : false;

    if (upstream.status === 401 || upstream.status === 403) {
      await deps.markInvalid(
        credential.credentialId,
        `upstream_${upstream.status}`
      );
      await terminal(
        () =>
          deps.markFailed(portalRequestId, {
            httpStatus: upstream.status,
            errorCode: 'upstream_error',
          }),
        false,
        'failed'
      );
      await upstream.body?.cancel().catch(() => {});
      return early(
        gatewayError(protocol, 'upstream_error', 502, portalRequestId)
      );
    }

    const isStream = (upstream.headers.get('content-type') ?? '').includes(
      'text/event-stream'
    );
    const extractor = createUsageExtractor(
      endpoint.key,
      isStream,
      config.parseBufferMax
    );
    let finalized = false;
    let terminalAlreadyWritten = false;

    if (!upstream.ok) {
      terminalAlreadyWritten = true;
      await terminal(
        () =>
          deps.markFailed(portalRequestId, {
            httpStatus: upstream.status,
            errorCode: 'upstream_error',
          }),
        false,
        'failed'
      );
    }

    const finalize = async (clientCompleted: boolean, aborted: boolean) => {
      if (finalized) return;
      finalized = true;
      cleanup();
      if (terminalAlreadyWritten) return;

      const { usage, complete } = extractor.finish();
      if (usage && complete && captured) {
        const normalized = normalizeUsage(endpoint.key, usage);
        if (normalized.unmappedNonZero.length > 0) {
          console.error('[gateway] unmapped_usage_dimension', {
            portalRequestId,
            unmappedNonZero: normalized.unmappedNonZero,
          });
        }
        await terminal(
          () =>
            deps.settle(portalRequestId, {
              buckets: normalized.buckets,
              usageSource: 'response',
            }),
          'already_finalized',
          'settle'
        );
      } else if (!aborted && clientCompleted && captured) {
        await terminal(
          () =>
            deps.markPending(portalRequestId, {
              httpStatus: upstream.status,
            }),
          false,
          'pending'
        );
      } else if (!captured) {
        console.error('[gateway] request id not persisted', {
          portalRequestId,
        });
        await terminal(
          () =>
            deps.markFailed(portalRequestId, {
              httpStatus: upstream.status,
              errorCode: 'missing_request_id',
              streamAborted: aborted,
            }),
          false,
          'failed'
        );
      } else {
        await terminal(
          () =>
            deps.markFailed(portalRequestId, {
              httpStatus: upstream.status,
              errorCode: 'stream_interrupted',
              streamAborted: true,
            }),
          false,
          'failed'
        );
      }
    };

    if (!upstream.body) {
      await finalize(true, false);
      return new Response(null, {
        status: upstream.status,
        headers: sanitizeDownstreamHeaders(upstream.headers, portalRequestId),
      });
    }

    const startBodyTimer = () => {
      clearTimeout(bodyTimer);
      bodyTimer = setTimeout(
        () => upstreamController.abort(new Error('body_timeout')),
        isStream ? config.streamIdleTimeoutMs : config.nonstreamTotalTimeoutMs
      );
    };
    startBodyTimer();

    const passthrough = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        extractor.push(chunk);
        if (isStream) startBodyTimer();
        controller.enqueue(chunk);
      },
    });
    bodyOwnershipTransferred = true;
    upstream.body
      .pipeTo(passthrough.writable, { signal: upstreamController.signal })
      .then(
        () => finalize(true, false),
        () => {
          upstreamController.abort();
          return finalize(false, true);
        }
      )
      .catch((error) =>
        console.error('[gateway] finalize pipeline error', {
          portalRequestId,
          error: String(error),
        })
      );

    return new Response(passthrough.readable, {
      status: upstream.status,
      headers: sanitizeDownstreamHeaders(upstream.headers, portalRequestId),
    });
  } catch (error) {
    console.error('[gateway] request handler failed', {
      portalRequestId,
      error: String(error),
    });
    if (!bodyOwnershipTransferred) {
      if (admittedLedgerId) {
        await terminal(
          () =>
            deps.markFailed(admittedLedgerId!, {
              errorCode: 'internal_error',
            }),
          false,
          'failed'
        );
      }
      cleanup();
    }
    return gatewayError(protocol, 'internal_error', 500, portalRequestId);
  }
}
