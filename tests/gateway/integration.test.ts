import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import test from 'node:test';
import { promisify } from 'node:util';
import { and, desc, eq, inArray } from 'drizzle-orm';

import {
  gatewayRequest,
  seedGatewayFixture,
  setupGatewayIntegrationDb,
  startMockNewApi,
} from './helpers/mock-newapi';

let mock: Awaited<ReturnType<typeof startMockNewApi>>;
let modules: any;
let closeDb: () => void;
const execFileAsync = promisify(execFile);

async function runMemoryStress(
  mode: 'parser' | 'content-length' | 'chunked',
  maxOldSpaceMb: number
) {
  const runner = join(
    process.cwd(),
    'tests/gateway/helpers/memory-stress-runner.ts'
  );
  const { stdout } = await execFileAsync(
    process.execPath,
    [
      '--conditions=react-server',
      '--expose-gc',
      `--max-old-space-size=${maxOldSpaceMb}`,
      '--import=tsx',
      runner,
      mode,
    ],
    {
      maxBuffer: 1024 * 1024,
      timeout: 120_000,
    }
  );
  return JSON.parse(stdout.trim());
}

async function waitUntil(
  predicate: () => Promise<boolean> | boolean,
  timeoutMs = 1500
) {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error('等待集成测试终态超时');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

async function ledgers(userId: string) {
  return modules
    .db()
    .select()
    .from(modules.schema.requestLedger)
    .where(eq(modules.schema.requestLedger.userId, userId))
    .orderBy(desc(modules.schema.requestLedger.createdAt));
}

async function latestLedger(userId: string) {
  const [row] = await ledgers(userId);
  assert.ok(row, `用户 ${userId} 应有请求账本`);
  return row;
}

async function invoke(
  fixture: { plainKey: string; modelId: string },
  scenario = 'normal',
  path = '/v1/chat/completions',
  pathSegments = ['chat', 'completions'],
  body?: string,
  extraHeaders?: HeadersInit,
  overrides?: Record<string, unknown>
) {
  return modules.handler.handleGatewayRequest(
    gatewayRequest(fixture, path, scenario, body, extraHeaders),
    pathSegments,
    overrides
  );
}

async function consumeAndWait(response: Response, userId: string) {
  const body = await response.text();
  await waitUntil(async () => (await latestLedger(userId)).status !== 'open');
  return body;
}

async function drainAndWait(response: Response, userId: string) {
  let bytes = 0;
  const reader = response.body!.getReader();
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;
    bytes += chunk.value.byteLength;
  }
  await waitUntil(async () => (await latestLedger(userId)).status !== 'open');
  return bytes;
}

function seedImageFixture(suffix: string) {
  return seedGatewayFixture(modules, suffix, {
    billingScheme: 'per_call',
    tiers: {
      default: 300_000,
      'quality=low;size=1024x1024': 15_000,
    },
  });
}

test.before(async () => {
  mock = await startMockNewApi();
  const setup = await setupGatewayIntegrationDb(mock.baseUrl);
  modules = setup.modules;
  closeDb = setup.close;
});

test.after(async () => {
  closeDb?.();
  await mock?.close();
});

test.afterEach(() => {
  process.env.NEWAPI_BASE_URL = mock.baseUrl;
  process.env.GATEWAY_MAX_INFLIGHT = '16';
  process.env.GATEWAY_RISK_SLOT_LIMIT = '10';
  process.env.GATEWAY_PARSE_BUFFER_MAX = String(2 * 1024 * 1024);
  process.env.GATEWAY_FIRST_BYTE_TIMEOUT_MS = '120000';
  process.env.GATEWAY_STREAM_IDLE_TIMEOUT_MS = '180000';
  process.env.GATEWAY_NONSTREAM_TOTAL_TIMEOUT_MS = '300000';
  process.env.GATEWAY_HARD_TIMEOUT_MS = '3600000';
  process.env.GATEWAY_OVERDRAFT_FREEZE_MICRO_USD = '10000000';
});

test('1 非流式 chat 成功结算：金额、流水与余额闭合', async () => {
  const fixture = await seedGatewayFixture(modules, 'success-chat');
  const opening = 10_000_000;
  const response = await invoke(fixture);
  assert.equal(response.status, 200);
  assert.equal(
    await consumeAndWait(response, fixture.userId),
    '{"id":"cmpl-ok","choices":[],"usage":{"prompt_tokens":2,"completion_tokens":3}}'
  );
  const ledger = await latestLedger(fixture.userId);
  assert.equal(ledger.status, 'settled');
  assert.equal(ledger.chargedMicroUsd, 8);
  const charges = await modules
    .db()
    .select()
    .from(modules.schema.walletLedger)
    .where(eq(modules.schema.walletLedger.requestLedgerId, ledger.id));
  assert.equal(charges.length, 1);
  assert.equal(charges[0].signedAmountMicroUsd, -8);
  assert.equal(
    (await modules.wallet.getWalletAccount(fixture.userId)).balanceMicroUsd,
    opening - 8
  );
});

test('2 流式 messages 合并 message_start 与 message_delta 后结算', async () => {
  const fixture = await seedGatewayFixture(modules, 'success-messages');
  const response = await invoke(
    fixture,
    'messages',
    '/v1/messages',
    ['messages'],
    JSON.stringify({ model: fixture.modelId, stream: true })
  );
  const body = await consumeAndWait(response, fixture.userId);
  assert.match(body, /message_start/);
  assert.match(body, /message_delta/);
  const ledger = await latestLedger(fixture.userId);
  assert.equal(ledger.status, 'settled');
  assert.equal(ledger.uncachedInputTokens, 25);
  assert.equal(ledger.cachedReadTokens, 5);
  assert.equal(ledger.outputTokens, 77);
});

test('3 模型级路由：两模型按 newapiGroup 使用不同运行 Key', async () => {
  const first = await seedGatewayFixture(modules, 'route-group-a', {
    newapiGroup: 'group-a',
    runtimeKey: 'sk-upstream-group-a',
  });
  const second = await seedGatewayFixture(modules, 'route-group-b', {
    newapiGroup: 'group-b',
    runtimeKey: 'sk-upstream-group-b',
  });
  const offset = mock.requests.length;
  await consumeAndWait(await invoke(first), first.userId);
  await consumeAndWait(await invoke(second), second.userId);
  assert.deepEqual(
    mock.requests.slice(offset).map((item) => item.headers.authorization),
    ['Bearer sk-upstream-group-a', 'Bearer sk-upstream-group-b']
  );
});

test('4 目录价格变化自动生成 v2，新请求锁 v2，旧账本仍按 v1 价格', async () => {
  const fixture = await seedGatewayFixture(modules, 'route-v2', {
    price: { input: 1_000_000, output: 1_000_000 },
  });
  const admission = await import('@/features/gateway/server/admission');
  assert.equal(
    await admission.admitRequest(
      {
        id: 'preq-inflight-v1',
        userId: fixture.userId,
        portalKeyId: fixture.keyId,
        portalGroupId: fixture.groupId,
        portalModelId: fixture.modelId,
        newapiGroup: 'official',
        newapiModelId: fixture.modelId,
        credentialId: fixture.credentialId,
        routeVersion: 1,
        priceVersionId: fixture.priceVersionId,
        endpoint: 'chat_completions',
        isStream: false,
      },
      10
    ),
    true
  );
  await admission.captureRequestId('preq-inflight-v1', 'rid-inflight-v1');
  await modules
    .db()
    .update(modules.schema.catalogModelPricingRate)
    .set({ priceMicroUsd: 9_000_000 })
    .where(
      and(
        eq(
          modules.schema.catalogModelPricingRate.profileId,
          fixture.pricingProfileId
        ),
        inArray(modules.schema.catalogModelPricingRate.meterKey, [
          'input',
          'output',
        ])
      )
    );
  const current = await invoke(fixture);
  await consumeAndWait(current, fixture.userId);
  const rows = await ledgers(fixture.userId);
  assert.equal(rows[0].routeVersion, 2);
  assert.notEqual(rows[0].priceVersionId, fixture.priceVersionId);
  const [currentPrice] = await modules
    .db()
    .select()
    .from(modules.schema.modelPriceVersion)
    .where(eq(modules.schema.modelPriceVersion.id, rows[0].priceVersionId));
  assert.equal(JSON.parse(currentPrice.ratesJson).input, 9_000_000);
  assert.equal(
    await modules.settlement.settleByLedgerId('preq-inflight-v1', {
      meters: { input: 1 },
      flags: [],
      webSearchCount: 0,
      rawUsage: { prompt_tokens: 1 },
      usageSource: 'response',
    }),
    'settled'
  );
  const old = rows.find((row: any) => row.id === 'preq-inflight-v1');
  assert.equal(old?.routeVersion, 1);
  const [settledOld] = await modules
    .db()
    .select()
    .from(modules.schema.requestLedger)
    .where(eq(modules.schema.requestLedger.id, 'preq-inflight-v1'));
  assert.equal(settledOld.chargedMicroUsd, 1);
});

test('5 同用户双 Key 复用凭证，禁用 A 不影响 B', async () => {
  const fixture = await seedGatewayFixture(modules, 'key-isolation');
  const keyB = 'sk-ap-integration-key-isolation-b';
  await modules
    .db()
    .insert(modules.schema.portalApiKey)
    .values({
      id: 'integration-key-isolation-b',
      userId: fixture.userId,
      groupId: fixture.groupId,
      keyHash: modules.auth.hashPortalKey(keyB),
      keyPrefix: 'sk-ap-…on-b',
      name: 'Key B',
    });
  await modules
    .db()
    .update(modules.schema.portalApiKey)
    .set({ status: 'disabled', disabledAt: new Date() })
    .where(eq(modules.schema.portalApiKey.id, fixture.keyId));
  const denied = await invoke(fixture);
  assert.equal(denied.status, 401);
  const allowed = await invoke({ ...fixture, plainKey: keyB });
  assert.equal(allowed.status, 200);
  await consumeAndWait(allowed, fixture.userId);
  const credentials = await modules
    .db()
    .select()
    .from(modules.schema.runtimeCredential)
    .where(eq(modules.schema.runtimeCredential.portalUserId, fixture.userId));
  assert.equal(credentials.length, 1);
});

test('6 用户禁用全拒，运行凭证转 disabled 并进入退休队列', async () => {
  const fixture = await seedGatewayFixture(modules, 'user-disable');
  const portal = await import('@/features/newapi-bridge/server/portal');
  await portal.disableNewapiUserBindingForAdmin({
    portalUserId: fixture.userId,
    reason: 'integration disable',
  });
  assert.equal((await invoke(fixture)).status, 403);
  const [credential] = await modules
    .db()
    .select()
    .from(modules.schema.runtimeCredential)
    .where(eq(modules.schema.runtimeCredential.id, fixture.credentialId));
  assert.equal(credential.status, 'disabled');
  const retirement = await modules
    .db()
    .select()
    .from(modules.schema.credentialRetirement)
    .where(
      eq(modules.schema.credentialRetirement.credentialId, fixture.credentialId)
    );
  assert.equal(retirement.length, 1);
});

test('7 pending 运行 Key：首请求 503，worker 创建后重试 200', async () => {
  const fixture = await seedGatewayFixture(modules, 'credential-create', {
    credentialStatus: 'pending',
  });
  assert.equal((await invoke(fixture)).status, 503);
  const remoteName = modules.credentials.buildRuntimeCredentialName(
    fixture.userId,
    'official'
  );
  const tokens = new Map<string, any[]>();
  let createCalls = 0;
  await modules.credentials.runCredentialWorkerOnce({
    client: {
      findTokensByNameExact: async () => tokens.get(remoteName) ?? [],
      createTokenRaw: async (_credentials: any, input: any) => {
        createCalls += 1;
        tokens.set(remoteName, [
          {
            id: 'worker-token-created',
            name: input.name,
            group: input.group,
            status: 1,
          },
        ]);
      },
      getTokenKey: async () => 'sk-upstream-created-by-worker',
      disableKey: async () => ({}),
    },
    ensureBinding: async () => ({
      id: `integration-binding-credential-create`,
      portalUserId: fixture.userId,
      newapiUserId: `integration-remote-user-credential-create`,
      status: 'active',
      newapiAccessTokenEnc: modules.crypto.encryptCredential('access-worker'),
    }),
    ensureRuntimePool: async () => undefined,
  });
  assert.equal(createCalls, 1);
  const retried = await invoke(fixture);
  assert.equal(retried.status, 200);
  await consumeAndWait(retried, fixture.userId);
});

test('8 原子准入：占 9 槽后并发两请求仅一条放行', async () => {
  const fixture = await seedGatewayFixture(modules, 'atomic-admit', {
    riskLimit: 10,
  });
  const admission = await import('@/features/gateway/server/admission');
  for (let index = 0; index < 9; index += 1) {
    assert.equal(
      await admission.admitRequest(
        {
          id: `preq-atomic-seed-${index}`,
          userId: fixture.userId,
          portalKeyId: fixture.keyId,
          portalGroupId: fixture.groupId,
          portalModelId: fixture.modelId,
          newapiGroup: 'official',
          newapiModelId: fixture.modelId,
          credentialId: fixture.credentialId,
          routeVersion: 1,
          priceVersionId: fixture.priceVersionId,
          endpoint: 'chat_completions',
          isStream: false,
        },
        10
      ),
      true
    );
  }
  process.env.GATEWAY_HARD_TIMEOUT_MS = '200';
  const [first, second] = await Promise.all([
    invoke(fixture, 'infinite'),
    invoke(fixture, 'infinite'),
  ]);
  assert.deepEqual(new Set([first.status, second.status]), new Set([200, 429]));
  const blocked = first.status === 429 ? first : second;
  assert.equal(blocked.headers.get('retry-after'), '5');
  const open = first.status === 200 ? first : second;
  await assert.rejects(() => open.text());
  await waitUntil(async () => {
    const rows = await ledgers(fixture.userId);
    return rows.some((row: any) => row.status === 'failed_unbilled');
  });
});

test('9 余额 1 micro 可放行，结算转负后下一请求拒绝', async () => {
  const fixture = await seedGatewayFixture(modules, 'negative-balance', {
    balanceMicroUsd: 1,
  });
  const first = await invoke(fixture);
  assert.equal(first.status, 200);
  await consumeAndWait(first, fixture.userId);
  assert.equal(
    (await modules.wallet.getWalletAccount(fixture.userId)).balanceMicroUsd,
    -7
  );
  const second = await invoke(fixture);
  assert.equal(second.status, 429);
  assert.equal((await second.json()).error.code, 'insufficient_quota');
});

test('10 缺 usage 请求直接免单释放风险槽，后续请求可继续准入', async () => {
  const fixture = await seedGatewayFixture(modules, 'pending-slots', {
    riskLimit: 2,
  });
  for (let index = 0; index < 2; index += 1) {
    const response = await invoke(fixture, 'no-usage');
    await consumeAndWait(response, fixture.userId);
  }
  const recovered = await invoke(fixture);
  assert.equal(recovered.status, 200);
  await recovered.text();
  await waitUntil(async () => {
    const current = await ledgers(fixture.userId);
    return (
      current.length === 3 && current.every((row: any) => row.status !== 'open')
    );
  });
  const rows = await ledgers(fixture.userId);
  assert.equal(
    rows.filter((row: any) => row.status === 'failed_unbilled').length,
    2
  );
  assert.equal(rows.filter((row: any) => row.status === 'settled').length, 1);
  assert.equal(
    rows
      .filter((row: any) => row.status === 'failed_unbilled')
      .every((row: any) => row.errorCode === 'usage_missing_waived'),
    true
  );
});

test('11 透支越阈冻结；补款并 unfreeze 后恢复', async () => {
  process.env.GATEWAY_OVERDRAFT_FREEZE_MICRO_USD = '5';
  const fixture = await seedGatewayFixture(modules, 'freeze-unfreeze', {
    balanceMicroUsd: 1,
  });
  await consumeAndWait(await invoke(fixture), fixture.userId);
  assert.equal((await invoke(fixture)).status, 403);
  await modules.wallet.applyManualAdjustment({
    userId: fixture.userId,
    signedAmountMicroUsd: 100,
    operatorUserId: 'integration-operator',
    reason: '测试补款',
    idempotencyKey: 'integration-unfreeze-topup',
  });
  const freeze = await import('@/features/wallet/server/freeze');
  await freeze.unfreezeWallet({
    userId: fixture.userId,
    operatorUserId: 'integration-operator',
    reason: '风险解除',
  });
  const recovered = await invoke(fixture);
  assert.equal(recovered.status, 200);
  await consumeAndWait(recovered, fixture.userId);
});

test('12 policy B：连接未建返回 502 且零扣费', async () => {
  const fixture = await seedGatewayFixture(modules, 'connect-failed');
  process.env.NEWAPI_BASE_URL = 'http://127.0.0.1:1';
  const response = await invoke(fixture);
  assert.equal(response.status, 502);
  const ledger = await latestLedger(fixture.userId);
  assert.equal(ledger.status, 'failed_unbilled');
  const charges = await modules
    .db()
    .select()
    .from(modules.schema.walletLedger)
    .where(eq(modules.schema.walletLedger.userId, fixture.userId));
  assert.equal(charges.length, 0);
});

test('13 policy B：usage 前流中断 failed_unbilled 且零扣费', async () => {
  const fixture = await seedGatewayFixture(modules, 'stream-cut');
  const response = await invoke(
    fixture,
    'message-start-destroy',
    '/v1/messages',
    ['messages']
  );
  await assert.rejects(() => response.text());
  await waitUntil(
    async () => (await latestLedger(fixture.userId)).status !== 'open'
  );
  const ledger = await latestLedger(fixture.userId);
  assert.equal(ledger.status, 'failed_unbilled');
  assert.equal(ledger.streamAborted, true);
});

test('14 Messages 完整性分界：delta 后中断结算，start 后中断免单', async () => {
  const partial = await seedGatewayFixture(modules, 'message-partial');
  await assert.rejects(() =>
    invoke(partial, 'message-start-destroy', '/v1/messages', ['messages']).then(
      (response: Response) => response.text()
    )
  );
  await waitUntil(
    async () => (await latestLedger(partial.userId)).status !== 'open'
  );
  assert.equal((await latestLedger(partial.userId)).status, 'failed_unbilled');

  const complete = await seedGatewayFixture(modules, 'message-complete');
  await assert.rejects(() =>
    invoke(complete, 'message-complete-destroy', '/v1/messages', [
      'messages',
    ]).then((response: Response) => response.text())
  );
  await waitUntil(
    async () => (await latestLedger(complete.userId)).status !== 'open'
  );
  assert.equal((await latestLedger(complete.userId)).status, 'settled');
});

test('15 上游 500 原样透传并 failed_unbilled 不扣费', async () => {
  const fixture = await seedGatewayFixture(modules, 'upstream-500');
  const response = await invoke(fixture, '500');
  assert.equal(response.status, 500);
  assert.equal(await response.text(), '{"error":"upstream failed"}');
  assert.equal((await latestLedger(fixture.userId)).status, 'failed_unbilled');
});

test('16 上游 401 映射 502、凭证 invalid，下一请求转 503', async () => {
  const fixture = await seedGatewayFixture(modules, 'upstream-401');
  const rejected = await invoke(fixture, '401');
  assert.equal(rejected.status, 502);
  assert.doesNotMatch(await rejected.text(), /runtime credential|newapi/i);
  const [invalid] = await modules
    .db()
    .select()
    .from(modules.schema.runtimeCredential)
    .where(eq(modules.schema.runtimeCredential.id, fixture.credentialId));
  assert.equal(invalid.status, 'invalid');
  assert.equal((await invoke(fixture)).status, 503);
});

test('17 响应结算后按 New API request id 再结算保持幂等', async () => {
  const fixture = await seedGatewayFixture(modules, 'settle-idempotent');
  await consumeAndWait(await invoke(fixture), fixture.userId);
  const ledger = await latestLedger(fixture.userId);
  assert.equal(
    await modules.settlement.settleByNewapiRequestId(ledger.newapiRequestId, {
      meters: { input: 999 },
      flags: [],
      webSearchCount: 0,
      rawUsage: { prompt_tokens: 999 },
      usageSource: 'response',
    }),
    'already_finalized'
  );
  const charges = await modules
    .db()
    .select()
    .from(modules.schema.walletLedger)
    .where(eq(modules.schema.walletLedger.requestLedgerId, ledger.id));
  assert.equal(charges.length, 1);
});

test('18 上游凭证零残留，只收到运行 Key 与 identity 编码', async () => {
  const fixture = await seedGatewayFixture(modules, 'credential-strip', {
    runtimeKey: 'sk-upstream-test',
  });
  const offset = mock.requests.length;
  const response = await invoke(
    fixture,
    'normal',
    undefined,
    undefined,
    undefined,
    {
      'x-api-key': 'sk-ap-leaked-backup',
      cookie: 'session=secret',
    }
  );
  await consumeAndWait(response, fixture.userId);
  const received = mock.requests[offset];
  assert.equal(received.headers.authorization, 'Bearer sk-upstream-test');
  assert.equal(received.headers['x-api-key'], undefined);
  assert.equal(received.headers.cookie, undefined);
  assert.equal(received.headers['accept-encoding'], 'identity');
  assert.doesNotMatch(JSON.stringify(received.headers), /sk-ap-/);
});

test('19 下游响应剥离内部头，错误体不泄漏路由语境', async () => {
  const fixture = await seedGatewayFixture(modules, 'response-sanitize');
  const response = await invoke(fixture);
  assert.equal(response.headers.get('x-oneapi-request-id'), null);
  assert.equal(response.headers.get('server'), null);
  assert.ok(response.headers.get('x-apipool-request-id'));
  await consumeAndWait(response, fixture.userId);
  const missing = await invoke(
    fixture,
    'normal',
    undefined,
    undefined,
    JSON.stringify({ model: 'missing-model' })
  );
  assert.doesNotMatch(await missing.text(), /official|newapi/i);
});

test('20 /v1/models 只列全链就绪模型，无 Key 返回 401', async () => {
  const fixture = await seedGatewayFixture(modules, 'models-list');
  const authorized = await modules.handler.handleGatewayRequest(
    new Request('http://portal.test/v1/models', {
      headers: { authorization: `Bearer ${fixture.plainKey}` },
    }),
    ['models']
  );
  assert.equal(authorized.status, 200);
  const ids = (await authorized.json()).data.map((item: any) => item.id);
  assert.deepEqual(ids, [fixture.modelId]);
  const denied = await modules.handler.handleGatewayRequest(
    new Request('http://portal.test/v1/models'),
    ['models']
  );
  assert.equal(denied.status, 401);
});

test('21 首包超时只约束响应头，600ms 长流可完整结算', async () => {
  process.env.GATEWAY_FIRST_BYTE_TIMEOUT_MS = '200';
  process.env.GATEWAY_STREAM_IDLE_TIMEOUT_MS = '1000';
  const fixture = await seedGatewayFixture(modules, 'long-stream');
  const response = await invoke(fixture, 'long-stream');
  const body = await consumeAndWait(response, fixture.userId);
  assert.match(body, /prompt_tokens/);
  assert.equal((await latestLedger(fixture.userId)).status, 'settled');
});

test('22 hard timeout 终止无限流并按 policy B 免单', async () => {
  process.env.GATEWAY_HARD_TIMEOUT_MS = '150';
  process.env.GATEWAY_STREAM_IDLE_TIMEOUT_MS = '1000';
  const fixture = await seedGatewayFixture(modules, 'hard-timeout');
  const response = await invoke(fixture, 'infinite');
  await assert.rejects(() => response.text());
  await waitUntil(
    async () => (await latestLedger(fixture.userId)).status !== 'open'
  );
  assert.equal((await latestLedger(fixture.userId)).status, 'failed_unbilled');
});

test('23 慢请求体占满并发后超时自愈', async () => {
  process.env.GATEWAY_MAX_INFLIGHT = '1';
  process.env.GATEWAY_STREAM_IDLE_TIMEOUT_MS = '50';
  const fixture = await seedGatewayFixture(modules, 'slow-request-body');
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{'));
    },
    cancel() {
      cancelled = true;
    },
  });
  const slowRequest = new Request('http://portal.test/v1/chat/completions', {
    method: 'POST',
    headers: { authorization: `Bearer ${fixture.plainKey}` },
    body,
    duplex: 'half',
  } as RequestInit);
  const firstPromise = modules.handler.handleGatewayRequest(slowRequest, [
    'chat',
    'completions',
  ]);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal((await invoke(fixture)).status, 429);
  const timedOut = await firstPromise;
  assert.equal(timedOut.status, 408);
  assert.equal(cancelled, true);
  const recovered = await invoke(fixture);
  assert.notEqual(recovered.status, 429);
  await consumeAndWait(recovered, fixture.userId);
});

test('24 非流式大响应保持流式透传，扫描超窗按缺 usage 免单', async () => {
  process.env.GATEWAY_PARSE_BUFFER_MAX = '65536';
  const fixture = await seedGatewayFixture(modules, 'large-response');
  const response = await invoke(fixture, 'large-json');
  const body = await consumeAndWait(response, fixture.userId);
  assert.ok(body.length > 1024 * 1024);
  const ledger = await latestLedger(fixture.userId);
  assert.equal(ledger.status, 'failed_unbilled');
  assert.equal(ledger.errorCode, 'usage_missing_waived');
  assert.deepEqual(JSON.parse(ledger.billingFlagsJson), [
    'usage_missing_waived',
  ]);
});

test('25 finalize DB busy 有界重试，穷尽后进程存活且可收敛', async () => {
  const fixture = await seedGatewayFixture(modules, 'finalize-busy');
  let attempts = 0;
  const recovered = await invoke(
    fixture,
    'normal',
    undefined,
    undefined,
    undefined,
    undefined,
    {
      settle: async (id: string, input: any) => {
        attempts += 1;
        if (attempts === 1) throw new Error('SQLITE_BUSY');
        return modules.settlement.settleByLedgerId(id, input);
      },
      terminalRetryDelaysMs: [0, 0, 0],
    }
  );
  await consumeAndWait(recovered, fixture.userId);
  assert.equal(attempts, 2);

  const exhausted = await seedGatewayFixture(modules, 'finalize-exhausted');
  const originalError = console.error;
  console.error = () => {};
  try {
    const response = await invoke(
      exhausted,
      'normal',
      undefined,
      undefined,
      undefined,
      undefined,
      {
        settle: async () => {
          throw new Error('SQLITE_BUSY');
        },
        terminalRetryDelaysMs: [0, 0, 0],
      }
    );
    await response.text();
    await new Promise((resolve) => setTimeout(resolve, 20));
  } finally {
    console.error = originalError;
  }
  const open = await latestLedger(exhausted.userId);
  assert.equal(open.status, 'open');
  assert.equal(
    await modules.settlement.settleByLedgerId(open.id, {
      meters: { input: 2, output: 3 },
      flags: [],
      webSearchCount: 0,
      rawUsage: { prompt_tokens: 2, completion_tokens: 3 },
      usageSource: 'response',
    }),
    'settled'
  );
});

test('26 重复或转义 model 键端到端 400，零转发零账本', async () => {
  const fixture = await seedGatewayFixture(modules, 'duplicate-model');
  const before = mock.requests.length;
  for (const body of [
    `{"model":"${fixture.modelId}","model":"expensive"}`,
    `{"model":"${fixture.modelId}","\\u006dodel":"expensive"}`,
  ]) {
    const response = await invoke(
      fixture,
      'normal',
      undefined,
      undefined,
      body
    );
    assert.equal(response.status, 400);
  }
  assert.equal(mock.requests.length, before);
  assert.equal((await ledgers(fixture.userId)).length, 0);
});

test('27 非 2xx 零 chunk body 仍受计时器控制且释放并发槽', async () => {
  process.env.GATEWAY_MAX_INFLIGHT = '1';
  process.env.GATEWAY_NONSTREAM_TOTAL_TIMEOUT_MS = '50';
  const fixture = await seedGatewayFixture(modules, 'slow-500');
  const response = await invoke(fixture, '500-stall');
  assert.equal(response.status, 500);
  await assert.rejects(() => response.text());
  await waitUntil(
    async () =>
      (await latestLedger(fixture.userId)).status === 'failed_unbilled'
  );
  const recovered = await invoke(fixture);
  assert.notEqual(recovered.status, 429);
  await consumeAndWait(recovered, fixture.userId);
});

test('28 Sec-WebSocket-Protocol 备用凭证被剥离', async () => {
  const fixture = await seedGatewayFixture(modules, 'websocket-secret');
  const offset = mock.requests.length;
  const response = await invoke(
    fixture,
    'normal',
    undefined,
    undefined,
    undefined,
    { 'sec-websocket-protocol': 'openai-insecure-api-key.leaked-token' }
  );
  await consumeAndWait(response, fixture.userId);
  const headers = mock.requests[offset].headers;
  assert.equal(headers['sec-websocket-protocol'], undefined);
  assert.doesNotMatch(JSON.stringify(headers), /leaked-token/);
  assert.equal(headers.authorization, `Bearer ${fixture.runtimeKey}`);
});

test('29 准入后 forward 非预期异常收束账本并释放槽', async () => {
  process.env.GATEWAY_MAX_INFLIGHT = '1';
  const fixture = await seedGatewayFixture(modules, 'forward-throw');
  const originalError = console.error;
  console.error = () => {};
  try {
    const response = await invoke(
      fixture,
      'normal',
      undefined,
      undefined,
      undefined,
      undefined,
      {
        forward: async () => {
          throw new Error('unexpected forward failure');
        },
        terminalRetryDelaysMs: [0, 0, 0],
      }
    );
    assert.equal(response.status, 500);
  } finally {
    console.error = originalError;
  }
  assert.equal((await latestLedger(fixture.userId)).status, 'failed_unbilled');
  const recovered = await invoke(fixture);
  assert.notEqual(recovered.status, 429);
  await consumeAndWait(recovered, fixture.userId);
});

test('30 巨串与重复 model flood 在 256MB 约束目标下保持零分配扫描语义', async () => {
  const result = await runMemoryStress('parser', 256);
  assert.deepEqual(
    {
      mode: result.mode,
      bodies: result.bodies,
      bodySize: result.bodySize,
    },
    {
      mode: 'parser',
      bodies: 6,
      bodySize: 25 * 1024 * 1024,
    }
  );
});

test('31 聚合入站内存有界：CL/无 CL 统一单块、正常截断、超限 cancel', async () => {
  const { readBodyBounded } = modules.handler;
  const withContentLength = await runMemoryStress('content-length', 768);
  const chunked = await runMemoryStress('chunked', 768);
  assert.equal(withContentLength.count, 16);
  assert.equal(chunked.count, 16);
  assert.equal(withContentLength.bodySize, 25 * 1024 * 1024);
  assert.equal(chunked.bodySize, 25 * 1024 * 1024);

  const small = new Request('http://portal.test/v1/chat/completions', {
    method: 'POST',
    body: new TextEncoder().encode('small-body'),
  });
  const smallResult = await readBodyBounded(small, 1024, {
    idleMs: 1000,
    totalMs: 1000,
    signal: new AbortController().signal,
  });
  assert.equal(smallResult.ok, true);
  if (smallResult.ok) {
    assert.equal(new TextDecoder().decode(smallResult.body), 'small-body');
  }

  let cancelled = false;
  const oversized = new Request('http://portal.test/v1/chat/completions', {
    method: 'POST',
    body: new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(800));
      },
      cancel() {
        cancelled = true;
      },
    }),
    duplex: 'half',
  } as RequestInit);
  assert.deepEqual(
    await readBodyBounded(oversized, 1024, {
      idleMs: 1000,
      totalMs: 1000,
      signal: new AbortController().signal,
    }),
    { ok: false, reason: 'over_limit' }
  );
  assert.equal(cancelled, true);
});

test('32 images generations：SKU 准入、URL fixture、token 照记与按次结算闭环', async () => {
  const fixture = await seedImageFixture('image-generation');
  const response = await invoke(
    fixture,
    'normal',
    '/v1/images/generations',
    ['images', 'generations'],
    JSON.stringify({
      model: fixture.modelId,
      prompt: 'a white cat',
      quality: 'low',
      size: '1024x1024',
      n: 2,
    })
  );
  const body = JSON.parse(await consumeAndWait(response, fixture.userId));
  assert.match(body.data[0].url, /^https:\/\/cdn\.example\.invalid\//);

  const ledger = await latestLedger(fixture.userId);
  assert.equal(ledger.endpoint, 'images_generations');
  assert.equal(ledger.billingScheme, 'per_call');
  assert.equal(ledger.skuKey, 'quality=low;size=1024x1024');
  assert.equal(ledger.unitCount, 1, '按响应实际张数，不按请求 n');
  assert.equal(ledger.uncachedInputTokens, 1000);
  assert.equal(ledger.imageInputTokens, 1000);
  assert.equal(ledger.imageOutputTokens, 1000);
  assert.equal(ledger.chargedMicroUsd, 15_000);
});

test('33 images 无 usage 但 data 可数：照常按次结算并标记', async () => {
  const fixture = await seedImageFixture('image-no-usage');
  const response = await invoke(
    fixture,
    'image-no-usage',
    '/v1/images/generations',
    ['images', 'generations'],
    JSON.stringify({
      model: fixture.modelId,
      quality: 'low',
      size: '1024x1024',
    })
  );
  await consumeAndWait(response, fixture.userId);
  const ledger = await latestLedger(fixture.userId);
  assert.equal(ledger.status, 'settled');
  assert.equal(ledger.unitCount, 1);
  assert.equal(ledger.chargedMicroUsd, 15_000);
  assert.deepEqual(JSON.parse(ledger.billingFlagsJson), ['usage_missing']);
});

test('34 images edits：multipart 任意字段顺序按原文字节转发并结算', async () => {
  const fixture = await seedImageFixture('image-edits');
  const form = new FormData();
  form.append('size', '1024x1024');
  form.append(
    'image',
    new Blob([new Uint8Array([0xff, 0x00, 0x80, 0x01])]),
    'source.bin'
  );
  form.append('prompt', 'remove the background');
  form.append('model', fixture.modelId);
  form.append('quality', 'low');
  form.append('n', '2');
  const request = new Request('http://portal.test/v1/images/edits', {
    method: 'POST',
    headers: {
      authorization: `Bearer ${fixture.plainKey}`,
      'x-test-scenario': 'images-fixture',
    },
    body: form,
  });
  const expectedBody = new Uint8Array(await request.clone().arrayBuffer());
  const expectedContentType = request.headers.get('content-type');
  const response = await modules.handler.handleGatewayRequest(request, [
    'images',
    'edits',
  ]);
  await consumeAndWait(response, fixture.userId);

  const forwarded = mock.requests.at(-1)!;
  assert.equal(forwarded.url, '/v1/images/edits');
  assert.equal(forwarded.headers['content-type'], expectedContentType);
  assert.deepEqual(forwarded.bodyBytes, expectedBody);
  const ledger = await latestLedger(fixture.userId);
  assert.equal(ledger.endpoint, 'images_edits');
  assert.equal(ledger.skuKey, 'quality=low;size=1024x1024');
  assert.equal(ledger.unitCount, 1);
  assert.equal(ledger.chargedMicroUsd, 15_000);
});

test('35 images >32MiB b64_json：跳过媒体正文后仍提取张数结算', async () => {
  process.env.GATEWAY_PARSE_BUFFER_MAX = '1024';
  const fixture = await seedImageFixture('image-large-b64');
  const response = await invoke(
    fixture,
    'image-large-b64',
    '/v1/images/generations',
    ['images', 'generations'],
    JSON.stringify({
      model: fixture.modelId,
      quality: 'low',
      size: '1024x1024',
    })
  );
  const responseBytes = await drainAndWait(response, fixture.userId);
  assert.ok(responseBytes > 32 * 1024 * 1024);
  const ledger = await latestLedger(fixture.userId);
  assert.equal(ledger.status, 'settled');
  assert.equal(ledger.unitCount, 1);
  assert.equal(ledger.chargedMicroUsd, 15_000);
});

test('36 images 慢首包越过文本预算后仍成功', async () => {
  process.env.GATEWAY_FIRST_BYTE_TIMEOUT_MS = '100';
  const fixture = await seedImageFixture('image-slow-first-byte');
  const response = await invoke(
    fixture,
    'image-slow-first-byte',
    '/v1/images/generations',
    ['images', 'generations'],
    JSON.stringify({
      model: fixture.modelId,
      quality: 'low',
      size: '1024x1024',
    })
  );
  assert.equal(response.status, 200);
  await consumeAndWait(response, fixture.userId);
  assert.equal((await latestLedger(fixture.userId)).status, 'settled');
});

test('37 images 响应无法解析张数：进入失败复核路径且不扣费', async () => {
  const fixture = await seedImageFixture('image-no-data');
  const openingBalance = (await modules.wallet.getWalletAccount(fixture.userId))
    .balanceMicroUsd;
  const response = await invoke(
    fixture,
    'image-no-data',
    '/v1/images/generations',
    ['images', 'generations'],
    JSON.stringify({
      model: fixture.modelId,
      quality: 'low',
      size: '1024x1024',
    })
  );
  await consumeAndWait(response, fixture.userId);

  const ledger = await latestLedger(fixture.userId);
  assert.equal(ledger.status, 'failed_unbilled');
  assert.equal(ledger.unitCount, null);
  assert.equal(ledger.chargedMicroUsd, null);
  assert.equal(
    (await modules.wallet.getWalletAccount(fixture.userId)).balanceMicroUsd,
    openingBalance
  );
  const charges = await modules
    .db()
    .select()
    .from(modules.schema.walletLedger)
    .where(eq(modules.schema.walletLedger.requestLedgerId, ledger.id));
  assert.equal(charges.length, 0);
});
