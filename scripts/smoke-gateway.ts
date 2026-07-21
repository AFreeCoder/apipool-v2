#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import {
  computePerCallChargeMicroUsd,
  computeTokenChargeMicroUsd,
  type RatesMap,
} from '@/features/gateway/lib/billing';
import type { MeterKey, MeterQuantities } from '@/features/gateway/lib/meters';
import { hashPortalKey } from '@/features/gateway/server/auth';
import {
  createPortalApiKey,
  disablePortalApiKey,
} from '@/features/newapi-bridge/server/portal';
import { applyManualAdjustment } from '@/features/wallet/server/ledger';
import Anthropic from '@anthropic-ai/sdk';
import { eq, inArray } from 'drizzle-orm';
import OpenAI from 'openai';

import { db } from '@/core/db';
import {
  catalogModel,
  catalogModelPrice,
  modelPriceVersion,
  portalApiKey,
  requestLedger,
  runtimeCredential,
  walletAccount,
  walletLedger,
} from '@/config/db/schema';
import { findUserById } from '@/shared/models/user';

import { assertSmokeIdentity, SMOKE_PORTAL_EMAIL } from './smoke-identities';

function requiredEnv(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function invariant(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(`gateway smoke invariant failed: ${message}`);
}

function parsePriceMap(raw: string, label: string): Record<string, number> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${label} 无法解析`, { cause: error });
  }
  invariant(
    parsed && typeof parsed === 'object' && !Array.isArray(parsed),
    `${label} must be an object`
  );
  const result: Record<string, number> = {};
  for (const [key, value] of Object.entries(parsed)) {
    invariant(
      Number.isSafeInteger(value) && Number(value) >= 0,
      `${label}.${key} must be a non-negative safe integer`
    );
    result[key] = Number(value);
  }
  return result;
}

function addMeter(
  meters: MeterQuantities,
  key: MeterKey,
  value: number | null
) {
  if (value && value > 0) meters[key] = value;
}

function metersFromLedger(row: typeof requestLedger.$inferSelect) {
  const meters: MeterQuantities = {};
  const long = row.longContextApplied === true;
  addMeter(meters, long ? 'input_long' : 'input', row.uncachedInputTokens);
  addMeter(
    meters,
    long ? 'cached_input_long' : 'cached_input',
    row.cachedReadTokens
  );
  addMeter(
    meters,
    long ? 'cache_write_long' : 'cache_write',
    row.cacheWriteTokens
  );
  addMeter(meters, 'cache_write_5m', row.cacheWrite5mTokens);
  addMeter(meters, 'cache_write_1h', row.cacheWrite1hTokens);
  addMeter(meters, long ? 'output_long' : 'output', row.outputTokens);
  addMeter(meters, 'image_input', row.imageInputTokens);
  addMeter(meters, 'cached_image_input', row.cachedImageInputTokens);
  addMeter(meters, 'image_output', row.imageOutputTokens);
  return meters;
}

function expectedLedgerCharge(
  row: typeof requestLedger.$inferSelect,
  price: typeof modelPriceVersion.$inferSelect
) {
  if (price.billingScheme === 'token') {
    const rates = parsePriceMap(price.ratesJson, 'rates_json') as RatesMap;
    return computeTokenChargeMicroUsd(metersFromLedger(row), rates, {
      webSearchCount: row.webSearchCount ?? 0,
      webSearchPriceMicroUsd: rates.web_search ?? null,
    }).charged;
  }
  invariant(price.billingScheme === 'per_call', 'unknown billing scheme');
  const tiers = parsePriceMap(price.tiersJson, 'tiers_json');
  const skuKey = row.skuKey ?? 'default';
  const unitCount = row.unitCount ?? 0;
  const tierPrice = tiers[skuKey];
  invariant(unitCount > 0, 'per_call ledger missing unit_count');
  invariant(tierPrice > 0, `per_call price missing SKU ${skuKey}`);
  return computePerCallChargeMicroUsd(unitCount, tierPrice);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type GatewaySmokeEndpoint =
  | 'chat'
  | 'responses'
  | 'messages'
  | 'embeddings'
  | 'images_generations';

export function resolveGatewaySmokeEndpoints(
  sourceSupportedEndpointTypes: string[]
): GatewaySmokeEndpoint[] {
  const types = new Set(
    sourceSupportedEndpointTypes.map((type) => type.trim().toLowerCase())
  );
  const supports = (...candidates: string[]) =>
    candidates.some((candidate) => types.has(candidate));
  const endpoints: GatewaySmokeEndpoint[] = [];

  if (supports('openai', 'chat', 'chat-completions', 'chat_completions')) {
    endpoints.push('chat', 'messages');
  } else if (supports('anthropic', 'claude', 'messages')) {
    endpoints.push('messages');
  }
  if (supports('openai-response', 'openai-responses', 'responses')) {
    endpoints.push('responses');
  }
  if (
    supports('embedding', 'embeddings', 'openai-embedding', 'openai-embeddings')
  ) {
    endpoints.push('embeddings');
  }
  if (
    supports(
      'image',
      'images',
      'image-generation',
      'images-generation',
      'images_generations'
    )
  ) {
    endpoints.push('images_generations');
  }

  return [...new Set(endpoints)];
}

export function buildLongContextSmokeInput(tokenTarget = 280_000) {
  invariant(
    Number.isSafeInteger(tokenTarget) && tokenTarget > 272_000,
    'long-context smoke target must exceed 272K tokens'
  );
  return 'hello '.repeat(tokenTarget);
}

async function loadGatewaySmokeEndpoints(model: string) {
  const [row] = await db()
    .select({
      sourceSupportedEndpointTypes:
        catalogModelPrice.sourceSupportedEndpointTypes,
    })
    .from(catalogModelPrice)
    .innerJoin(catalogModel, eq(catalogModel.id, catalogModelPrice.modelId))
    .where(eq(catalogModel.modelId, model))
    .limit(1);
  invariant(row, `catalog price metadata missing for ${model}`);

  let endpointTypes: unknown;
  try {
    endpointTypes = JSON.parse(row.sourceSupportedEndpointTypes || '[]');
  } catch {
    throw new Error(`gateway smoke endpoint metadata is invalid for ${model}`);
  }
  invariant(
    Array.isArray(endpointTypes),
    `gateway smoke endpoint metadata is not an array for ${model}`
  );
  const endpoints = resolveGatewaySmokeEndpoints(
    endpointTypes.map((type) => String(type))
  );
  invariant(endpoints.length > 0, `no supported smoke endpoint for ${model}`);
  return endpoints;
}

async function remoteTokenCount() {
  const base = requiredEnv('NEWAPI_BASE_URL').replace(/\/$/, '');
  const response = await fetch(`${base}/api/token/?p=1&size=1`, {
    headers: {
      authorization: `Bearer ${requiredEnv('NEWAPI_ADMIN_TOKEN')}`,
      'new-api-user': requiredEnv('NEWAPI_ADMIN_USER_ID'),
      accept: 'application/json',
    },
  });
  invariant(response.ok, `New API token count returned ${response.status}`);
  const payload: any = await response.json();
  const data = payload?.data ?? payload;
  const total = Number(data?.total ?? payload?.total);
  if (Number.isFinite(total)) return total;
  const items = Array.isArray(data?.items)
    ? data.items
    : Array.isArray(data)
      ? data
      : [];
  return items.length;
}

async function adjustWallet(
  userId: string,
  amount: number,
  suffix: string,
  reason: string
) {
  if (amount === 0) return;
  await applyManualAdjustment({
    userId,
    signedAmountMicroUsd: amount,
    reason,
    operatorUserId: userId,
    idempotencyKey: `smoke-gateway:${suffix}`,
    audit: {
      action: 'wallet.manual_adjustment',
      targetType: 'wallet_account',
      targetId: userId,
      afterJson: { smoke: true, amount },
    },
  });
}

async function walletBalance(userId: string) {
  const [account] = await db()
    .select()
    .from(walletAccount)
    .where(eq(walletAccount.userId, userId));
  invariant(account, `wallet missing for ${userId}`);
  return account.balanceMicroUsd;
}

async function expectGatewayStatus(
  baseUrl: string,
  apiKey: string,
  model: string,
  status: number
) {
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: 'Reply pong.' }],
      max_tokens: 8,
    }),
  });
  invariant(
    response.status === status,
    `expected HTTP ${status}, received ${response.status}`
  );
}

async function waitForSettled(ids: string[]) {
  const attempts = Number(process.env.APIPOOL_SMOKE_USAGE_ATTEMPTS || '20');
  const delay = Number(process.env.APIPOOL_SMOKE_USAGE_DELAY_MS || '1000');
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const rows = await db()
      .select()
      .from(requestLedger)
      .where(inArray(requestLedger.id, ids));
    if (
      rows.length === ids.length &&
      rows.every(
        (row: typeof requestLedger.$inferSelect) => row.status === 'settled'
      )
    ) {
      return rows;
    }
    await sleep(delay);
  }
  throw new Error(`gateway smoke requests did not settle: ${ids.join(', ')}`);
}

export async function main() {
  const userId = requiredEnv('APIPOOL_SMOKE_PORTAL_USER_ID');
  const groupSlug = process.env.APIPOOL_SMOKE_GROUP_SLUG || 'official';
  const model = requiredEnv('APIPOOL_SMOKE_MODEL');
  const baseUrl = (
    process.env.APIPOOL_SMOKE_GATEWAY_BASE_URL || 'http://127.0.0.1:3000/v1'
  ).replace(/\/$/, '');
  const user = await findUserById(userId);
  invariant(user, `smoke user not found: ${userId}`);
  assertSmokeIdentity({
    actualEmail: user.email,
    configuredEmail: requiredEnv('APIPOOL_SMOKE_PORTAL_EMAIL'),
    expectedEmail: SMOKE_PORTAL_EMAIL,
    role: 'portal',
  });
  const smokeEndpoints = await loadGatewaySmokeEndpoints(model);
  const configuredImageModel = process.env.APIPOOL_SMOKE_IMAGE_MODEL?.trim();
  const imageModel =
    configuredImageModel ||
    (smokeEndpoints.includes('images_generations') ? model : undefined);
  const longContextModel =
    process.env.APIPOOL_SMOKE_LONG_CONTEXT_MODEL?.trim() || undefined;
  if (imageModel && imageModel !== model) {
    invariant(
      (await loadGatewaySmokeEndpoints(imageModel)).includes(
        'images_generations'
      ),
      `${imageModel} does not declare images generation support`
    );
  }
  const longContextEndpoints = longContextModel
    ? await loadGatewaySmokeEndpoints(longContextModel)
    : [];

  const runId = `${Date.now()}`;
  const beforeTokenCount = await remoteTokenCount();
  const created = await createPortalApiKey(user, {
    name: `Gateway smoke ${new Date().toISOString()}`,
    groupSlug,
  });
  const keyId = created.binding.id;
  const apiKey = created.plainKey;
  invariant(apiKey, 'local key creation must return plaintext once');
  const [hashRow] = await db()
    .select({ keyHash: portalApiKey.keyHash })
    .from(portalApiKey)
    .where(eq(portalApiKey.id, keyId));
  invariant(
    hashRow?.keyHash === hashPortalKey(apiKey),
    'DB must store key hash'
  );
  invariant(
    (await remoteTokenCount()) === beforeTokenCount,
    'local key creation must make zero remote token calls'
  );

  const initialBalance = await walletBalance(userId);
  const targetBalance = Math.max(initialBalance, 100_000_000);
  await adjustWallet(
    userId,
    targetBalance - initialBalance,
    `${runId}:fund`,
    'gateway smoke temporary funding'
  );

  const requestIds: string[] = [];
  const imageRequestIds = new Set<string>();
  const longContextRequestIds = new Set<string>();
  const capture = async <T>(
    label: string,
    promise: { withResponse(): Promise<{ data: T; response: Response }> },
    consume?: (data: T) => Promise<void>
  ) => {
    const { data, response } = await promise.withResponse();
    invariant(response.status === 200, `${label} returned ${response.status}`);
    if (consume) await consume(data);
    const id = response.headers.get('x-apipool-request-id');
    invariant(id, `${label} response missing x-apipool-request-id`);
    requestIds.push(id);
    return id;
  };

  const openai = new OpenAI({ apiKey, baseURL: baseUrl });
  const anthropic = new Anthropic({
    apiKey,
    baseURL: baseUrl.replace(/\/v1$/, ''),
  });
  try {
    if (smokeEndpoints.includes('chat')) {
      await capture(
        'chat non-stream',
        openai.chat.completions.create({
          model,
          messages: [{ role: 'user', content: 'Reply pong.' }],
          max_tokens: 8,
        })
      );
    }
    if (smokeEndpoints.includes('responses')) {
      await capture(
        'responses non-stream',
        openai.responses.create({
          model,
          input: 'Reply pong.',
          max_output_tokens: 8,
        })
      );
    }
    if (smokeEndpoints.includes('messages')) {
      await capture(
        'messages non-stream',
        anthropic.messages.create({
          model,
          messages: [{ role: 'user', content: 'Reply pong.' }],
          max_tokens: 8,
        })
      );
    }
    if (smokeEndpoints.includes('embeddings')) {
      await capture(
        'embeddings non-stream',
        openai.embeddings.create({ model, input: 'gateway smoke embedding' })
      );
    }
    if (smokeEndpoints.includes('chat')) {
      await capture(
        'chat stream',
        openai.chat.completions.create({
          model,
          messages: [{ role: 'user', content: 'Reply pong.' }],
          max_tokens: 8,
          stream: true,
          stream_options: { include_usage: true },
        }),
        async (stream) => {
          for await (const _chunk of stream as any) void _chunk;
        }
      );
    }
    if (smokeEndpoints.includes('messages')) {
      await capture(
        'messages stream',
        anthropic.messages.create({
          model,
          messages: [{ role: 'user', content: 'Reply pong.' }],
          max_tokens: 8,
          stream: true,
        }),
        async (stream) => {
          for await (const _event of stream as any) void _event;
        }
      );
    }
    if (imageModel) {
      const imageRequestId = await capture(
        'images generation low',
        openai.images.generate({
          model: imageModel,
          prompt: 'A small blue circle on a white background.',
          quality: 'low',
          size: '1024x1024',
          n: 1,
        })
      );
      imageRequestIds.add(imageRequestId);
    }
    if (longContextModel) {
      const target = Number(
        process.env.APIPOOL_SMOKE_LONG_CONTEXT_TOKENS || '280000'
      );
      const input = buildLongContextSmokeInput(target);
      let longRequestId: string;
      if (longContextEndpoints.includes('responses')) {
        longRequestId = await capture(
          'responses long-context >272K',
          openai.responses.create({
            model: longContextModel,
            input,
            max_output_tokens: 8,
          })
        );
      } else if (longContextEndpoints.includes('chat')) {
        longRequestId = await capture(
          'chat long-context >272K',
          openai.chat.completions.create({
            model: longContextModel,
            messages: [{ role: 'user', content: input }],
            max_tokens: 8,
          })
        );
      } else {
        throw new Error(
          `gateway smoke invariant failed: no OpenAI long-context endpoint for ${longContextModel}`
        );
      }
      longContextRequestIds.add(longRequestId);
    }

    const rows = await waitForSettled(requestIds);
    for (const row of rows) {
      invariant(row.newapiRequestId, `${row.id} missing real newapiRequestId`);
      const [credential] = await db()
        .select({ remoteName: runtimeCredential.remoteName })
        .from(runtimeCredential)
        .where(eq(runtimeCredential.id, row.credentialId));
      const observedRuntimeName = row.newapiTokenName ?? credential?.remoteName;
      invariant(
        observedRuntimeName?.startsWith('rk_'),
        `${row.id} did not use an rk_ runtime credential`
      );
      const [price] = await db()
        .select()
        .from(modelPriceVersion)
        .where(eq(modelPriceVersion.id, row.priceVersionId));
      invariant(price, `${row.id} price snapshot missing`);
      const expected = expectedLedgerCharge(row, price);
      invariant(
        row.chargedMicroUsd === Number(expected),
        `${row.id} charged=${row.chargedMicroUsd}, expected=${expected}`
      );
      const charges = await db()
        .select()
        .from(walletLedger)
        .where(eq(walletLedger.requestLedgerId, row.id));
      invariant(charges.length === 1, `${row.id} must have one wallet charge`);
      invariant(
        charges[0].signedAmountMicroUsd === -Number(expected),
        `${row.id} wallet charge sign/amount mismatch`
      );
      if (imageRequestIds.has(row.id)) {
        invariant(
          row.billingScheme === 'per_call',
          'image smoke must per_call'
        );
        invariant(
          row.skuKey === 'quality=low;size=1024x1024',
          `image smoke unexpected sku_key ${row.skuKey}`
        );
        invariant(
          row.unitCount === 1,
          'image smoke must settle one actual image'
        );
      }
      if (longContextRequestIds.has(row.id)) {
        invariant(
          row.longContextApplied === true,
          'long-context smoke did not apply long meter rates'
        );
      }
    }
    const allWalletRows = await db()
      .select({ signed: walletLedger.signedAmountMicroUsd })
      .from(walletLedger)
      .where(eq(walletLedger.userId, userId));
    invariant(
      (await walletBalance(userId)) ===
        allWalletRows.reduce(
          (sum: number, row: { signed: number }) => sum + row.signed,
          0
        ),
      'wallet balance must equal all ledger rows'
    );

    const beforeZero = await walletBalance(userId);
    await adjustWallet(
      userId,
      -beforeZero,
      `${runId}:zero`,
      'gateway smoke insufficient quota check'
    );
    await expectGatewayStatus(baseUrl, apiKey, model, 429);
    await adjustWallet(
      userId,
      initialBalance,
      `${runId}:restore`,
      'gateway smoke restore initial balance'
    );
    await disablePortalApiKey(userId, keyId);
    await expectGatewayStatus(baseUrl, apiKey, model, 401);
    console.log(
      `Gateway smoke passed: endpoints=${smokeEndpoints.join(',')}, requests=${requestIds.length}, settled=${rows.length}, images=${imageRequestIds.size || 'skipped'}, longContext=${longContextRequestIds.size || 'skipped'}, runtime=rk_, balance=closed, key=disabled, zero=429`
    );
  } finally {
    await disablePortalApiKey(userId, keyId).catch(() => undefined);
    const currentBalance = await walletBalance(userId);
    await adjustWallet(
      userId,
      initialBalance - currentBalance,
      `${runId}:final-restore`,
      'gateway smoke final balance restore'
    );
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main().catch((error) => {
    console.error(error?.message || error);
    process.exit(1);
  });
}
