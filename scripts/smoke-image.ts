#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { eq } from 'drizzle-orm';

import {
  modelPriceVersion,
  portalApiKey,
  requestLedger,
  walletAccount,
  walletLedger,
} from '@/config/db/schema';
import { db } from '@/core/db';
import type { MeterKey, MeterQuantities } from '@/features/gateway/lib/meters';
import {
  computePricingCharge,
  parsePricingSpec,
} from '@/features/gateway/lib/pricing-spec';
import { hashPortalKey } from '@/features/gateway/server/auth';
import {
  createPortalApiKey,
  disablePortalApiKey,
} from '@/features/newapi-bridge/server/portal';
import {
  applyManualAdjustment,
  ensureWalletAccount,
} from '@/features/wallet/server/ledger';
import { findUserById } from '@/shared/models/user';

import { assertSmokeIdentity, SMOKE_PORTAL_EMAIL } from './smoke-identities';

const MODEL = 'gpt-image-2';
const OFFICIAL_GROUP = 'official';
const CODEX_GROUP = 'codex-discount';

export const IMAGE_UAT_CASES = [
  {
    id: 'official-low-1k',
    group: OFFICIAL_GROUP,
    endpoint: 'generations',
    quality: 'low',
    resolution: '1k',
    n: 1,
  },
  {
    id: 'official-high-2k',
    group: OFFICIAL_GROUP,
    endpoint: 'generations',
    quality: 'high',
    resolution: '2k',
    n: 1,
  },
  {
    id: 'codex-multi-2k',
    group: CODEX_GROUP,
    endpoint: 'generations',
    resolution: '2k',
    n: 2,
  },
  {
    id: 'codex-edit-4k',
    group: CODEX_GROUP,
    endpoint: 'edits',
    resolution: '4k',
    n: 1,
  },
] as const;

type SubmittedTask = {
  taskId: string;
  requestId: string;
  apiKey: string;
  caseId: (typeof IMAGE_UAT_CASES)[number]['id'];
};

type CompletedTask = SubmittedTask & {
  body: {
    id: string;
    status: string;
    data: Array<{ url: string; expires_at: number }>;
    usage?: Record<string, unknown>;
  };
};

type ImageArtifact = {
  bytes: Uint8Array;
  contentType: string;
  sha256: string;
  hostname: string;
};

function requiredEnv(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function invariant(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(`image UAT invariant failed: ${message}`);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function submitWithCredentialRetry(
  makeRequest: () => Promise<Response>,
  caseId: string
) {
  const attempts = Number(
    process.env.APIPOOL_SMOKE_IMAGE_SUBMIT_ATTEMPTS ?? '10'
  );
  const delayMs = Number(
    process.env.APIPOOL_SMOKE_IMAGE_SUBMIT_DELAY_MS ?? '1000'
  );
  invariant(
    Number.isInteger(attempts) && attempts > 0,
    'submit attempts must be a positive integer'
  );
  invariant(
    Number.isFinite(delayMs) && delayMs >= 0,
    'submit delay must be non-negative'
  );

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const response = await makeRequest();
    const text = await response.text();
    if (response.status !== 503 || attempt === attempts) {
      return { response, text };
    }
    await sleep(delayMs);
  }

  throw new Error(`image UAT invariant failed: ${caseId} submit retry failed`);
}

export function validateObjectStorageImageUrl(raw: string, now = Date.now()) {
  const url = new URL(raw);
  invariant(url.protocol === 'https:', 'result URL must use HTTPS');
  invariant(
    !/(^|\.)apimart\.ai$/i.test(url.hostname),
    'result URL must not expose the APIMart upstream host'
  );
  invariant(
    url.searchParams.has('X-Amz-Signature') &&
      url.searchParams.has('X-Amz-Expires'),
    'result URL must be an object-storage signed URL'
  );
  const expires = Number(url.searchParams.get('X-Amz-Expires'));
  invariant(
    Number.isFinite(expires) && expires > 0,
    'signed URL expiry invalid'
  );
  const signedAt = url.searchParams.get('X-Amz-Date');
  if (signedAt && /^\d{8}T\d{6}Z$/.test(signedAt)) {
    const timestamp = Date.UTC(
      Number(signedAt.slice(0, 4)),
      Number(signedAt.slice(4, 6)) - 1,
      Number(signedAt.slice(6, 8)),
      Number(signedAt.slice(9, 11)),
      Number(signedAt.slice(11, 13)),
      Number(signedAt.slice(13, 15))
    );
    invariant(timestamp + expires * 1000 > now, 'signed URL already expired');
  }
  return url;
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
  addMeter(meters, 'input', row.uncachedInputTokens);
  addMeter(meters, 'cached_input', row.cachedReadTokens);
  addMeter(meters, 'image_input', row.imageInputTokens);
  addMeter(meters, 'cached_image_input', row.cachedImageInputTokens);
  addMeter(meters, 'image_output', row.imageOutputTokens);
  return meters;
}

async function walletBalance(userId: string) {
  const [account] = await db()
    .select()
    .from(walletAccount)
    .where(eq(walletAccount.userId, userId));
  invariant(account, `wallet missing for ${userId}`);
  return account.balanceMicroUsd;
}

async function adjustWallet(
  userId: string,
  amount: number,
  idempotencyKey: string,
  reason: string
) {
  if (amount === 0) return;
  await applyManualAdjustment({
    userId,
    signedAmountMicroUsd: amount,
    reason,
    operatorUserId: userId,
    idempotencyKey,
    audit: {
      action: 'wallet.manual_adjustment',
      targetType: 'wallet_account',
      targetId: userId,
      afterJson: { smoke: true, amount, scope: 'gpt-image-2-uat' },
    },
  });
}

async function createGroupKey(
  user: NonNullable<Awaited<ReturnType<typeof findUserById>>>,
  groupSlug: string,
  runId: string
) {
  const created = await createPortalApiKey(user, {
    name: `Image UAT ${groupSlug} ${runId}`,
    groupSlug,
  });
  invariant(created.plainKey, `${groupSlug} key did not return plaintext`);
  const [stored] = await db()
    .select({ keyHash: portalApiKey.keyHash })
    .from(portalApiKey)
    .where(eq(portalApiKey.id, created.binding.id));
  invariant(
    stored?.keyHash === hashPortalKey(created.plainKey),
    `${groupSlug} key hash mismatch`
  );
  return {
    id: created.binding.id,
    apiKey: created.plainKey,
  };
}

async function submitGeneration(input: {
  baseUrl: string;
  apiKey: string;
  caseId: SubmittedTask['caseId'];
  prompt: string;
  resolution: '1k' | '2k';
  quality?: 'low' | 'high';
  n: number;
}) {
  const { response, text } = await submitWithCredentialRetry(
    () =>
      fetch(`${input.baseUrl}/images/generations`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${input.apiKey}`,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify({
          model: MODEL,
          prompt: input.prompt,
          size: '1:1',
          resolution: input.resolution,
          ...(input.quality ? { quality: input.quality } : {}),
          n: input.n,
        }),
      }),
    input.caseId
  );
  invariant(
    response.status === 202,
    `${input.caseId} submit returned ${response.status}: ${text.slice(0, 300)}`
  );
  const body = JSON.parse(text);
  const requestId = response.headers.get('x-apipool-request-id');
  invariant(requestId, `${input.caseId} missing request id`);
  invariant(
    body?.id && body?.status === 'submitted',
    `${input.caseId} invalid task response`
  );
  return {
    taskId: String(body.id),
    requestId,
    apiKey: input.apiKey,
    caseId: input.caseId,
  } satisfies SubmittedTask;
}

async function submitEdit(input: {
  baseUrl: string;
  apiKey: string;
  source: ImageArtifact;
}) {
  const sourceBytes = input.source.bytes.buffer.slice(
    input.source.bytes.byteOffset,
    input.source.bytes.byteOffset + input.source.bytes.byteLength
  ) as ArrayBuffer;
  const { response, text } = await submitWithCredentialRetry(() => {
    const form = new FormData();
    form.append('model', MODEL);
    form.append(
      'prompt',
      'Keep the composition, but change the circle to emerald green.'
    );
    form.append('size', '1:1');
    form.append('resolution', '4k');
    form.append('n', '1');
    form.append(
      'image',
      new Blob([sourceBytes], { type: input.source.contentType }),
      'uat-source-image'
    );
    return fetch(`${input.baseUrl}/images/edits`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${input.apiKey}`,
        accept: 'application/json',
      },
      body: form,
    });
  }, 'codex-edit-4k');
  invariant(
    response.status === 202,
    `codex-edit-4k submit returned ${response.status}: ${text.slice(0, 300)}`
  );
  const body = JSON.parse(text);
  const requestId = response.headers.get('x-apipool-request-id');
  invariant(requestId, 'codex-edit-4k missing request id');
  invariant(
    body?.id && body?.status === 'submitted',
    'codex-edit-4k invalid task response'
  );
  return {
    taskId: String(body.id),
    requestId,
    apiKey: input.apiKey,
    caseId: 'codex-edit-4k',
  } satisfies SubmittedTask;
}

async function waitForTask(baseUrl: string, task: SubmittedTask) {
  const attempts = Number(process.env.APIPOOL_SMOKE_IMAGE_ATTEMPTS || '240');
  const delayMs = Number(process.env.APIPOOL_SMOKE_IMAGE_DELAY_MS || '2000');
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const response = await fetch(
      `${baseUrl}/tasks/${encodeURIComponent(task.taskId)}`,
      {
        headers: {
          authorization: `Bearer ${task.apiKey}`,
          accept: 'application/json',
        },
      }
    );
    if (response.status === 503) {
      await sleep(delayMs);
      continue;
    }
    invariant(
      response.status === 200,
      `${task.caseId} query returned ${response.status}`
    );
    const body = await response.json();
    invariant(body?.id === task.taskId, `${task.caseId} task id changed`);
    if (body.status === 'completed') {
      invariant(
        Array.isArray(body.data),
        `${task.caseId} completed without data`
      );
      return { ...task, body } as CompletedTask;
    }
    invariant(
      ['submitted', 'processing', 'meter_pending'].includes(body.status),
      `${task.caseId} reached ${body.status}: ${JSON.stringify(body.error ?? {})}`
    );
    await sleep(delayMs);
  }
  throw new Error(`image UAT invariant failed: ${task.caseId} timed out`);
}

async function inspectImage(item: { url: string; expires_at: number }) {
  invariant(
    item.expires_at * 1000 > Date.now(),
    'portal result expiry is stale'
  );
  const url = validateObjectStorageImageUrl(item.url);
  const response = await fetch(url, { headers: { accept: 'image/*' } });
  invariant(response.ok, `signed image URL returned ${response.status}`);
  const contentType = (response.headers.get('content-type') || '')
    .split(';')[0]
    .trim();
  invariant(
    contentType.startsWith('image/'),
    `unexpected image content type ${contentType}`
  );
  const bytes = new Uint8Array(await response.arrayBuffer());
  invariant(
    bytes.byteLength >= 512,
    'generated image payload is unexpectedly small'
  );
  invariant(
    bytes.byteLength <= 25 * 1024 * 1024,
    'generated image exceeds edit upload limit'
  );
  return {
    bytes,
    contentType,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    hostname: url.hostname,
  } satisfies ImageArtifact;
}

async function verifyLedger(input: {
  task: CompletedTask;
  expectedGroup: 'official' | 'codex特惠';
  expectedBasis: 'token' | 'unit';
  expectedSku?: string;
  expectedCount?: number;
  expectedCharge?: number;
}) {
  const [ledger] = await db()
    .select()
    .from(requestLedger)
    .where(eq(requestLedger.id, input.task.requestId));
  invariant(ledger, `${input.task.caseId} request ledger missing`);
  invariant(
    ledger.status === 'settled',
    `${input.task.caseId} ledger is ${ledger.status}`
  );
  invariant(
    ledger.portalModelId === MODEL,
    `${input.task.caseId} public model changed`
  );
  invariant(
    ledger.newapiGroup === input.expectedGroup,
    `${input.task.caseId} routed to ${ledger.newapiGroup}`
  );
  invariant(
    ledger.pricingBasis === input.expectedBasis,
    `${input.task.caseId} used ${ledger.pricingBasis}`
  );
  const [price] = await db()
    .select()
    .from(modelPriceVersion)
    .where(eq(modelPriceVersion.id, ledger.priceVersionId));
  invariant(price, `${input.task.caseId} immutable price snapshot missing`);
  const expected = computePricingCharge(
    parsePricingSpec(price.pricingSpecJson),
    {
      meters: metersFromLedger(ledger),
      webSearchCount: ledger.webSearchCount ?? 0,
      skuKey: ledger.skuKey,
      quantity: ledger.unitCount,
    }
  ).charged;
  invariant(
    ledger.chargedMicroUsd === Number(expected),
    `${input.task.caseId} price snapshot does not match charge`
  );
  if (input.expectedBasis === 'token') {
    invariant(
      input.task.body.usage,
      `${input.task.caseId} token usage missing from task`
    );
    invariant(
      (ledger.imageOutputTokens ?? 0) > 0,
      `${input.task.caseId} image output meter missing`
    );
  } else {
    invariant(
      ledger.skuKey === input.expectedSku,
      `${input.task.caseId} unexpected SKU ${ledger.skuKey}`
    );
    invariant(
      ledger.unitCount === input.expectedCount,
      `${input.task.caseId} output count ${ledger.unitCount}`
    );
    invariant(
      ledger.chargedMicroUsd === input.expectedCharge,
      `${input.task.caseId} charged ${ledger.chargedMicroUsd}`
    );
  }
  const charges = await db()
    .select()
    .from(walletLedger)
    .where(eq(walletLedger.requestLedgerId, ledger.id));
  invariant(
    charges.length === 1,
    `${input.task.caseId} must have one wallet charge`
  );
  invariant(
    charges[0].signedAmountMicroUsd === -ledger.chargedMicroUsd!,
    `${input.task.caseId} wallet charge mismatch`
  );
  return ledger;
}

export async function main() {
  invariant(
    process.env.APIPOOL_SMOKE_REQUIRE_LIVE === 'true',
    'APIPOOL_SMOKE_REQUIRE_LIVE=true is required'
  );
  const userId = requiredEnv('APIPOOL_SMOKE_PORTAL_USER_ID');
  const baseUrl = (
    process.env.APIPOOL_SMOKE_GATEWAY_BASE_URL || 'http://apipool-v2:3000/v1'
  ).replace(/\/$/, '');
  const user = await findUserById(userId);
  invariant(user, `smoke user not found: ${userId}`);
  assertSmokeIdentity({
    actualEmail: user.email,
    configuredEmail: requiredEnv('APIPOOL_SMOKE_PORTAL_EMAIL'),
    expectedEmail: SMOKE_PORTAL_EMAIL,
    role: 'portal',
  });

  const runId = `${Date.now()}`;
  await ensureWalletAccount(userId);
  const initialBalance = await walletBalance(userId);
  let officialKey: Awaited<ReturnType<typeof createGroupKey>> | undefined;
  let codexKey: Awaited<ReturnType<typeof createGroupKey>> | undefined;
  try {
    officialKey = await createGroupKey(user, OFFICIAL_GROUP, runId);
    codexKey = await createGroupKey(user, CODEX_GROUP, runId);
    const targetBalance = Math.max(initialBalance, 20_000_000);
    await adjustWallet(
      userId,
      targetBalance - initialBalance,
      `smoke-image:${runId}:fund`,
      'gpt-image-2 UAT temporary funding'
    );

    const submitted = await Promise.all([
      submitGeneration({
        baseUrl,
        apiKey: officialKey.apiKey,
        caseId: 'official-low-1k',
        prompt:
          'A single matte blue circle centered on a clean white background.',
        quality: 'low',
        resolution: '1k',
        n: 1,
      }),
      submitGeneration({
        baseUrl,
        apiKey: officialKey.apiKey,
        caseId: 'official-high-2k',
        prompt: 'A detailed glass sphere centered on a clean white background.',
        quality: 'high',
        resolution: '2k',
        n: 1,
      }),
      submitGeneration({
        baseUrl,
        apiKey: codexKey.apiKey,
        caseId: 'codex-multi-2k',
        prompt:
          'A minimal botanical poster with one green leaf on an ivory background.',
        resolution: '2k',
        n: 2,
      }),
    ]);
    const completed = await Promise.all(
      submitted.map((task) => waitForTask(baseUrl, task))
    );
    const byCase = new Map(completed.map((task) => [task.caseId, task]));
    const officialLow = byCase.get('official-low-1k')!;
    const officialHigh = byCase.get('official-high-2k')!;
    const codexMulti = byCase.get('codex-multi-2k')!;
    invariant(
      officialLow.body.data.length === 1,
      'official-low-1k output count'
    );
    invariant(
      officialHigh.body.data.length === 1,
      'official-high-2k output count'
    );
    invariant(codexMulti.body.data.length === 2, 'codex-multi-2k output count');
    const artifacts = new Map<string, ImageArtifact[]>();
    for (const task of completed) {
      artifacts.set(
        task.caseId,
        await Promise.all(task.body.data.map((item) => inspectImage(item)))
      );
    }

    const editSubmitted = await submitEdit({
      baseUrl,
      apiKey: codexKey.apiKey,
      source: artifacts.get('official-low-1k')![0],
    });
    const editCompleted = await waitForTask(baseUrl, editSubmitted);
    invariant(
      editCompleted.body.data.length === 1,
      'codex-edit-4k output count'
    );
    artifacts.set(
      editCompleted.caseId,
      await Promise.all(
        editCompleted.body.data.map((item) => inspectImage(item))
      )
    );

    await verifyLedger({
      task: officialLow,
      expectedGroup: 'official',
      expectedBasis: 'token',
    });
    await verifyLedger({
      task: officialHigh,
      expectedGroup: 'official',
      expectedBasis: 'token',
    });
    await verifyLedger({
      task: codexMulti,
      expectedGroup: 'codex特惠',
      expectedBasis: 'unit',
      expectedSku: 'resolution=2k',
      expectedCount: 2,
      expectedCharge: 28_000,
    });
    await verifyLedger({
      task: editCompleted,
      expectedGroup: 'codex特惠',
      expectedBasis: 'unit',
      expectedSku: 'resolution=4k',
      expectedCount: 1,
      expectedCharge: 21_000,
    });

    const crossRead = await fetch(
      `${baseUrl}/tasks/${encodeURIComponent(codexMulti.taskId)}`,
      { headers: { authorization: `Bearer ${officialKey.apiKey}` } }
    );
    invariant(crossRead.status === 404, 'task result leaked across group keys');

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
      'wallet balance does not equal ledger sum'
    );

    const safeArtifacts = [...artifacts.entries()].map(([caseId, values]) => ({
      caseId,
      images: values.map((value) => ({
        bytes: value.bytes.byteLength,
        contentType: value.contentType,
        sha256: value.sha256.slice(0, 16),
        hostname: value.hostname,
      })),
    }));
    console.log(
      JSON.stringify({
        result: 'passed',
        model: MODEL,
        groups: [OFFICIAL_GROUP, CODEX_GROUP],
        tasks: [...completed, editCompleted].map((task) => ({
          caseId: task.caseId,
          taskId: task.taskId,
          outputCount: task.body.data.length,
        })),
        artifacts: safeArtifacts,
        billing: {
          official: 'token usage',
          codex2kTwoImagesMicroUsd: 28_000,
          codex4kEditMicroUsd: 21_000,
        },
      })
    );
  } finally {
    if (officialKey) {
      await disablePortalApiKey(userId, officialKey.id).catch(() => undefined);
    }
    if (codexKey) {
      await disablePortalApiKey(userId, codexKey.id).catch(() => undefined);
    }
    const currentBalance = await walletBalance(userId);
    await adjustWallet(
      userId,
      initialBalance - currentBalance,
      `smoke-image:${runId}:restore`,
      'gpt-image-2 UAT restore initial balance'
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
