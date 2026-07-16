import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createNewApiClient,
  type NewApiUserCredentials,
} from '@/features/newapi-bridge/server/client';

const USER: NewApiUserCredentials = {
  newapiUserId: '22',
  accessToken: 'user-token',
};

function ok(data: unknown) {
  return Response.json({ success: true, message: '', data });
}

function createClient(
  handler: (request: Request) => Response | Promise<Response>
) {
  const requests: Request[] = [];
  const client = createNewApiClient({
    enabled: true,
    baseUrl: 'http://newapi.test',
    adminToken: 'admin-token',
    adminUserId: '1',
    quotaPerUnit: 500_000,
    maxRetries: 0,
    fetcher: async (input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      return handler(request);
    },
  });
  return { client, requests };
}

function tokenPage(size: number, prefix = 'unrelated') {
  return Array.from({ length: size }, (_, index) => ({
    id: `${prefix}-${index}`,
    name: `${prefix}-${index}`,
    status: 1,
  }));
}

function usageItem(overrides: Record<string, unknown> = {}) {
  return {
    id: 77,
    token_name: 'rk_gateway',
    model_name: 'gpt-5.5',
    prompt_tokens: 12,
    completion_tokens: 4,
    quota: 500_000,
    created_at: 1_781_252_611,
    ...overrides,
  };
}

test('findTokensByNameExact 翻页到底：第 2 页的同名 token 也能命中', async () => {
  const { client, requests } = createClient((request) => {
    const page = Number(new URL(request.url).searchParams.get('p'));
    if (page === 1) return ok({ items: tokenPage(100) });
    if (page === 2) {
      return ok({
        items: [
          ...tokenPage(98, 'page-two'),
          { id: 201, name: 'rk_abc', status: 1 },
          { id: 202, name: 'rk_abc', status: 2 },
        ],
      });
    }
    return ok({ items: [] });
  });

  const matches = await client.findTokensByNameExact(USER, 'rk_abc');

  assert.deepEqual(
    matches.map((item) => item.id),
    [201, 202]
  );
  assert.equal(requests.length, 3);
});

test('findTokensByNameExact 单页不足 size 即停', async () => {
  const { client, requests } = createClient(() =>
    ok({ items: [{ id: 1, name: 'rk_tail', status: 1 }] })
  );

  const matches = await client.findTokensByNameExact(USER, 'rk_tail');

  assert.equal(matches.length, 1);
  assert.equal(requests.length, 1);
});

test('getUsageLogByRequestId 精确命中并映射 requestId，未命中返回 null', async () => {
  const { client, requests } = createClient((request) => {
    const requestId = new URL(request.url).searchParams.get('request_id');
    return ok({
      items:
        requestId === 'req-from-other'
          ? [
              usageItem({
                other: JSON.stringify({ request_id: 'req-from-other' }),
              }),
            ]
          : [],
    });
  });

  const found = await client.getUsageLogByRequestId(USER, 'req-from-other');
  const missing = await client.getUsageLogByRequestId(USER, 'req-missing');

  assert.equal(found?.requestId, 'req-from-other');
  assert.equal(found?.modelId, 'gpt-5.5');
  assert.equal(found?.quota, 500_000);
  assert.equal(missing, null);
  assert.equal(new URL(requests[0].url).pathname, '/api/log/self');
});

test('listAdminUsageLogsPage 映射 requestId/username 与 full 标志', async () => {
  const items = [
    usageItem({
      username: 'portal-user',
      request_id: 'req-top-level',
    }),
    ...Array.from({ length: 99 }, (_, index) =>
      usageItem({ id: 1000 + index })
    ),
  ];
  const { client, requests } = createClient(() => ok({ items }));

  const page = await client.listAdminUsageLogsPage({
    page: 3,
    startTimestamp: 100,
    endTimestamp: 200,
  });

  assert.equal(page.full, true);
  assert.equal(page.logs[0].username, 'portal-user');
  assert.equal(page.logs[0].requestId, 'req-top-level');
  assert.equal(requests.length, 1);
  const request = requests[0];
  const url = new URL(request.url);
  assert.equal(url.pathname, '/api/log/');
  assert.equal(url.searchParams.get('p'), '3');
  assert.equal(url.searchParams.get('page_size'), '100');
  assert.equal(url.searchParams.get('start_timestamp'), '100');
  assert.equal(url.searchParams.get('end_timestamp'), '200');
  assert.equal(request.headers.get('authorization'), 'Bearer admin-token');
  assert.equal(request.headers.get('new-api-user'), '1');
});

test('listAdminUsageLogsPage 尾页 full=false 且每次调用只发一次 HTTP', async () => {
  const { client, requests } = createClient(() => ok({ items: [usageItem()] }));

  const page = await client.listAdminUsageLogsPage({
    page: 1,
    startTimestamp: 1,
    endTimestamp: 2,
  });

  assert.equal(page.full, false);
  assert.equal(requests.length, 1);
});

test('listUserUsageLogsPage 显式传 page 与时间范围并使用用户上下文', async () => {
  const { client, requests } = createClient(() =>
    ok({ items: [usageItem({ request_id: 'req-user-page' })] })
  );

  const page = await client.listUserUsageLogsPage(USER, {
    page: 7,
    startTimestamp: 300,
    endTimestamp: 400,
  });

  assert.equal(page.full, false);
  assert.equal(page.logs[0].requestId, 'req-user-page');
  const request = requests[0];
  const url = new URL(request.url);
  assert.equal(url.pathname, '/api/log/self');
  assert.equal(url.searchParams.get('p'), '7');
  assert.equal(url.searchParams.get('start_timestamp'), '300');
  assert.equal(url.searchParams.get('end_timestamp'), '400');
  assert.equal(request.headers.get('authorization'), 'Bearer user-token');
  assert.equal(request.headers.get('new-api-user'), '22');
});

test('createTokenRaw 只发一次 POST 且不查名', async () => {
  const { client, requests } = createClient(() => ok({}));

  await client.createTokenRaw(USER, {
    name: 'rk_raw',
    group: 'official',
    unlimitedQuota: true,
  });

  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, 'POST');
  assert.equal(new URL(requests[0].url).pathname, '/api/token/');
  assert.deepEqual(await requests[0].json(), {
    name: 'rk_raw',
    expired_time: -1,
    unlimited_quota: true,
    group: 'official',
  });
});

test('getTokenKey 取明文并自动补 sk- 前缀', async () => {
  const { client, requests } = createClient(() =>
    ok({ key: 'plain-token-value' })
  );

  const key = await client.getTokenKey(USER, 'token/id');

  assert.equal(key, 'sk-plain-token-value');
  assert.equal(requests[0].method, 'POST');
  assert.equal(new URL(requests[0].url).pathname, '/api/token/token%2Fid/key');
});
