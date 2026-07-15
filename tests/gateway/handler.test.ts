import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

async function loadHandler() {
  return import('@/features/gateway/server/handler');
}

async function errorCode(response: Response) {
  const body = await response.json();
  return body.error.code;
}

function request(path: string, body?: BodyInit, headers: HeadersInit = {}) {
  return new Request(`http://portal.test${path}`, {
    method: 'POST',
    headers,
    body,
  });
}

function baseDeps(overrides: Record<string, unknown> = {}) {
  return {
    authenticate: async () => ({
      ok: true,
      key: { id: 'key-1', userId: 'user-1', groupId: 'group-1' },
      wallet: { balanceMicroUsd: 1_000_000 },
    }),
    resolveRoute: async () => null,
    ensureCredential: async () => ({ status: 'pending' }),
    resolveRisk: async () => 10,
    admit: async () => true,
    capture: async () => true,
    markFailed: async () => true,
    markPending: async () => true,
    settle: async () => 'settled',
    markInvalid: async () => {},
    forward: async () => ({ kind: 'no_response', stage: 'connect' }),
    buildModels: async () => new Response('{}'),
    terminalRetryDelaysMs: [0, 0, 0],
    ...overrides,
  };
}

function readyDeps(overrides: Record<string, unknown> = {}) {
  return baseDeps({
    resolveRoute: async () => ({
      routeId: 'route-1',
      routeVersion: 1,
      newapiGroup: 'official',
      newapiModelId: 'remote-model',
      priceVersionId: 'price-1',
      price: {},
      portalGroupId: 'group-1',
      portalModelId: 'portal-model',
    }),
    ensureCredential: async () => ({
      status: 'ok',
      credentialId: 'credential-1',
      runtimeKey: 'sk-runtime-secret',
    }),
    forward: async () => ({
      kind: 'responded',
      upstream: new Response(
        JSON.stringify({
          usage: { prompt_tokens: 2, completion_tokens: 3 },
        }),
        {
          headers: {
            'content-type': 'application/json',
            'x-oneapi-request-id': 'newapi-request-1',
          },
        }
      ),
      newapiRequestId: 'newapi-request-1',
    }),
    ...overrides,
  });
}

async function waitUntil(
  predicate: () => boolean,
  timeoutMs = 1000
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('等待异步终态超时');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test.afterEach(() => {
  delete process.env.GATEWAY_MAX_BODY_BYTES;
  delete process.env.GATEWAY_MAX_INFLIGHT;
  delete process.env.GATEWAY_STREAM_IDLE_TIMEOUT_MS;
  delete process.env.GATEWAY_NONSTREAM_TOTAL_TIMEOUT_MS;
  delete process.env.GATEWAY_HARD_TIMEOUT_MS;
});

test('非白名单端点返回 404 unknown_endpoint', async () => {
  const handler = await loadHandler();
  for (const [req, path] of [
    [request('/v1/audio/speech', '{}'), ['audio', 'speech']],
    [
      new Request('http://portal.test/v1/chat/completions'),
      ['chat', 'completions'],
    ],
  ] as const) {
    const response = await handler.handleGatewayRequest(req, [...path]);
    assert.equal(response.status, 404);
    assert.equal(await errorCode(response), 'unknown_endpoint');
  }
});

test('鉴权失败原样返回；有 Key 但 body 超限返回 413', async () => {
  const handler = await loadHandler();
  const unauthorized = await handler.handleGatewayRequest(
    request('/v1/chat/completions', '{}'),
    ['chat', 'completions'],
    baseDeps({
      authenticate: async (_headers: Headers, protocol: any, id: string) => ({
        ok: false,
        response: (
          await import('@/features/gateway/lib/errors')
        ).gatewayErrorResponse(protocol, 'invalid_api_key', {
          status: 401,
          portalRequestId: id,
        }),
      }),
    }) as any
  );
  assert.equal(unauthorized.status, 401);

  process.env.GATEWAY_MAX_BODY_BYTES = '64';
  const oversized = await handler.handleGatewayRequest(
    request('/v1/chat/completions', 'x'.repeat(65)),
    ['chat', 'completions'],
    baseDeps() as any
  );
  assert.equal(oversized.status, 413);
  assert.equal(await errorCode(oversized), 'request_too_large');
});

test('readBodyBounded 无 Content-Length 超限时立即 cancel 且停止 pull', async () => {
  const handler = await loadHandler();
  let pulls = 0;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulls += 1;
      controller.enqueue(new Uint8Array(40));
    },
    cancel() {
      cancelled = true;
    },
  });
  const req = new Request('http://portal.test/v1/chat/completions', {
    method: 'POST',
    body: stream,
    duplex: 'half',
  } as RequestInit);
  const result = await handler.readBodyBounded(req, 64, {
    idleMs: 1000,
    totalMs: 1000,
    signal: new AbortController().signal,
  });
  assert.deepEqual(result, { ok: false, reason: 'over_limit' });
  assert.equal(cancelled, true);
  assert.ok(pulls <= 3);
});

test('Content-Length 伪造小值但实际多发仍拒绝', async () => {
  const handler = await loadHandler();
  const req = request('/v1/chat/completions', 'x'.repeat(100), {
    'content-length': '10',
  });
  const result = await handler.readBodyBounded(req, 64, {
    idleMs: 1000,
    totalMs: 1000,
    signal: new AbortController().signal,
  });
  assert.deepEqual(result, { ok: false, reason: 'over_limit' });
});

test('缺 model 与重复 model 分别返回 404/400 且零转发', async () => {
  const handler = await loadHandler();
  let forwarded = 0;
  const deps = baseDeps({
    forward: async () => {
      forwarded += 1;
      return { kind: 'no_response', stage: 'connect' };
    },
  });
  const missing = await handler.handleGatewayRequest(
    request('/v1/chat/completions', '{"messages":[]}'),
    ['chat', 'completions'],
    deps as any
  );
  assert.equal(missing.status, 404);
  const duplicate = await handler.handleGatewayRequest(
    request('/v1/chat/completions', '{"model":"a","model":"b"}'),
    ['chat', 'completions'],
    deps as any
  );
  assert.equal(duplicate.status, 400);
  assert.equal(forwarded, 0);
});

test('路由存在但运行 Key pending → 503 + Retry-After', async () => {
  const handler = await loadHandler();
  const response = await handler.handleGatewayRequest(
    request('/v1/chat/completions', '{"model":"portal-model"}'),
    ['chat', 'completions'],
    baseDeps({
      resolveRoute: async () => ({
        routeId: 'route-1',
        routeVersion: 1,
        newapiGroup: 'official',
        newapiModelId: 'remote-model',
        priceVersionId: 'price-1',
        price: {},
        portalGroupId: 'group-1',
        portalModelId: 'portal-model',
      }),
    }) as any
  );
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('retry-after'), '1');
});

test('异常路径释放进程信号量，下一请求不被永久 429', async () => {
  process.env.GATEWAY_MAX_INFLIGHT = '1';
  const handler = await loadHandler();
  const throwing = baseDeps({
    authenticate: async () => {
      throw new Error('boom');
    },
  });
  const first = await handler.handleGatewayRequest(
    request('/v1/chat/completions', '{}'),
    ['chat', 'completions'],
    throwing as any
  );
  assert.equal(first.status, 500);
  const second = await handler.handleGatewayRequest(
    request('/v1/chat/completions', '{}'),
    ['chat', 'completions'],
    baseDeps() as any
  );
  assert.notEqual(second.status, 429);
});

test('慢请求体 idle 超时返回 408，并释放信号量', async () => {
  process.env.GATEWAY_MAX_INFLIGHT = '1';
  process.env.GATEWAY_STREAM_IDLE_TIMEOUT_MS = '50';
  const handler = await loadHandler();
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{'));
    },
    cancel() {
      cancelled = true;
    },
  });
  const req = new Request('http://portal.test/v1/chat/completions', {
    method: 'POST',
    body: stream,
    duplex: 'half',
  } as RequestInit);
  const timedOut = await handler.handleGatewayRequest(
    req,
    ['chat', 'completions'],
    baseDeps() as any
  );
  assert.equal(timedOut.status, 408);
  assert.equal(cancelled, true);
  const next = await handler.handleGatewayRequest(
    request('/v1/chat/completions', '{}'),
    ['chat', 'completions'],
    baseDeps() as any
  );
  assert.notEqual(next.status, 429);
});

test('持续涓流仍受读体总时长限制，超时后 reader 被 cancel', async () => {
  process.env.GATEWAY_STREAM_IDLE_TIMEOUT_MS = '100';
  process.env.GATEWAY_NONSTREAM_TOTAL_TIMEOUT_MS = '50';
  const handler = await loadHandler();
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      controller.enqueue(new TextEncoder().encode(' '));
    },
    cancel() {
      cancelled = true;
    },
  });
  const req = new Request('http://portal.test/v1/chat/completions', {
    method: 'POST',
    body: stream,
    duplex: 'half',
  } as RequestInit);
  const response = await handler.handleGatewayRequest(
    req,
    ['chat', 'completions'],
    baseDeps() as any
  );
  assert.equal(response.status, 408);
  assert.equal(cancelled, true);
});

test('流式响应持有信号量，流结束后才释放', async () => {
  process.env.GATEWAY_MAX_INFLIGHT = '1';
  const handler = await loadHandler();
  let upstreamController!: ReadableStreamDefaultController<Uint8Array>;
  const upstreamBody = new ReadableStream<Uint8Array>({
    start(controller) {
      upstreamController = controller;
      controller.enqueue(
        new TextEncoder().encode(
          'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n'
        )
      );
    },
  });
  const first = await handler.handleGatewayRequest(
    request('/v1/chat/completions', '{"model":"portal-model"}'),
    ['chat', 'completions'],
    readyDeps({
      forward: async () => ({
        kind: 'responded',
        upstream: new Response(upstreamBody, {
          headers: { 'content-type': 'text/event-stream' },
        }),
        newapiRequestId: 'newapi-request-stream',
      }),
    }) as any
  );
  assert.equal(first.status, 200);

  const blocked = await handler.handleGatewayRequest(
    request('/v1/chat/completions', '{"model":"portal-model"}'),
    ['chat', 'completions'],
    readyDeps() as any
  );
  assert.equal(blocked.status, 429);

  upstreamController.enqueue(
    new TextEncoder().encode(
      'data: {"usage":{"prompt_tokens":2,"completion_tokens":3}}\n\n'
    )
  );
  upstreamController.close();
  await first.text();

  const admitted = await handler.handleGatewayRequest(
    request('/v1/chat/completions', '{"model":"portal-model"}'),
    ['chat', 'completions'],
    readyDeps() as any
  );
  assert.equal(admitted.status, 200);
  await admitted.text();
});

test('准入后异常收束账本并释放信号量', async () => {
  process.env.GATEWAY_MAX_INFLIGHT = '1';
  const handler = await loadHandler();
  let failed = 0;
  const response = await handler.handleGatewayRequest(
    request('/v1/chat/completions', '{"model":"portal-model"}'),
    ['chat', 'completions'],
    readyDeps({
      forward: async () => {
        throw new Error('forward exploded');
      },
      markFailed: async () => {
        failed += 1;
        return true;
      },
    }) as any
  );
  assert.equal(response.status, 500);
  assert.equal(failed, 1);

  const next = await handler.handleGatewayRequest(
    request('/v1/chat/completions', '{}'),
    ['chat', 'completions'],
    baseDeps() as any
  );
  assert.notEqual(next.status, 429);
});

test('persistTerminal：SQLITE_BUSY 可重试，四次失败只告警不抛', async () => {
  const handler = await loadHandler();
  let attempts = 0;
  const recovered = await handler.persistTerminal(
    async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('SQLITE_BUSY');
      return 'ok';
    },
    'fallback',
    'test',
    [0, 0, 0]
  );
  assert.equal(recovered, 'ok');
  assert.equal(attempts, 2);

  const originalError = console.error;
  const logs: unknown[][] = [];
  console.error = (...args: unknown[]) => logs.push(args);
  try {
    attempts = 0;
    const exhausted = await handler.persistTerminal(
      async () => {
        attempts += 1;
        throw new Error('SQLITE_BUSY');
      },
      false,
      'test-exhausted',
      [0, 0, 0]
    );
    assert.equal(exhausted, false);
    assert.equal(attempts, 4);
    assert.equal(
      logs.some((line) => String(line[0]).includes('after retries')),
      true
    );
  } finally {
    console.error = originalError;
  }
});

test('上游 500 的 failed_unbilled 写入同享退避并原样受控透传', async () => {
  const handler = await loadHandler();
  let failedAttempts = 0;
  const response = await handler.handleGatewayRequest(
    request('/v1/chat/completions', '{"model":"portal-model"}'),
    ['chat', 'completions'],
    readyDeps({
      forward: async () => ({
        kind: 'responded',
        upstream: new Response('upstream failed', { status: 500 }),
        newapiRequestId: 'newapi-request-500',
      }),
      markFailed: async () => {
        failedAttempts += 1;
        if (failedAttempts === 1) throw new Error('SQLITE_BUSY');
        return true;
      },
    }) as any
  );
  assert.equal(response.status, 500);
  assert.equal(await response.text(), 'upstream failed');
  assert.equal(failedAttempts, 2);
});

test('capture 首次 busy 后成功会结算；穷尽失败则 failed_unbilled', async () => {
  const handler = await loadHandler();
  let captureAttempts = 0;
  let settled = 0;
  let failed = 0;
  const recovered = await handler.handleGatewayRequest(
    request('/v1/chat/completions', '{"model":"portal-model"}'),
    ['chat', 'completions'],
    readyDeps({
      capture: async () => {
        captureAttempts += 1;
        if (captureAttempts === 1) throw new Error('SQLITE_BUSY');
        return true;
      },
      settle: async () => {
        settled += 1;
        return 'settled';
      },
    }) as any
  );
  await recovered.text();
  await waitUntil(() => settled === 1);
  assert.equal(captureAttempts, 2);

  const originalError = console.error;
  console.error = () => {};
  try {
    const exhausted = await handler.handleGatewayRequest(
      request('/v1/chat/completions', '{"model":"portal-model"}'),
      ['chat', 'completions'],
      readyDeps({
        capture: async () => {
          throw new Error('SQLITE_BUSY');
        },
        settle: async () => {
          throw new Error('不得结算');
        },
        markPending: async () => {
          throw new Error('不得进入回填');
        },
        markFailed: async () => {
          failed += 1;
          return true;
        },
      }) as any
    );
    await exhausted.text();
    await waitUntil(() => failed === 1);
  } finally {
    console.error = originalError;
  }
});

test('Messages 部分 usage 中断不结算，完整 message_delta 后可结算', async () => {
  const handler = await loadHandler();
  const encoder = new TextEncoder();
  const start =
    'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":25,"output_tokens":1}}}\n\n';
  const delta =
    'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":77}}\n\n';

  let partialFailed = 0;
  let partialSettled = 0;
  const partial = await handler.handleGatewayRequest(
    request('/v1/messages', '{"model":"portal-model"}'),
    ['messages'],
    readyDeps({
      forward: async () => ({
        kind: 'responded',
        upstream: new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(encoder.encode(start));
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } }
        ),
        newapiRequestId: 'newapi-request-partial',
      }),
      settle: async () => {
        partialSettled += 1;
        return 'settled';
      },
      markFailed: async () => {
        partialFailed += 1;
        if (partialFailed < 3) throw new Error('SQLITE_BUSY');
        return true;
      },
    }) as any
  );
  const partialReader = partial.body!.getReader();
  await partialReader.read();
  await partialReader.cancel();
  await waitUntil(() => partialFailed === 3);
  assert.equal(partialSettled, 0);

  let completeSettled = 0;
  const complete = await handler.handleGatewayRequest(
    request('/v1/messages', '{"model":"portal-model"}'),
    ['messages'],
    readyDeps({
      forward: async () => ({
        kind: 'responded',
        upstream: new Response(encoder.encode(start + delta), {
          headers: { 'content-type': 'text/event-stream' },
        }),
        newapiRequestId: 'newapi-request-complete',
      }),
      settle: async () => {
        completeSettled += 1;
        return 'settled';
      },
    }) as any
  );
  await complete.text();
  await waitUntil(() => completeSettled === 1);
});

test('响应头后零 chunk 会 idle 中止并释放信号量', async () => {
  process.env.GATEWAY_MAX_INFLIGHT = '1';
  process.env.GATEWAY_STREAM_IDLE_TIMEOUT_MS = '50';
  const handler = await loadHandler();
  let cancelled = false;
  let failed = 0;
  const stalled = await handler.handleGatewayRequest(
    request('/v1/chat/completions', '{"model":"portal-model"}'),
    ['chat', 'completions'],
    readyDeps({
      forward: async () => ({
        kind: 'responded',
        upstream: new Response(
          new ReadableStream<Uint8Array>({
            cancel() {
              cancelled = true;
            },
          }),
          { headers: { 'content-type': 'text/event-stream' } }
        ),
        newapiRequestId: 'newapi-request-stalled',
      }),
      markFailed: async () => {
        failed += 1;
        return true;
      },
    }) as any
  );
  await assert.rejects(() => stalled.text());
  await waitUntil(() => failed === 1);
  assert.equal(cancelled, true);

  const next = await handler.handleGatewayRequest(
    request('/v1/chat/completions', '{}'),
    ['chat', 'completions'],
    baseDeps() as any
  );
  assert.notEqual(next.status, 429);
});

test('gateway server/lib 禁止 tee() 与 next/* import', async () => {
  const files = [
    'src/features/gateway/server/handler.ts',
    'src/features/gateway/server/forward.ts',
    'src/features/gateway/server/auth.ts',
    'src/features/gateway/server/credentials.ts',
    'src/features/gateway/server/routing.ts',
    'src/features/gateway/server/models-endpoint.ts',
  ];
  for (const file of files) {
    const source = await readFile(file, 'utf8');
    assert.equal(source.includes('.tee('), false, file);
    assert.doesNotMatch(source, /from ['"]next\//, file);
  }
});
