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

test('listPricingModels parses pricing ratios, fixed-price models, image prices, and vendors', async () => {
  const { client, requests } = createMockedClient({
    'GET /api/pricing': () =>
      Response.json({
        success: true,
        message: '',
        data: [
          {
            model_name: 'gpt-image-1',
            vendor_id: 'openai',
            quota_type: 0,
            model_ratio: 2.5,
            completion_ratio: 8,
            image_ratio: 2,
            enable_groups: ['default', 'official'],
            supported_endpoint_types: ['chat', 'image'],
          },
          {
            model_name: 'dall-e-3',
            vendor_id: 'openai',
            quota_type: 1,
            model_price: 0.04,
            completion_ratio: 0,
            supported_endpoint_types: ['image'],
          },
        ],
        vendors: {
          openai: 'OpenAI',
        },
      }),
  });

  const models = await client.listPricingModels();

  assert.deepEqual(models, [
    {
      modelId: 'gpt-image-1',
      displayName: 'gpt-image-1',
      vendorId: 'openai',
      vendorName: 'OpenAI',
      quotaType: 0,
      modelRatio: 2.5,
      modelPrice: null,
      completionRatio: 8,
      imageRatio: 2,
      source: 'ratio',
      inputMicroUsd: 5_000_000,
      outputMicroUsd: 40_000_000,
      imageInputMicroUsd: 10_000_000,
      imageOutputMicroUsd: 40_000_000,
      enabledGroups: ['default', 'official'],
      supportedEndpointTypes: ['chat', 'image'],
    },
    {
      modelId: 'dall-e-3',
      displayName: 'dall-e-3',
      vendorId: 'openai',
      vendorName: 'OpenAI',
      quotaType: 1,
      modelRatio: 0,
      modelPrice: 0.04,
      completionRatio: 0,
      imageRatio: null,
      source: 'fixed-price',
      inputMicroUsd: null,
      outputMicroUsd: null,
      imageInputMicroUsd: null,
      imageOutputMicroUsd: null,
      enabledGroups: [],
      supportedEndpointTypes: ['image'],
    },
  ]);
  assert.equal(requests[0].headers.get('authorization'), 'Bearer admin-token');
  assert.equal(requests[0].headers.get('new-api-user'), '1');
});

test('admin requests carry bearer token and New-Api-User headers', async () => {
  const { client, requests } = createMockedClient({
    'GET /api/user/search': () =>
      ok({ items: [{ id: 7, username: 'pu_abc', quota: 0 }] }),
  });

  await assert.rejects(() =>
    client.provisionUser({ username: 'missing_user', password: 'pw' })
  );

  assert.equal(requests[0].headers.get('authorization'), 'Bearer admin-token');
  assert.equal(requests[0].headers.get('new-api-user'), '1');
});

test('ensureGroup adds a missing group to the New API GroupRatio option', async () => {
  const { client, requests } = createMockedClient({
    'GET /api/option/': () =>
      ok([{ key: 'GroupRatio', value: '{"default":1,"official":1}' }]),
    'PUT /api/option/': async (req) => {
      const body = await req.clone().json();
      assert.equal(body.key, 'GroupRatio');
      assert.deepEqual(JSON.parse(body.value), {
        default: 1,
        official: 1,
        partner: 1,
      });
      return ok(null);
    },
  });

  const result = await client.ensureGroup({ group: 'partner' });

  assert.deepEqual(result, { group: 'partner', changed: true });
  assert.equal(requests.length, 2);
  assert.equal(requests[1].headers.get('authorization'), 'Bearer admin-token');
  assert.equal(requests[1].headers.get('new-api-user'), '1');
});

test('ensureGroup is idempotent when GroupRatio already contains the group', async () => {
  const { client, requests } = createMockedClient({
    'GET /api/option/': () =>
      ok([{ key: 'GroupRatio', value: '{"default":1,"partner":1}' }]),
  });

  const result = await client.ensureGroup({ group: 'partner' });

  assert.deepEqual(result, { group: 'partner', changed: false });
  assert.equal(requests.length, 1);
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

test('provisionUser assigns the requested New API user group before issuing an access token', async () => {
  let created = false;
  const { client, requests } = createMockedClient({
    'GET /api/user/search': () =>
      created
        ? ok({
            items: [
              {
                id: 9,
                username: 'pu_grouped',
                display_name: 'PU Grouped',
                group: 'default',
                role: 1,
                remark: '',
                quota: 0,
              },
            ],
          })
        : ok({ items: [] }),
    'POST /api/user/': () => {
      created = true;
      return ok(null);
    },
    'PUT /api/user/': async (req) => {
      assert.deepEqual(await req.json(), {
        id: 9,
        username: 'pu_grouped',
        display_name: 'PU Grouped',
        group: 'official',
        role: 1,
        remark: '',
      });
      return ok(null);
    },
    'POST /api/user/login': () =>
      new Response(JSON.stringify({ success: true, data: { id: 9 } }), {
        status: 200,
        headers: {
          'content-type': 'application/json',
          'set-cookie': 'session=grouped',
        },
      }),
    'GET /api/user/token': () => ok('grouped-access-token'),
  });

  const result = await client.provisionUser({
    username: 'pu_grouped',
    password: 'strong-password',
    displayName: 'PU Grouped',
    group: 'official',
  });

  assert.deepEqual(result, {
    newapiUserId: '9',
    accessToken: 'grouped-access-token',
  });
  assert.deepEqual(
    requests.map((req) => `${req.method} ${new URL(req.url).pathname}`),
    [
      'GET /api/user/search',
      'POST /api/user/',
      'GET /api/user/search',
      'PUT /api/user/',
      'POST /api/user/login',
      'GET /api/user/token',
    ]
  );
});

test('ensureUserGroup updates an existing New API user group without regenerating the access token', async () => {
  const { client, requests } = createMockedClient({
    'GET /api/user/search': () =>
      ok({
        items: [
          {
            id: 5,
            username: 'pu_existing',
            display_name: 'PU Existing',
            group: 'default',
            role: 1,
            remark: '',
            quota: 0,
          },
        ],
      }),
    'PUT /api/user/': async (req) => {
      assert.deepEqual(await req.json(), {
        id: 5,
        username: 'pu_existing',
        display_name: 'PU Existing',
        group: 'official',
        role: 1,
        remark: '',
      });
      return ok(null);
    },
  });

  await client.ensureUserGroup({
    newapiUserId: '5',
    username: 'pu_existing',
    group: 'official',
  });

  assert.deepEqual(
    requests.map((req) => `${req.method} ${new URL(req.url).pathname}`),
    ['GET /api/user/search', 'PUT /api/user/']
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

test('listKeys masks any full key returned by the remote token list', async () => {
  const { client } = createMockedClient({
    'GET /api/token/': () =>
      ok({
        items: [
          { id: 1, name: 'a', key: 'sk-live-secret-2001', status: 1 },
          { id: 2, name: 'b', key: 'live-secret-2002', status: 1 },
          { id: 3, name: 'c', key: 'mask-c', status: 1 },
        ],
      }),
  });

  const keys = await client.listKeys(USER);

  assert.equal(keys[0].maskedKey, 'sk-l**********2001');
  assert.equal(keys[1].maskedKey, 'live**********2002');
  assert.equal(keys[2].maskedKey, 'mask-c');
  assert.notEqual(keys[0].maskedKey, 'sk-live-secret-2001');
  assert.notEqual(keys[1].maskedKey, 'live-secret-2002');
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

test('disableKey masks any full key returned by the remote update response', async () => {
  const { client } = createMockedClient({
    'PUT /api/token/': () =>
      ok({ id: 31, name: 'pk_abc', key: 'live-secret-2001', status: 2 }),
  });

  const result = await client.disableKey(USER, '31');

  assert.equal(result.maskedKey, 'live**********2001');
  assert.notEqual(result.maskedKey, 'live-secret-2001');
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

test('adjustQuota decreases quota through an admin user quota update', async () => {
  let selfCalls = 0;
  let updateBody: any;
  const { client, requests } = createMockedClient({
    'GET /api/user/self': (req) => {
      selfCalls += 1;
      assert.equal(req.headers.get('authorization'), 'Bearer user-token');
      return ok({ id: 2, quota: selfCalls === 1 ? 500_000 : 250_000 });
    },
    'PUT /api/user/': async (req) => {
      updateBody = await req.json();
      assert.equal(req.headers.get('authorization'), 'Bearer admin-token');
      assert.equal(req.headers.get('new-api-user'), '1');
      return ok({ id: 2, quota: 250_000 });
    },
  });

  const result = await client.adjustQuota({
    user: USER,
    amountUsd: -0.5,
    reason: 'manual decrease',
    reference: 'portal-adjustment:user:decrease',
  });

  assert.deepEqual(updateBody, { id: 2, quota: 250_000 });
  assert.equal(result.changeId, 'portal-adjustment:user:decrease');
  assert.equal(result.balanceUsd, 0.5);
  assert.deepEqual(
    requests.map((req) => `${req.method} ${new URL(req.url).pathname}`),
    ['GET /api/user/self', 'PUT /api/user/', 'GET /api/user/self']
  );
});

test('adjustQuota serializes quota adjustments for the same New API user', async () => {
  let quota = 1_000_000;
  let firstPutCanFinish!: () => void;
  const firstPutBlocked = new Promise<void>((resolve) => {
    firstPutCanFinish = resolve;
  });
  const events: string[] = [];
  const { client } = createMockedClient({
    'GET /api/user/self': () => {
      events.push(`GET:${quota}`);
      return ok({ id: 2, quota });
    },
    'PUT /api/user/': async (req) => {
      const body = await req.json();
      events.push(`PUT:${body.quota}`);
      if (events.filter((event) => event.startsWith('PUT:')).length === 1) {
        await firstPutBlocked;
      }
      quota = body.quota;
      return ok({ id: 2, quota });
    },
    'POST /api/redemption/': () => {
      events.push('REDEMPTION');
      return ok(['code-positive']);
    },
    'POST /api/user/topup': () => {
      events.push('TOPUP');
      quota += 500_000;
      return ok(500_000);
    },
  });

  const decrease = client.adjustQuota({
    user: USER,
    amountUsd: -0.5,
    reason: 'manual decrease',
    reference: 'portal-adjustment:user:decrease-serialized',
  });
  const increase = client.adjustQuota({
    user: USER,
    amountUsd: 1,
    reason: 'manual increase',
    reference: 'portal-adjustment:user:increase-serialized',
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  firstPutCanFinish();
  await Promise.all([decrease, increase]);

  assert.deepEqual(events, [
    'GET:1000000',
    'PUT:750000',
    'GET:750000',
    'REDEMPTION',
    'TOPUP',
    'GET:1250000',
  ]);
});

test('adjustQuota marks negative quota confirmation failures for reconciliation', async () => {
  let selfCalls = 0;
  const { client } = createMockedClient({
    'GET /api/user/self': () => {
      selfCalls += 1;
      return selfCalls === 1
        ? ok({ id: 2, quota: 500_000 })
        : new Response('timeout', { status: 504 });
    },
    'PUT /api/user/': () => ok({ id: 2, quota: 250_000 }),
  });

  await assert.rejects(
    () =>
      client.adjustQuota({
        user: USER,
        amountUsd: -0.5,
        reason: 'manual decrease',
        reference: 'portal-adjustment:user:confirm-failed',
      }),
    (error: any) => {
      const candidate = error as any;
      return (
        error instanceof NewApiBridgeError &&
        candidate.reconciliationRequired === true &&
        candidate.changeId === 'portal-adjustment:user:confirm-failed'
      );
    }
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
