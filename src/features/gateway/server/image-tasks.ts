import 'server-only';

import { hostname } from 'node:os';
import { and, eq, inArray, isNull, lte, or } from 'drizzle-orm';

import {
  gatewayTask,
  modelPriceVersion,
  requestLedger,
} from '@/config/db/schema';
import { db } from '@/core/db';
import { normalizeUsageMeters } from '@/features/gateway/lib/billing';
import { gatewayConfig } from '@/features/gateway/lib/config';
import {
  flattenNewApiImageResult,
  parseCachedPortalResult,
  parseNewApiTaskSnapshot,
  validateImageTokenUsage,
  type NewApiTaskSnapshot,
  type PortalImageTaskResult,
} from '@/features/gateway/lib/image-task-contract';
import { parsePricingSpec } from '@/features/gateway/lib/pricing-spec';

import { ensureRuntimeCredential, markCredentialInvalid } from './credentials';
import { settleByLedgerId } from './settlement';

const TASK_LEASE_MS = 30_000;
const TASK_BATCH_SIZE = 10;
const RESULT_REFRESH_WINDOW_MS = 5 * 60_000;
const ACTIVE_STATUSES = ['submitted', 'processing', 'meter_pending'] as const;

type GatewayTaskRow = typeof gatewayTask.$inferSelect;
type RequestLedgerRow = typeof requestLedger.$inferSelect;

export async function registerAcceptedImageTask(input: {
  taskId: string;
  ledgerId: string;
  userId: string;
  portalKeyId: string;
  newapiTaskId: string;
  newapiRequestId: string;
}): Promise<void> {
  const now = new Date();
  await db().transaction(async (tx: any) => {
    const [captured] = await tx
      .update(requestLedger)
      .set({
        newapiRequestId: input.newapiRequestId,
        respondedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(requestLedger.id, input.ledgerId),
          eq(requestLedger.status, 'open'),
          isNull(requestLedger.newapiRequestId)
        )
      )
      .returning();
    if (!captured) {
      throw new Error('异步图片请求 ID 无法写入账本');
    }
    await tx.insert(gatewayTask).values({
      id: input.taskId,
      requestLedgerId: input.ledgerId,
      userId: input.userId,
      portalKeyId: input.portalKeyId,
      status: 'submitted',
      newapiTaskId: input.newapiTaskId,
      nextPollAt: now,
      submittedAt: now,
    });
  });
}

export async function registerUnknownImageSubmission(input: {
  taskId: string;
  ledgerId: string;
  userId: string;
  portalKeyId: string;
  error: string;
}): Promise<void> {
  await db().insert(gatewayTask).values({
    id: input.taskId,
    requestLedgerId: input.ledgerId,
    userId: input.userId,
    portalKeyId: input.portalKeyId,
    status: 'submission_unknown',
    lastError: input.error,
    submittedAt: new Date(),
  });
}

export function imageTaskSubmitResponse(input: {
  taskId: string;
  model: string;
  portalRequestId?: string;
  status?: 'submitted' | 'submission_unknown';
  createdAt?: Date;
}): Response {
  const createdAt = input.createdAt ?? new Date();
  return new Response(
    JSON.stringify({
      id: input.taskId,
      object: 'image_generation.task',
      status: input.status ?? 'submitted',
      model: input.model,
      created_at: Math.floor(createdAt.getTime() / 1000),
    }),
    {
      status: 202,
      headers: {
        'content-type': 'application/json',
        'cache-control': 'no-store',
        location: `/v1/tasks/${encodeURIComponent(input.taskId)}`,
        'x-apipool-task-id': input.taskId,
        ...(input.portalRequestId
          ? { 'x-apipool-request-id': input.portalRequestId }
          : {}),
      },
    }
  );
}

async function loadOwnedTask(
  taskId: string,
  userId: string,
  portalKeyId: string
): Promise<{ task: GatewayTaskRow; ledger: RequestLedgerRow } | null> {
  const [task] = await db()
    .select()
    .from(gatewayTask)
    .where(
      and(
        eq(gatewayTask.id, taskId),
        eq(gatewayTask.userId, userId),
        eq(gatewayTask.portalKeyId, portalKeyId)
      )
    )
    .limit(1);
  if (!task) return null;
  const [ledger] = await db()
    .select()
    .from(requestLedger)
    .where(eq(requestLedger.id, task.requestLedgerId))
    .limit(1);
  return ledger ? { task, ledger } : null;
}

function terminalEvidence(
  task: GatewayTaskRow
): Record<string, unknown> | null {
  if (!task.terminalEvidenceJson) return null;
  try {
    const value = JSON.parse(task.terminalEvidenceJson);
    return value && typeof value === 'object'
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function portalTaskBody(task: GatewayTaskRow, ledger: RequestLedgerRow) {
  const evidence = terminalEvidence(task);
  const result = parseCachedPortalResult(task.resultCacheJson);
  const status = task.status === 'failed_unbilled' ? 'failed' : task.status;
  return {
    id: task.id,
    object: 'image_generation.task',
    status,
    model: ledger.portalModelId,
    created_at: Math.floor(task.createdAt.getTime() / 1000),
    ...(task.completedAt
      ? { completed_at: Math.floor(task.completedAt.getTime() / 1000) }
      : {}),
    ...(result?.data ? { data: result.data } : {}),
    ...(result?.result_expires_at
      ? { result_expires_at: result.result_expires_at }
      : {}),
    ...(evidence?.usage ? { usage: evidence.usage } : {}),
    ...(task.status === 'failed_unbilled'
      ? {
          error: {
            code: 'task_failed',
            message: task.lastError ?? 'Image generation task failed.',
          },
        }
      : {}),
  };
}

function jsonTaskResponse(body: unknown, portalRequestId: string) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
      'x-apipool-request-id': portalRequestId,
    },
  });
}

export async function getOwnedImageTaskResponse(input: {
  taskId: string;
  userId: string;
  portalKeyId: string;
  portalRequestId: string;
}): Promise<Response | null> {
  let owned = await loadOwnedTask(
    input.taskId,
    input.userId,
    input.portalKeyId
  );
  if (!owned) return null;

  if (
    owned.task.status === 'completed' &&
    (!owned.task.resultUrlExpiresAt ||
      owned.task.resultUrlExpiresAt.getTime() <=
        Date.now() + RESULT_REFRESH_WINDOW_MS)
  ) {
    await refreshCompletedTaskResult(owned.task, owned.ledger).catch((error) =>
      console.warn('[gateway-task] refresh result URL failed', {
        taskId: owned?.task.id,
        error: String(error),
      })
    );
    owned = await loadOwnedTask(input.taskId, input.userId, input.portalKeyId);
    if (!owned) return null;
    if (
      !owned.task.resultUrlExpiresAt ||
      owned.task.resultUrlExpiresAt.getTime() <= Date.now()
    ) {
      return new Response(
        JSON.stringify({
          error: {
            code: 'result_url_refresh_failed',
            message: 'Result URL is temporarily unavailable. Retry shortly.',
            request_id: input.portalRequestId,
          },
        }),
        {
          status: 503,
          headers: {
            'content-type': 'application/json',
            'cache-control': 'no-store',
            'retry-after': '5',
            'x-apipool-request-id': input.portalRequestId,
          },
        }
      );
    }
  }

  return jsonTaskResponse(
    portalTaskBody(owned.task, owned.ledger),
    input.portalRequestId
  );
}

type TaskFetchResult =
  | { ok: true; snapshot: NewApiTaskSnapshot }
  | { ok: false; error: string; terminal?: boolean };

async function fetchNewApiTask(
  task: GatewayTaskRow,
  ledger: RequestLedgerRow
): Promise<TaskFetchResult> {
  if (!task.newapiTaskId) {
    return { ok: false, error: 'missing_newapi_task_id', terminal: true };
  }
  const credential = await ensureRuntimeCredential(
    task.userId,
    ledger.newapiGroup
  );
  if (credential.status !== 'ok') {
    return {
      ok: false,
      error:
        credential.status === 'disabled'
          ? 'runtime_credential_disabled'
          : 'runtime_credential_pending',
    };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(
      `${gatewayConfig().newapiBaseUrl}/v1/tasks/${encodeURIComponent(task.newapiTaskId)}`,
      {
        method: 'GET',
        headers: {
          authorization: `Bearer ${credential.runtimeKey}`,
          accept: 'application/json',
        },
        signal: controller.signal,
        redirect: 'manual',
      }
    );
    if (response.status === 401 || response.status === 403) {
      await markCredentialInvalid(
        credential.credentialId,
        `task_query_${response.status}`
      );
      return { ok: false, error: `task_query_${response.status}` };
    }
    if (!response.ok) {
      return {
        ok: false,
        error: `task_query_http_${response.status}`,
        terminal: response.status === 404 && task.pollAttempts >= 10,
      };
    }
    const parsed = parseNewApiTaskSnapshot(await response.json());
    if (!parsed.ok) return { ok: false, error: parsed.error };
    if (parsed.snapshot.id !== task.newapiTaskId) {
      return { ok: false, error: 'task_id_mismatch', terminal: true };
    }
    return parsed;
  } catch (error) {
    return { ok: false, error: `task_query_failed:${String(error)}` };
  } finally {
    clearTimeout(timer);
  }
}

function nextPollDate(attempt: number, meterPending = false): Date {
  if (meterPending) return new Date(Date.now() + 5 * 60_000);
  const delays = [2_000, 5_000, 10_000, 30_000, 60_000];
  return new Date(Date.now() + delays[Math.min(attempt, delays.length - 1)]);
}

async function retryTask(
  task: GatewayTaskRow,
  error: string | null,
  status: 'submitted' | 'processing' | 'meter_pending' = 'processing'
) {
  const attempt = task.pollAttempts + 1;
  await db()
    .update(gatewayTask)
    .set({
      status,
      processingAt:
        status === 'processing' && !task.processingAt ? new Date() : undefined,
      meterPendingAt:
        status === 'meter_pending' && !task.meterPendingAt
          ? new Date()
          : undefined,
      pollAttempts: attempt,
      nextPollAt: nextPollDate(attempt, status === 'meter_pending'),
      lastError: error,
      leaseOwner: null,
      leaseExpiresAt: null,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(gatewayTask.id, task.id),
        inArray(gatewayTask.status, [...ACTIVE_STATUSES])
      )
    );
}

async function failTaskUnbilled(
  task: GatewayTaskRow,
  ledger: RequestLedgerRow,
  error: string,
  evidence?: Record<string, unknown>
) {
  const now = new Date();
  await db().transaction(async (tx: any) => {
    const [failedLedger] = await tx
      .update(requestLedger)
      .set({
        status: 'failed_unbilled',
        errorCode: error,
        finishedAt: now,
        updatedAt: now,
      })
      .where(
        and(
          eq(requestLedger.id, ledger.id),
          inArray(requestLedger.status, ['open', 'pending_backfill'])
        )
      )
      .returning();
    if (!failedLedger) {
      const [current] = await tx
        .select({ status: requestLedger.status })
        .from(requestLedger)
        .where(eq(requestLedger.id, ledger.id))
        .limit(1);
      if (current?.status !== 'failed_unbilled') return;
    }
    await tx
      .update(gatewayTask)
      .set({
        status: 'failed_unbilled',
        lastError: error,
        terminalEvidenceJson: evidence ? JSON.stringify(evidence) : null,
        failedAt: now,
        nextPollAt: null,
        leaseOwner: null,
        leaseExpiresAt: null,
        updatedAt: now,
      })
      .where(eq(gatewayTask.id, task.id));
  });
}

function minimumResultExpiry(result: PortalImageTaskResult): Date | null {
  if (result.data.length === 0) return null;
  const minimum = Math.min(...result.data.map((item) => item.expires_at));
  return Number.isSafeInteger(minimum) ? new Date(minimum * 1000) : null;
}

async function completeTask(
  task: GatewayTaskRow,
  ledger: RequestLedgerRow,
  snapshot: NewApiTaskSnapshot
) {
  const flattened = flattenNewApiImageResult(snapshot);
  if (!flattened.ok) {
    await failTaskUnbilled(task, ledger, flattened.error, {
      status: snapshot.status,
      result_expires_at: snapshot.result_expires_at ?? null,
    });
    return;
  }
  const [price] = await db()
    .select()
    .from(modelPriceVersion)
    .where(eq(modelPriceVersion.id, ledger.priceVersionId))
    .limit(1);
  if (!price) {
    await retryTask(task, 'price_version_missing', 'meter_pending');
    return;
  }
  const pricing = parsePricingSpec(price.pricingSpecJson);
  if (pricing.basis === 'token' && !validateImageTokenUsage(snapshot.usage)) {
    await db()
      .update(gatewayTask)
      .set({
        resultCacheJson: JSON.stringify(flattened.result),
        resultUrlExpiresAt: minimumResultExpiry(flattened.result),
      })
      .where(eq(gatewayTask.id, task.id));
    await retryTask(task, 'token_usage_missing_or_invalid', 'meter_pending');
    return;
  }

  const usage = snapshot.usage ?? null;
  const normalized = usage
    ? normalizeUsageMeters('images_generations', usage)
    : { meters: {}, webSearchCount: 0, flags: ['usage_missing'] };
  const now = new Date();
  const evidence = {
    status: snapshot.status,
    usage,
    output_count: flattened.outputCount,
    result_expires_at: snapshot.result_expires_at ?? null,
  };
  const taskPatch = {
    status: 'completed',
    resultCacheJson: JSON.stringify(flattened.result),
    resultUrlExpiresAt: minimumResultExpiry(flattened.result),
    terminalEvidenceJson: JSON.stringify(evidence),
    completedAt: now,
    lastError: null,
    nextPollAt: null,
    leaseOwner: null,
    leaseExpiresAt: null,
    updatedAt: now,
  } as const;
  const settled = await settleByLedgerId(
    ledger.id,
    {
      meters: normalized.meters,
      flags: normalized.flags,
      webSearchCount: normalized.webSearchCount,
      rawUsage: usage,
      usageSource: 'response',
      ...(pricing.basis === 'token'
        ? {}
        : {
            skuKey: ledger.skuKey ?? 'default',
            unitCount: flattened.outputCount,
          }),
    },
    {
      onSettled: async (tx) => {
        await tx
          .update(gatewayTask)
          .set(taskPatch)
          .where(eq(gatewayTask.id, task.id));
      },
    }
  );
  if (settled === 'already_finalized') {
    const [current] = await db()
      .select({ status: requestLedger.status })
      .from(requestLedger)
      .where(eq(requestLedger.id, ledger.id))
      .limit(1);
    if (current?.status === 'settled') {
      await db()
        .update(gatewayTask)
        .set(taskPatch)
        .where(eq(gatewayTask.id, task.id));
    }
  }
}

async function processClaimedTask(
  task: GatewayTaskRow,
  fetchTask: (
    task: GatewayTaskRow,
    ledger: RequestLedgerRow
  ) => Promise<TaskFetchResult>
) {
  const [ledger] = await db()
    .select()
    .from(requestLedger)
    .where(eq(requestLedger.id, task.requestLedgerId))
    .limit(1);
  if (!ledger) {
    await retryTask(task, 'request_ledger_missing', 'meter_pending');
    return;
  }
  const fetched = await fetchTask(task, ledger);
  if (!fetched.ok) {
    if (fetched.terminal) {
      await failTaskUnbilled(task, ledger, fetched.error);
    } else {
      await retryTask(task, fetched.error, task.status as any);
    }
    return;
  }
  switch (fetched.snapshot.status) {
    case 'pending':
    case 'submitted':
      await retryTask(task, null, 'submitted');
      return;
    case 'processing':
      await retryTask(task, null, 'processing');
      return;
    case 'failed':
      await failTaskUnbilled(
        task,
        ledger,
        fetched.snapshot.error?.code ?? 'upstream_task_failed',
        {
          status: fetched.snapshot.status,
          error: fetched.snapshot.error ?? null,
        }
      );
      return;
    case 'completed':
      await completeTask(task, ledger, fetched.snapshot);
  }
}

async function claimDueTasks(holderId: string): Promise<GatewayTaskRow[]> {
  const now = new Date();
  const candidates = await db()
    .select()
    .from(gatewayTask)
    .where(
      and(
        inArray(gatewayTask.status, [...ACTIVE_STATUSES]),
        or(isNull(gatewayTask.nextPollAt), lte(gatewayTask.nextPollAt, now)),
        or(
          isNull(gatewayTask.leaseExpiresAt),
          lte(gatewayTask.leaseExpiresAt, now)
        )
      )
    )
    .limit(TASK_BATCH_SIZE);
  const claimed: GatewayTaskRow[] = [];
  for (const task of candidates) {
    const [row] = await db()
      .update(gatewayTask)
      .set({
        leaseOwner: holderId,
        leaseExpiresAt: new Date(now.getTime() + TASK_LEASE_MS),
      })
      .where(
        and(
          eq(gatewayTask.id, task.id),
          inArray(gatewayTask.status, [...ACTIVE_STATUSES]),
          or(isNull(gatewayTask.nextPollAt), lte(gatewayTask.nextPollAt, now)),
          or(
            isNull(gatewayTask.leaseExpiresAt),
            lte(gatewayTask.leaseExpiresAt, now)
          )
        )
      )
      .returning();
    if (row) claimed.push(row);
  }
  return claimed;
}

export async function runImageTaskWorkerOnce(
  deps: {
    keepAlive?: () => Promise<boolean>;
    fetchTask?: (
      task: GatewayTaskRow,
      ledger: RequestLedgerRow
    ) => Promise<TaskFetchResult>;
    holderId?: string;
  } = {}
): Promise<{ processed: number; failed: number }> {
  const keepAlive = deps.keepAlive ?? (async () => true);
  const fetchTask = deps.fetchTask ?? fetchNewApiTask;
  const holderId =
    deps.holderId ??
    `${hostname()}-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
  let processed = 0;
  let failed = 0;
  for (const task of await claimDueTasks(holderId)) {
    if (!(await keepAlive())) break;
    processed += 1;
    try {
      await processClaimedTask(task, fetchTask);
    } catch (error) {
      failed += 1;
      await retryTask(
        task,
        `worker_failed:${String(error)}`,
        task.status as any
      );
    }
  }
  return { processed, failed };
}

async function refreshCompletedTaskResult(
  task: GatewayTaskRow,
  ledger: RequestLedgerRow
) {
  const fetched = await fetchNewApiTask(task, ledger);
  if (!fetched.ok || fetched.snapshot.status !== 'completed') return;
  const flattened = flattenNewApiImageResult(fetched.snapshot);
  if (!flattened.ok) return;
  await db()
    .update(gatewayTask)
    .set({
      resultCacheJson: JSON.stringify(flattened.result),
      resultUrlExpiresAt: minimumResultExpiry(flattened.result),
      updatedAt: new Date(),
    })
    .where(
      and(eq(gatewayTask.id, task.id), eq(gatewayTask.status, 'completed'))
    );
}
