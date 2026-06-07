import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createNewApiClient,
  NewApiBridgeError,
} from '@/features/newapi-bridge/server/client';

test('New API client binds portal users with zero initial quota', async () => {
  const requests: Request[] = [];
  const client = createNewApiClient({
    baseUrl: 'https://newapi.apipool.dev',
    adminToken: 'secret',
    fetcher: async (input, init) => {
      const req = new Request(input, init);
      requests.push(req);
      return Response.json({ id: 'remote_user_1' });
    },
  });

  await client.createUser({
    portalUserId: 'portal_user_1',
    email: 'new-user@example.com',
  });

  assert.equal(
    requests[0].headers.get('idempotency-key'),
    'portal-user:portal_user_1'
  );
  assert.deepEqual(await requests[0].json(), {
    portalUserId: 'portal_user_1',
    email: 'new-user@example.com',
    initialQuotaUsd: 0,
  });
});

test('New API client sends server-side auth and idempotency headers', async () => {
  const requests: Request[] = [];
  const client = createNewApiClient({
    baseUrl: 'https://newapi.apipool.dev',
    adminToken: 'secret',
    fetcher: async (input, init) => {
      const req = new Request(input, init);
      requests.push(req);
      return Response.json({
        id: 'key_1',
        key: 'sk-live',
        maskedKey: 'sk-...live',
        status: 'active',
      });
    },
  });

  const result = await client.createKey({
    newapiUserId: 'user_1',
    name: 'Default key',
    allowedModels: ['gpt-4o-mini'],
    idempotencyKey: 'idem_1',
  });

  assert.equal(result.key, 'sk-live');
  assert.equal(requests[0].headers.get('authorization'), 'Bearer secret');
  assert.equal(requests[0].headers.get('idempotency-key'), 'idem_1');
  assert.equal(requests[0].url, 'https://newapi.apipool.dev/api/admin/keys');
});

test('New API client checks internal health before live smoke mutations', async () => {
  const requests: Request[] = [];
  const client = createNewApiClient({
    baseUrl: 'https://newapi.apipool.dev',
    adminToken: 'secret',
    fetcher: async (input, init) => {
      const req = new Request(input, init);
      requests.push(req);
      return Response.json({ ok: true, status: 'ready', version: '1.0.0' });
    },
  });

  const health = await client.healthCheck();

  assert.deepEqual(health, { ok: true, status: 'ready', version: '1.0.0' });
  assert.equal(requests[0].method, 'GET');
  assert.equal(
    requests[0].url,
    'https://newapi.apipool.dev/api/admin/health'
  );
  assert.equal(requests[0].headers.get('authorization'), 'Bearer secret');
});

test('New API client maps malformed responses to typed bridge errors', async () => {
  const client = createNewApiClient({
    baseUrl: 'https://newapi.apipool.dev',
    adminToken: 'secret',
    fetcher: async () => Response.json({ bad: true }),
  });

  await assert.rejects(
    () =>
      client.createKey({
        newapiUserId: 'user_1',
        name: 'Default key',
        allowedModels: ['gpt-4o-mini'],
        idempotencyKey: 'idem_1',
      }),
    (error) =>
      error instanceof NewApiBridgeError && error.code === 'malformed_response'
  );
});

test('New API client requires plaintext key when creating a key', async () => {
  const client = createNewApiClient({
    baseUrl: 'https://newapi.apipool.dev',
    adminToken: 'secret',
    fetcher: async () =>
      Response.json({
        id: 'key_1',
        maskedKey: 'sk-...live',
        status: 'active',
      }),
  });

  await assert.rejects(
    () =>
      client.createKey({
        newapiUserId: 'user_1',
        name: 'Default key',
        allowedModels: ['gpt-4o-mini'],
        idempotencyKey: 'idem_1',
      }),
    (error) =>
      error instanceof NewApiBridgeError && error.code === 'malformed_response'
  );
});

test('New API client refuses requests when bridge is disabled', async () => {
  let called = false;
  const client = createNewApiClient({
    baseUrl: 'https://newapi.apipool.dev',
    adminToken: 'secret',
    enabled: false,
    fetcher: async () => {
      called = true;
      return Response.json({ id: 'remote_user_1' });
    },
  });

  await assert.rejects(
    () => client.getQuota('user_1'),
    (error) =>
      error instanceof NewApiBridgeError &&
      error.code === 'not_configured' &&
      /disabled/.test(error.message)
  );
  assert.equal(called, false);
});

test('New API client refuses requests without an internal base URL', async () => {
  let called = false;
  const client = createNewApiClient({
    baseUrl: '',
    adminToken: 'secret',
    fetcher: async () => {
      called = true;
      return Response.json({ id: 'remote_user_1' });
    },
  });

  await assert.rejects(
    () => client.getQuota('user_1'),
    (error) =>
      error instanceof NewApiBridgeError &&
      error.code === 'not_configured' &&
      /NEWAPI_BASE_URL/.test(error.message)
  );
  assert.equal(called, false);
});

test('New API client maps remote 403 to typed bridge errors', async () => {
  const client = createNewApiClient({
    baseUrl: 'https://newapi.apipool.dev',
    adminToken: 'secret',
    fetcher: async () =>
      Response.json({ message: 'forbidden' }, { status: 403 }),
  });

  await assert.rejects(
    () => client.getQuota('user_1'),
    (error) =>
      error instanceof NewApiBridgeError &&
      error.code === 'forbidden' &&
      error.status === 403
  );
});

test('New API client maps remote 401 and 429 to typed bridge errors', async () => {
  const cases = [
    { status: 401, code: 'unauthorized' },
    { status: 429, code: 'rate_limited' },
  ] as const;

  for (const item of cases) {
    const client = createNewApiClient({
      baseUrl: 'https://newapi.apipool.dev',
      adminToken: 'secret',
      fetcher: async () =>
        Response.json({ message: item.code }, { status: item.status }),
    });

    await assert.rejects(
      () => client.getQuota('user_1'),
      (error) =>
        error instanceof NewApiBridgeError &&
        error.code === item.code &&
        error.status === item.status
    );
  }
});

test('New API client retries transient 429 responses with the same idempotency key', async () => {
  const requests: Request[] = [];
  const client = createNewApiClient({
    baseUrl: 'https://newapi.apipool.dev',
    adminToken: 'secret',
    maxRetries: 1,
    retryDelayMs: 0,
    fetcher: async (input, init) => {
      const req = new Request(input, init);
      requests.push(req);
      if (requests.length === 1) {
        return Response.json({ message: 'rate limited' }, { status: 429 });
      }
      return Response.json({
        id: 'key_1',
        key: 'sk-live',
        maskedKey: 'sk-...live',
        status: 'active',
      });
    },
  });

  const result = await client.createKey({
    newapiUserId: 'user_1',
    name: 'Default key',
    allowedModels: ['gpt-4o-mini'],
    idempotencyKey: 'idem_1',
  });

  assert.equal(result.id, 'key_1');
  assert.equal(requests.length, 2);
  assert.equal(requests[0].headers.get('idempotency-key'), 'idem_1');
  assert.equal(requests[1].headers.get('idempotency-key'), 'idem_1');
});

test('New API client sends idempotency headers for key disable and delete mutations', async () => {
  const requests: Request[] = [];
  const client = createNewApiClient({
    baseUrl: 'https://newapi.apipool.dev',
    adminToken: 'secret',
    fetcher: async (input, init) => {
      const req = new Request(input, init);
      requests.push(req);

      if (req.method === 'DELETE') {
        return Response.json({ id: 'key_1', deleted: true });
      }

      return Response.json({
        id: 'key_1',
        maskedKey: 'sk-...disabled',
        status: 'disabled',
      });
    },
  });

  await (client as any).disableKey('key_1', 'disable-idem-1');
  await (client as any).deleteKey('key_1', 'delete-idem-1');

  assert.equal(requests[0].headers.get('idempotency-key'), 'disable-idem-1');
  assert.equal(requests[1].headers.get('idempotency-key'), 'delete-idem-1');
});

test('New API client maps request aborts to timeout bridge errors', async () => {
  const client = createNewApiClient({
    baseUrl: 'https://newapi.apipool.dev',
    adminToken: 'secret',
    timeoutMs: 1,
    fetcher: async (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const error = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        });
      }),
  });

  await assert.rejects(
    () => client.getQuota('user_1'),
    (error) => error instanceof NewApiBridgeError && error.code === 'timeout'
  );
});

test('New API client rejects malformed usage log items', async () => {
  const client = createNewApiClient({
    baseUrl: 'https://newapi.apipool.dev',
    adminToken: 'secret',
    fetcher: async () => Response.json([{ bad: true }]),
  });

  await assert.rejects(
    () => client.listUsageLogs('user_1'),
    (error) =>
      error instanceof NewApiBridgeError && error.code === 'malformed_response'
  );
});

test('New API client rejects malformed usage summary model distribution', async () => {
  const client = createNewApiClient({
    baseUrl: 'https://newapi.apipool.dev',
    adminToken: 'secret',
    fetcher: async () =>
      Response.json({
        requestCount: 1,
        inputTokens: 12,
        outputTokens: 8,
        byModel: [{ modelId: 'gpt-4o-mini', requests: '1', tokens: 20 }],
      }),
  });

  await assert.rejects(
    () => client.getUsageSummary('user_1', '7d'),
    (error) =>
      error instanceof NewApiBridgeError && error.code === 'malformed_response'
  );
});
