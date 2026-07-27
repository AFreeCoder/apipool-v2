import { mkdir, readdir, readFile, rm } from 'node:fs/promises';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import { join } from 'node:path';
import { createClient } from '@libsql/client';

export interface RecordedNewApiRequest {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: string;
  bodyBytes: Uint8Array;
}

export async function startMockNewApi() {
  const imageFixture = await readFile(
    join(process.cwd(), 'tests/fixtures/newapi/images-generations-runapi.json'),
    'utf8'
  );
  const requests: RecordedNewApiRequest[] = [];
  let requestSequence = 0;
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const requestBuffer = Buffer.concat(chunks);
    requests.push({
      method: req.method ?? '',
      url: req.url ?? '',
      headers: req.headers,
      body: requestBuffer.toString('utf8'),
      bodyBytes: Uint8Array.from(requestBuffer),
    });

    requestSequence += 1;
    const requestId = `mock-newapi-${requestSequence}`;
    let scenario = String(req.headers['x-test-scenario'] ?? 'normal');
    const requestBody = requestBuffer.toString('utf8');
    if (scenario === 'normal') {
      const streaming = /"stream"\s*:\s*true/.test(requestBody);
      if (req.url?.endsWith('/v1/messages')) {
        scenario = streaming ? 'messages' : 'messages-json';
      } else if (req.url?.endsWith('/v1/chat/completions') && streaming) {
        scenario = 'chat-stream';
      } else if (req.url?.endsWith('/v1/responses')) {
        scenario = 'responses-json';
      } else if (req.url?.endsWith('/v1/embeddings')) {
        scenario = 'embeddings-json';
      } else if (req.url?.startsWith('/v1/images/')) {
        scenario = 'images-fixture';
      }
    }
    res.setHeader('x-oneapi-request-id', requestId);
    res.setHeader('server', 'mock-newapi-internal');

    if (scenario === 'close') {
      req.socket.destroy();
      return;
    }
    if (scenario === 'slow-first-byte') {
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    if (scenario === 'image-slow-first-byte') {
      await new Promise((resolve) => setTimeout(resolve, 300));
      scenario = 'images-fixture';
    }
    if (scenario === '401') {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end('{"error":"runtime credential rejected by newapi"}');
      return;
    }
    if (scenario === '500') {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end('{"error":"upstream failed"}');
      return;
    }
    if (scenario === '500-stall') {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.flushHeaders();
      req.once('close', () => res.destroy());
      return;
    }
    if (scenario === 'no-usage') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"id":"cmpl-no-usage","choices":[]}');
      return;
    }
    if (scenario === 'large-json') {
      const padding = 'x'.repeat(1024 * 1024);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(`{"id":"large","padding":"${padding}"}`);
      return;
    }
    if (scenario === 'images-fixture') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(imageFixture);
      return;
    }
    if (scenario === 'image-no-usage') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        '{"created":1784000000,"data":[{"url":"https://cdn.example.invalid/generated/no-usage.png"}]}'
      );
      return;
    }
    if (scenario === 'image-no-data') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        '{"created":1784000000,"usage":{"input_tokens":2000,"output_tokens":1000,"total_tokens":3000}}'
      );
      return;
    }
    if (scenario === 'image-large-b64') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.write('{"data":[{"b64_json":"');
      const block = 'A'.repeat(1024 * 1024);
      for (let index = 0; index < 33; index += 1) res.write(block);
      res.end(
        '"}],"usage":{"input_tokens":2000,"input_tokens_details":{"text_tokens":1000,"image_tokens":1000},"output_tokens":1000,"total_tokens":3000}}'
      );
      return;
    }
    if (scenario === 'messages' || scenario.startsWith('message-')) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.flushHeaders();
      const start =
        'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":25,"cache_read_input_tokens":5,"output_tokens":1}}}\n\n';
      const delta =
        'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":77}}\n\n';
      res.write(start);
      if (scenario !== 'message-start-destroy') res.write(delta);
      if (scenario.endsWith('-destroy')) {
        setTimeout(() => res.destroy(new Error('intentional stream cut')), 10);
      } else {
        res.end();
      }
      return;
    }
    if (scenario === 'messages-json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        '{"id":"msg-ok","type":"message","role":"assistant","content":[{"type":"text","text":"pong"}],"model":"mock","stop_reason":"end_turn","usage":{"input_tokens":2,"output_tokens":3}}'
      );
      return;
    }
    if (scenario === 'responses-json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        '{"id":"resp-ok","object":"response","status":"completed","output":[],"usage":{"input_tokens":2,"output_tokens":3,"total_tokens":5}}'
      );
      return;
    }
    if (scenario === 'embeddings-json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        '{"object":"list","data":[{"object":"embedding","embedding":[0.1],"index":0}],"model":"mock","usage":{"prompt_tokens":2,"total_tokens":2}}'
      );
      return;
    }
    if (scenario === 'long-stream') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.flushHeaders();
      res.write('data: {"choices":[{"delta":{"content":"one"}}]}\n\n');
      setTimeout(() => {
        if (res.destroyed) return;
        res.end(
          'data: {"choices":[],"usage":{"prompt_tokens":2,"completion_tokens":3}}\n\n'
        );
      }, 600);
      return;
    }
    if (scenario === 'infinite') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.flushHeaders();
      res.write('data: {"choices":[{"delta":{"content":"one"}}]}\n\n');
      req.once('close', () => res.destroy());
      return;
    }
    if (scenario === 'chat-stream') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: {"choices":[{"delta":{"content":"hello"}}]}\n\n');
      res.end(
        'data: {"choices":[],"usage":{"prompt_tokens":2,"completion_tokens":3}}\n\n'
      );
      return;
    }

    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      '{"id":"cmpl-ok","choices":[],"usage":{"prompt_tokens":2,"completion_tokens":3}}'
    );
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('mock New API 未取得 TCP 地址');
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      ),
  };
}

export async function setupGatewayIntegrationDb(baseUrl: string) {
  const dbPath = join(process.cwd(), '.tmp', 'gateway-integration.db');
  await mkdir(join(process.cwd(), '.tmp'), { recursive: true });
  await rm(dbPath, { force: true });
  process.env.DATABASE_PROVIDER = 'sqlite';
  process.env.DATABASE_URL = `file:${dbPath}`;
  process.env.DB_SCHEMA_FILE = './src/config/db/schema.sqlite.ts';
  process.env.DB_SINGLETON_ENABLED = 'false';
  process.env.APIPOOL_CREDENTIALS_SECRET =
    'gateway-integration-credentials-secret';
  process.env.NEWAPI_BASE_URL = baseUrl;
  process.env.GATEWAY_MAX_INFLIGHT = '16';
  process.env.GATEWAY_RISK_SLOT_LIMIT = '10';
  process.env.GATEWAY_PARSE_BUFFER_MAX = String(2 * 1024 * 1024);

  const migrationClient = createClient({ url: `file:${dbPath}` });
  const migrationsDir = join(process.cwd(), 'src/config/db/migrations_sqlite');
  for (const file of (await readdir(migrationsDir))
    .filter((name) => name.endsWith('.sql'))
    .sort()) {
    await migrationClient.executeMultiple(
      await readFile(join(migrationsDir, file), 'utf8')
    );
  }

  const schema = await import('@/config/db/schema');
  const { db } = await import('@/core/db');
  const auth = await import('@/features/gateway/server/auth');
  const crypto = await import('@/features/newapi-bridge/server/crypto');
  const handler = await import('@/features/gateway/server/handler');
  const settlement = await import('@/features/gateway/server/settlement');
  const wallet = await import('@/features/wallet/server/ledger');
  const credentials = await import('@/features/gateway/server/credentials');
  const routing = await import('@/features/gateway/server/routing');
  const modules = {
    auth,
    credentials,
    crypto,
    db,
    handler,
    routing,
    schema,
    settlement,
    wallet,
  };

  await db().insert(schema.catalogVendor).values({
    id: 'integration-vendor',
    slug: 'integration-vendor',
    name: 'Integration Vendor',
  });
  await db().insert(schema.catalogStatus).values({
    id: 'integration-callable',
    slug: 'integration-callable',
    name: 'Integration Callable',
    isCallable: true,
  });
  await db().insert(schema.catalogCategory).values({
    id: 'integration-category',
    slug: 'integration-category',
    name: 'Integration Category',
  });
  await db().insert(schema.catalogCapability).values({
    id: 'integration-capability',
    slug: 'integration-capability',
    name: 'Integration Capability',
  });

  return {
    modules,
    close: () => migrationClient.close(),
  };
}

export async function seedGatewayFixture(
  modules: any,
  suffix: string,
  options: {
    balanceMicroUsd?: number;
    riskLimit?: number;
    bindingStatus?: string;
    credentialStatus?: string;
    runtimeKey?: string;
    newapiGroup?: string;
    modelId?: string;
    email?: string;
    billingScheme?: 'token' | 'per_call';
    tiers?: Record<string, number>;
    price?: Partial<{
      input: number;
      cached: number;
      write5m: number;
      write1h: number;
      output: number;
    }>;
  } = {}
) {
  const userId = `integration-user-${suffix}`;
  const groupId = `integration-group-${suffix}`;
  const modelPk = `integration-model-pk-${suffix}`;
  const modelId = options.modelId ?? `integration-model-${suffix}`;
  const plainKey = `sk-ap-integration-${suffix}`;
  const newapiGroup = options.newapiGroup ?? 'official';
  const runtimeKey = options.runtimeKey ?? `sk-upstream-${suffix}`;
  const billingScheme = options.billingScheme ?? 'token';
  const tiers =
    options.tiers ?? (billingScheme === 'per_call' ? { default: 300_000 } : {});
  const profileId = `integration-pricing-profile-${suffix}`;
  const imageSkuRule = {
    version: 1,
    rules: [
      {
        conditions: [{ field: 'quality', operator: 'missing' }],
        output: { type: 'sku', template: 'default' },
      },
      {
        conditions: [{ field: 'quality', operator: 'eq', value: 'auto' }],
        output: { type: 'sku', template: 'default' },
      },
      {
        conditions: [{ field: 'size', operator: 'missing' }],
        output: { type: 'sku', template: 'default' },
      },
      {
        conditions: [{ field: 'size', operator: 'eq', value: 'auto' }],
        output: { type: 'sku', template: 'default' },
      },
    ],
    fallback: {
      type: 'sku',
      template: 'quality=${quality};size=${size}',
    },
  };

  await modules
    .db()
    .insert(modules.schema.user)
    .values({
      id: userId,
      name: suffix,
      email: options.email ?? `${suffix}@gateway-integration.test`,
    });
  await modules
    .db()
    .insert(modules.schema.walletAccount)
    .values({
      userId,
      balanceMicroUsd: options.balanceMicroUsd ?? 10_000_000,
      riskLimitOverride: options.riskLimit,
    });
  await modules.db().insert(modules.schema.catalogGroup).values({
    id: groupId,
    slug: groupId,
    name: groupId,
    newapiGroup,
    newapiGroupRatioBps: 10_000,
    pricingSyncStatus: 'synced',
  });
  await modules
    .db()
    .insert(modules.schema.portalApiKey)
    .values({
      id: `integration-key-${suffix}`,
      userId,
      groupId,
      keyHash: modules.auth.hashPortalKey(plainKey),
      keyPrefix: `sk-ap-…${plainKey.slice(-4)}`,
      name: '默认 Key',
    });
  await modules
    .db()
    .insert(modules.schema.newApiUserBinding)
    .values({
      id: `integration-binding-${suffix}`,
      portalUserId: userId,
      newapiUserId: `integration-remote-user-${suffix}`,
      status: options.bindingStatus ?? 'active',
      newapiAccessTokenEnc: modules.crypto.encryptCredential(
        `integration-access-${suffix}`
      ),
    });
  await modules
    .db()
    .insert(modules.schema.catalogModel)
    .values({
      id: modelPk,
      modelId,
      displayName: modelId,
      vendorId: 'integration-vendor',
      category: billingScheme === 'per_call' ? 'image' : 'llm',
    });
  await modules
    .db()
    .insert(modules.schema.catalogModelCapability)
    .values({
      id: `integration-model-capability-${suffix}`,
      modelId: modelPk,
      capabilityId: 'integration-capability',
    });
  await modules
    .db()
    .insert(modules.schema.catalogModelPricingProfile)
    .values({
      id: profileId,
      modelId: modelPk,
      name: '集成测试售卖价',
      pricingBasis: billingScheme === 'per_call' ? 'unit' : 'token',
      quantityMeter: billingScheme === 'per_call' ? 'output_count' : null,
      skuRuleSource:
        billingScheme === 'per_call'
          ? 'when quality is missing => "default"\nwhen quality == "auto" => "default"\nwhen size is missing => "default"\nwhen size == "auto" => "default"\nelse => "quality=${quality};size=${size}"'
          : null,
      skuRuleAstJson:
        billingScheme === 'per_call' ? JSON.stringify(imageSkuRule) : null,
      compilerVersion: billingScheme === 'per_call' ? 1 : null,
      reviewedAt: new Date('2026-07-20T00:00:00Z'),
    });
  const tokenRates = [
    {
      meterKey: 'input',
      priceMicroUsd: options.price?.input ?? 1_000_000,
    },
    {
      meterKey: 'cached_input',
      priceMicroUsd: options.price?.cached ?? 500_000,
    },
    {
      meterKey: 'cache_write_5m',
      priceMicroUsd: options.price?.write5m ?? 1_250_000,
    },
    {
      meterKey: 'cache_write_1h',
      priceMicroUsd: options.price?.write1h ?? 2_000_000,
    },
    {
      meterKey: 'output',
      priceMicroUsd: options.price?.output ?? 2_000_000,
    },
  ];
  await modules
    .db()
    .insert(modules.schema.catalogModelPricingRate)
    .values(
      billingScheme === 'per_call'
        ? Object.entries(tiers).map(([skuKey, priceMicroUsd]) => ({
            id: `integration-pricing-rate-${suffix}-${skuKey}`,
            profileId,
            meterKey: 'output_count',
            skuKey,
            unitSize: 1,
            priceMicroUsd,
          }))
        : tokenRates.map((rate) => ({
            id: `integration-pricing-rate-${suffix}-${rate.meterKey}`,
            profileId,
            meterKey: rate.meterKey,
            skuKey: 'default',
            unitSize: 1_000_000,
            priceMicroUsd: rate.priceMicroUsd,
          }))
    );
  await modules
    .db()
    .insert(modules.schema.catalogModelListing)
    .values({
      id: `integration-listing-${suffix}`,
      modelId: modelPk,
      groupId,
      newapiGroup,
      pricingProfileId: profileId,
      statusId: 'integration-callable',
      inputMicroUsd: 0,
      outputMicroUsd: 0,
      priceDriftStatus: 'ok',
    });
  await modules
    .db()
    .insert(modules.schema.catalogModelPrice)
    .values({
      id: `integration-model-price-${suffix}`,
      modelId: modelPk,
      billingScheme,
      baseInputMicroUsd: options.price?.input ?? 1_000_000,
      baseCachedInputMicroUsd: options.price?.cached ?? 500_000,
      baseCacheWrite5mMicroUsd: options.price?.write5m ?? 1_250_000,
      baseCacheWrite1hMicroUsd: options.price?.write1h ?? 2_000_000,
      baseOutputMicroUsd: options.price?.output ?? 2_000_000,
      sourceSupportedEndpointTypes: JSON.stringify(
        billingScheme === 'per_call' ? ['images'] : ['messages']
      ),
      billingCapabilitiesJson: JSON.stringify(
        billingScheme === 'per_call'
          ? {}
          : {
              cached_input: true,
              cache_write: true,
              cache_ttl_split: true,
            }
      ),
      syncStatus: 'manual',
      reviewedAt: new Date('2026-07-20T00:00:00Z'),
      driftStatus: 'matched',
    });
  if (billingScheme === 'per_call') {
    for (const [skuKey, priceMicroUsd] of Object.entries(tiers)) {
      await modules
        .db()
        .insert(modules.schema.catalogModelPriceTier)
        .values({
          id: `integration-tier-${suffix}-${skuKey}`,
          modelId: modelPk,
          skuKey,
          priceMicroUsd,
        });
    }
  }
  await modules
    .db()
    .insert(modules.schema.runtimeCredential)
    .values({
      id: `integration-credential-${suffix}`,
      portalUserId: userId,
      newapiGroup,
      newapiUserId: `integration-remote-user-${suffix}`,
      remoteName: modules.credentials.buildRuntimeCredentialName(
        userId,
        newapiGroup
      ),
      newapiTokenId: `integration-token-${suffix}`,
      tokenEnc:
        (options.credentialStatus ?? 'active') === 'active'
          ? modules.crypto.encryptCredential(runtimeKey)
          : null,
      keyMasked: `sk-…${runtimeKey.slice(-4)}`,
      status: options.credentialStatus ?? 'active',
    });
  const route = await modules.routing.resolveActiveRoute(groupId, modelId);
  if (!route) throw new Error('集成测试目录未生成活动定价快照');

  return {
    credentialId: `integration-credential-${suffix}`,
    groupId,
    keyId: `integration-key-${suffix}`,
    modelId,
    plainKey,
    priceVersionId: route.priceVersionId,
    pricingProfileId: profileId,
    routeVersion: route.routeVersion,
    runtimeKey,
    userId,
  };
}

export function gatewayRequest(
  fixture: { plainKey: string; modelId: string },
  path = '/v1/chat/completions',
  scenario = 'normal',
  body?: string,
  extraHeaders: HeadersInit = {}
) {
  return new Request(`http://portal.test${path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${fixture.plainKey}`,
      'content-type': 'application/json',
      'x-test-scenario': scenario,
      ...Object.fromEntries(new Headers(extraHeaders)),
    },
    body: body ?? JSON.stringify({ model: fixture.modelId }),
  });
}
