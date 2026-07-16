import 'server-only';

import { normalizeBackfillUsage } from '@/features/gateway/lib/billing';
import { gatewayConfig } from '@/features/gateway/lib/config';
import { and, eq, isNotNull, lt, lte } from 'drizzle-orm';

import { db } from '@/core/db';
import { newApiUserBinding, requestLedger } from '@/config/db/schema';

import { markFailedUnbilled, markPendingBackfill } from './admission';
import { settleByNewapiRequestId } from './settlement';

const BACKOFF_MS = [5_000, 15_000, 60_000, 300_000, 900_000, 1_800_000];
const BATCH = 20;

function quotaFromLog(log: {
  quota?: number;
  spendUsd?: number;
}): number | null {
  if (
    typeof log.quota === 'number' &&
    Number.isSafeInteger(log.quota) &&
    log.quota >= 0
  ) {
    return log.quota;
  }
  if (log.spendUsd === undefined || !Number.isFinite(log.spendUsd)) {
    return null;
  }
  return Math.round(log.spendUsd * 500_000);
}

async function scheduleRetry(
  row: typeof requestLedger.$inferSelect,
  error?: string
): Promise<boolean> {
  const attempts = (row.backfillAttempts ?? 0) + 1;
  // 六次未命中后进入人工队列；最后一个退避值保留为契约上限。
  const next =
    attempts < BACKOFF_MS.length
      ? new Date(Date.now() + BACKOFF_MS[attempts - 1])
      : null;
  if (!next) {
    console.error('[backfill] exhausted, manual queue', {
      ledgerId: row.id,
    });
  }
  await db()
    .update(requestLedger)
    .set({
      backfillAttempts: attempts,
      nextBackfillAt: next,
      lastBackfillError: error,
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(requestLedger.id, row.id),
        eq(requestLedger.status, 'pending_backfill')
      )
    );
  return next === null;
}

export async function runUsageWorkerOnce(
  deps: {
    client?: any;
    keepAlive?: () => Promise<boolean>;
  } = {}
): Promise<{ backfilled: number; swept: number; exhausted: number }> {
  const { createNewApiClient } = await import(
    '@/features/newapi-bridge/server/client'
  );
  const { bindingToUserCredentials } = await import(
    '@/features/newapi-bridge/server/portal'
  );
  const client = deps.client ?? createNewApiClient();
  const keepAlive = deps.keepAlive ?? (async () => true);
  let backfilled = 0;
  let swept = 0;
  let exhausted = 0;
  const now = Date.now();

  const dueRows = await db()
    .select()
    .from(requestLedger)
    .where(
      and(
        eq(requestLedger.status, 'pending_backfill'),
        isNotNull(requestLedger.nextBackfillAt),
        lte(requestLedger.nextBackfillAt, new Date(now))
      )
    )
    .limit(BATCH);

  for (const row of dueRows) {
    if (!(await keepAlive())) return { backfilled, swept, exhausted };
    try {
      const [binding] = await db()
        .select()
        .from(newApiUserBinding)
        .where(eq(newApiUserBinding.portalUserId, row.userId))
        .limit(1);
      const credentials = bindingToUserCredentials(binding);
      const log = await client.getUsageLogByRequestId(
        credentials,
        row.newapiRequestId
      );
      if (!log) {
        if (await scheduleRetry(row)) exhausted += 1;
        continue;
      }

      const quota = quotaFromLog(log);
      await db()
        .update(requestLedger)
        .set({
          newapiQuota: quota,
          newapiPromptTokens: log.inputTokens,
          newapiCompletionTokens: log.outputTokens,
          newapiTokenName: log.keyMasked,
          lastBackfillError: null,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(requestLedger.id, row.id),
            eq(requestLedger.status, 'pending_backfill')
          )
        );

      if (quota === 0) {
        await markFailedUnbilled(row.id, {
          errorCode: 'backfill_zero_quota',
        });
        continue;
      }
      const result = await settleByNewapiRequestId(row.newapiRequestId!, {
        buckets: normalizeBackfillUsage(log),
        usageSource: 'log_backfill',
      });
      if (result === 'settled') backfilled += 1;
    } catch (error) {
      if (await scheduleRetry(row, String(error))) exhausted += 1;
    }
  }

  const staleCutoff = new Date(
    now - gatewayConfig().hardTimeoutMs - 10 * 60_000
  );
  const staleRows = await db()
    .select()
    .from(requestLedger)
    .where(
      and(
        eq(requestLedger.status, 'open'),
        lt(requestLedger.createdAt, staleCutoff)
      )
    )
    .limit(BATCH);

  for (const row of staleRows) {
    if (!(await keepAlive())) return { backfilled, swept, exhausted };
    if (row.newapiRequestId) {
      if (await markPendingBackfill(row.id, {})) swept += 1;
    } else if (
      await markFailedUnbilled(row.id, { errorCode: 'open_timeout' })
    ) {
      swept += 1;
    }
  }
  return { backfilled, swept, exhausted };
}
