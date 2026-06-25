import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createNewApiClient,
  NewApiBridgeError,
} from '@/features/newapi-bridge/server/client';

const USER = { newapiUserId: '2', accessToken: 'user-token' };

type Handler = (req: Request) => Response | Promise<Response>;

function ok(data: unknown) {
  return Response.json({ success: true, message: '', data });
}

function fail(message: string) {
  return Response.json({ success: false, message });
}

function createMockedClient(
  routes: Record<string, Handler>,
  options: Record<string, unknown> = {}
) {
  const requests: Request[] = [];
  const client = createNewApiClient({
    baseUrl: 'http://newapi-internal:3000',
    adminToken: 'admin-token',
    adminUserId: '1',
    quotaPerUnit: 500_000,
    maxRetries: 0,
    ...options,
    fetcher: async (input, init) => {
      const req = new Request(input, init);
      requests.push(req);
      const url = new URL(req.url);
      const route = `${req.method} ${url.pathname}`;
      const handler = routes[route];
      if (!handler) {
        throw new Error(`Unexpected request: ${route}`);
      }
      return handler(req);
    },
  });
  return { client, requests };
}

test('health check hits public status endpoint without auth headers', async () => {
  const { client, requests } = createMockedClient({
    'GET /api/status': () => ok({ version: 'v1.0.0-rc.10' }),
  });

  const health = await client.healthCheck();

  assert.equal(health.ok, true);
  assert.equal(health.version, 'v1.0.0-rc.10');
  assert.equal(requests[0].headers.get('authorization'), null);
  assert.equal(requests[0].headers.get('new-api-user'), null);
});

test('admin requests carry bearer token and New-Api-User headers', async () => {
  const { client, requests } = createMockedClient({
    'GET /api/user/search': () =>
      ok({ items: [{ id: 7, username: 'pu_abc', quota: 0 }] }),
  });

  await assert.rejects(() =>
    client.provisionUser({ username: 'missing_user', password: 'pw' })
  );

  assert.equal(
    requests[0].headers.get('authorization'),
    'Bearer admin-token'
  );
  assert.equal(requests[0].headers.get('new-api-user'), '1');
});

test('provisionUser creates, looks up, logs in, and returns the access token', async () => {
  let created = false;
  const { client, requests } = createMockedClient({
    'GET /api/user/search': () =>
      created
        ? ok({ items: [{ id: 9, username: 'pu_new', quota: 0 }] })
        : ok({ items: [] }),
    'POST /api/user/': () => {
      created = true;
      return ok(null);
    },
    'POST /api/user/login': () =>
      new Response(
        JSON.stringify({ success: true, message: '', data: { id: 9 } }),
        {
          status: 200,
          headers: {
            'content-type': 'application/json',
            'set-cookie': 'session=abc123; Path=/; HttpOnly',
          },
        }
      ),
    'GET /api/user/token': (req) => {
      assert.equal(req.headers.get('cookie'), 'session=abc123');
      assert.equal(req.headers.get('new-api-user'), '9');
      return ok('fresh-access-token');
    },
  });

  const result = await client.provisionUser({
    username: 'pu_new',
    password: 'strong-password',
  });

  assert.deepEqual(result, {
    newapiUserId: '9',
    accessToken: 'fresh-access-token',
  });
  const createReq = requests.find(
    (req) => req.method === 'POST' && new URL(req.url).pathname === '/api/user/'
  );
  assert.deepEqual(await createReq!.json(), {
    username: 'pu_new',
    password: 'strong-password',
    display_name: 'pu_new',
  });
});

test('provisionUser reuses an existing remote user without re-creating it', async () => {
  const { client, requests } = createMockedClient({
    'GET /api/user/search': () =>
      ok({ items: [{ id: 5, username: 'pu_existing', quota: 0 }] }),
    'POST /api/user/login': () =>
      new Response(JSON.stringify({ success: true, data: { id: 5 } }), {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'set-cookie': 'session=zzz',
        },
      }),
    'GET /api/user/token': () => ok('token-after-recovery'),
  });

  const result = await client.provisionUser({
    username: 'pu_existing',
    password: 'pw',
  });

  assert.equal(result.newapiUserId, '5');
  assert.equal(
    requests.some(
      (req) =>
        req.method === 'POST' && new URL(req.url).pathname === '/api/user/'
    ),
    false,
    'should not call create for an existing user'
  );
});

test('createKey creates a remote token and fetches the full key with sk- prefix', async () => {
  let createdToken: any;
  const { client, requests } = createMockedClient({
    'GET /api/token/': () => ok({ items: createdToken ? [createdToken] : [] }),
    'POST /api/token/': async (req) => {
      const body = await req.clone().json();
      createdToken = {
        id: 31,
        name: body.name,
        key: 'x7UW****msmm',
        status: 1,
      };
      return ok(null);
    },
    'POST /api/token/31/key': () => ok({ key: 'fullplainkey1234' }),
  });

  const result = await client.createKey({
    user: USER,
    remoteName: 'pk_abc123',
    group: 'ng-official',
    allowedModels: ['gpt-4o-mini'],
  });

  assert.equal(result.id, '31');
  assert.equal(result.key, 'sk-fullplainkey1234');
  assert.equal(result.status, 'active');
  assert.match(result.maskedKey, /\*{4,}/);

  const createReq = requests.find(
    (req) =>
      req.method === 'POST' && new URL(req.url).pathname === '/api/token/'
  );
  const body = await createReq!.json();
  assert.equal(body.name, 'pk_abc123');
  assert.equal(body.model_limits_enabled, true);
  assert.equal(body.model_limits, 'gpt-4o-mini');
  assert.equal(body.unlimited_quota, true);
  assert.equal(body.group, 'ng-official');
  assert.equal(createReq!.headers.get('authorization'), 'Bearer user-token');
  assert.equal(createReq!.headers.get('new-api-user'), '2');
});

test('createKey reuses an existing remote token with the same name (portal-side idempotency)', async () => {
  const { client, requests } = createMockedClient({
    'GET /api/token/': () =>
      ok({ items: [{ id: 8, name: 'pk_retry', key: 'mask', status: 1 }] }),
    'POST /api/token/8/key': () => ok({ key: 'recoveredkey' }),
  });

  const result = await client.createKey({ user: USER, remoteName: 'pk_retry' });

  assert.equal(result.id, '8');
  assert.equal(result.key, 'sk-recoveredkey');
  assert.equal(
    requests.some(
      (req) =>
        req.method === 'POST' && new URL(req.url).pathname === '/api/token/'
    ),
    false,
    'should not create a duplicate token'
  );
});

test('listKeys maps remote token status to bridge statuses', async () => {
  const { client } = createMockedClient({
    'GET /api/token/': () =>
      ok({
        items: [
          { id: 1, name: 'a', key: 'mask-a', status: 1 },
          { id: 2, name: 'b', key: 'mask-b', status: 2 },
        ],
      }),
  });

  const keys = await client.listKeys(USER);

  assert.deepEqual(keys, [
    { id: '1', maskedKey: 'mask-a', status: 'active' },
    { id: '2', maskedKey: 'mask-b', status: 'disabled' },
  ]);
});

test('disableKey uses status_only update with numeric id', async () => {
  const { client, requests } = createMockedClient({
    'PUT /api/token/': (req) => {
      const url = new URL(req.url);
      assert.equal(url.searchParams.get('status_only'), 'true');
      return ok({ id: 31, name: 'pk_abc', key: 'mask', status: 2 });
    },
  });

  const result = await client.disableKey(USER, '31');

  assert.equal(result.status, 'disabled');
  assert.deepEqual(await requests[0].json(), { id: 31, status: 2 });
});

test('getQuota converts integer quota into USD balance', async () => {
  const { client } = createMockedClient({
    'GET /api/user/self': () => ok({ id: 2, quota: 1_250_000 }),
  });

  const quota = await client.getQuota(USER);

  assert.equal(quota.quotaRemaining, 1_250_000);
  assert.equal(quota.balanceUsd, 2.5);
});

test('getUsageSummary aggregates dashboard rows and splits tokens from logs', async () => {
  const { client } = createMockedClient({
    'GET /api/data/self': () =>
      ok([
        {
          model_name: 'gpt-4o-mini',
          count: 3,
          quota: 500_000,
          token_used: 900,
        },
        {
          model_name: 'gpt-4o-mini',
          count: 1,
          quota: 250_000,
          token_used: 100,
        },
      ]),
    'GET /api/log/self': () =>
      ok({
        items: [
          {
            id: 11,
            token_name: 'pk_abc',
            model_name: 'gpt-4o-mini',
            prompt_tokens: 700,
            completion_tokens: 300,
            quota: 750_000,
            created_at: 1_781_252_611,
          },
        ],
      }),
  });

  const summary = await client.getUsageSummary(USER, '7d');

  assert.equal(summary.requestCount, 4);
  assert.equal(summary.spendUsd, 1.5);
  assert.equal(summary.inputTokens, 700);
  assert.equal(summary.outputTokens, 300);
  assert.deepEqual(summary.byModel, [
    { modelId: 'gpt-4o-mini', requests: 4, tokens: 1000, spendUsd: 1.5 },
  ]);
});

test('getUsageSummary falls back to logs when dashboard aggregation lags', async () => {
  const { client } = createMockedClient({
    'GET /api/data/self': () => ok([]),
    'GET /api/log/self': () =>
      ok({
        items: [
          {
            id: 21,
            token_name: 'pk_abc',
            model_name: 'gpt-4o-mini',
            prompt_tokens: 12,
            completion_tokens: 3,
            quota: 250_000,
            created_at: 1_781_252_611,
          },
        ],
      }),
  });

  const summary = await client.getUsageSummary(USER, '7d');

  assert.equal(summary.requestCount, 1);
  assert.equal(summary.spendUsd, 0.5);
  assert.deepEqual(summary.byModel, [
    { modelId: 'gpt-4o-mini', requests: 1, tokens: 15, spendUsd: 0.5 },
  ]);
});

test('listUsageLogs maps consumption logs with USD spend', async () => {
  const { client, requests } = createMockedClient({
    'GET /api/log/self': () =>
      ok({
        items: [
          {
            id: 11,
            token_name: 'pk_abc',
            model_name: 'gpt-4o-mini',
            prompt_tokens: 12,
            completion_tokens: 34,
            quota: 250_000,
            created_at: 1_781_252_611,
          },
        ],
      }),
  });

  const logs = await client.listUsageLogs(USER, 20);

  assert.equal(logs.length, 1);
  assert.equal(logs[0].id, '11');
  assert.equal(logs[0].keyMasked, 'pk_abc');
  assert.equal(logs[0].inputTokens, 12);
  assert.equal(logs[0].outputTokens, 34);
  assert.equal(logs[0].spendUsd, 0.5);
  const url = new URL(requests[0].url);
  assert.equal(url.searchParams.get('type'), '2');
});

test('adjustQuota issues a short-named redemption code and redeems it as the user', async () => {
  let redemptionBody: any;
  const { client } = createMockedClient({
    'POST /api/redemption/': async (req) => {
      redemptionBody = await req.json();
      return ok(['code-abc']);
    },
    'POST /api/user/topup': async (req) => {
      assert.deepEqual(await req.json(), { key: 'code-abc' });
      assert.equal(req.headers.get('authorization'), 'Bearer user-token');
      return ok(500_000);
    },
    'GET /api/user/self': () => ok({ id: 2, quota: 500_000 }),
  });

  const result = await client.adjustQuota({
    user: USER,
    amountUsd: 1,
    reason: 'manual adjustment',
    reference: 'portal-adjustment:user:abcdef',
  });

  assert.equal(result.changeId, 'code-abc');
  assert.equal(result.balanceUsd, 1);
  assert.equal(redemptionBody.quota, 500_000);
  assert.equal(redemptionBody.count, 1);
  assert.ok(
    redemptionBody.name.length <= 20,
    `redemption name must fit the 20-char limit: ${redemptionBody.name}`
  );
});

test('success=false envelopes are treated as remote errors even with HTTP 200', async () => {
  const { client } = createMockedClient({
    'GET /api/user/self': () =>
      fail('Redemption failed, please try again later'),
  });

  await assert.rejects(
    () => client.getQuota(USER),
    (error: any) =>
      error instanceof NewApiBridgeError &&
      error.code === 'remote_error' &&
      /Redemption failed/.test(error.message)
  );
});

test('HTTP auth failures map to unauthorized and are not retried', async () => {
  let calls = 0;
  const { client } = createMockedClient(
    {
      'GET /api/user/self': () => {
        calls += 1;
        return new Response('unauthorized', { status: 401 });
      },
    },
    { maxRetries: 2 }
  );

  await assert.rejects(
    () => client.getQuota(USER),
    (error: any) =>
      error instanceof NewApiBridgeError && error.code === 'unauthorized'
  );
  assert.equal(calls, 1);
});

test('transient GET failures retry but writes never retry', async () => {
  let getCalls = 0;
  let postCalls = 0;
  const { client } = createMockedClient(
    {
      'GET /api/user/self': () => {
        getCalls += 1;
        return getCalls === 1
          ? new Response('busy', { status: 429 })
          : ok({ id: 2, quota: 0 });
      },
      'POST /api/user/topup': () => {
        postCalls += 1;
        return new Response('busy', { status: 429 });
      },
      'POST /api/redemption/': () => ok(['code-1']),
    },
    { maxRetries: 2, retryDelayMs: 0 }
  );

  const quota = await client.getQuota(USER);
  assert.equal(quota.quotaRemaining, 0);
  assert.equal(getCalls, 2);

  await assert.rejects(() =>
    client.adjustQuota({
      user: USER,
      amountUsd: 1,
      reason: 'x',
      reference: 'ref-1',
    })
  );
  assert.equal(postCalls, 1, 'write operations must not auto-retry');
});

test('disabled bridge fails fast with not_configured', async () => {
  const client = createNewApiClient({
    baseUrl: 'http://newapi-internal:3000',
    adminToken: 'admin-token',
    adminUserId: '1',
    enabled: false,
    fetcher: async () => {
      throw new Error('must not reach the network');
    },
  });

  await assert.rejects(
    () => client.healthCheck(),
    (error: any) =>
      error instanceof NewApiBridgeError && error.code === 'not_configured'
  );
});

test('missing user credentials fail fast with not_configured', async () => {
  const { client } = createMockedClient({});

  await assert.rejects(
    () => client.getQuota({ newapiUserId: '2', accessToken: '' }),
    (error: any) =>
      error instanceof NewApiBridgeError && error.code === 'not_configured'
  );
});

test('malformed envelope maps to malformed_response', async () => {
  const { client } = createMockedClient({
    'GET /api/user/self': () => Response.json({ quota: 1 }),
  });

  await assert.rejects(
    () => client.getQuota(USER),
    (error: any) =>
      error instanceof NewApiBridgeError && error.code === 'malformed_response'
  );
});
