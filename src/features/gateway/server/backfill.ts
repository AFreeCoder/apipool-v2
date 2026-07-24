import 'server-only';

import { and, eq, lt } from 'drizzle-orm';

import { requestLedger } from '@/config/db/schema';
import { db } from '@/core/db';
import { gatewayConfig } from '@/features/gateway/lib/config';

import { markFailedUnbilled } from './admission';

const BATCH = 20;

/**
 * usage 日志不再作为门户结算凭证。该 worker 只负责把历史遗留的
 * pending/open 风险槽收束为免单终态；日志拉取与对照统一由 reconcile 负责。
 */
export async function runUsageWorkerOnce(
  deps: { keepAlive?: () => Promise<boolean> } = {}
): Promise<{ backfilled: number; swept: number; exhausted: number }> {
  const keepAlive = deps.keepAlive ?? (async () => true);
  let swept = 0;

  const pendingRows = await db()
    .select()
    .from(requestLedger)
    .where(eq(requestLedger.status, 'pending_backfill'))
    .limit(BATCH);

  for (const row of pendingRows) {
    if (!(await keepAlive())) return { backfilled: 0, swept, exhausted: 0 };
    if (
      await markFailedUnbilled(row.id, {
        errorCode: 'legacy_pending_retired',
        billingFlags: ['usage_missing_waived'],
      })
    ) {
      swept += 1;
    }
  }

  const staleCutoff = new Date(
    Date.now() - gatewayConfig().hardTimeoutMs - 10 * 60_000
  );
  const staleRows = await db()
    .select()
    .from(requestLedger)
    .where(
      // 超时 open 是否已有远端 request id 都不改变免单规则。
      and(
        eq(requestLedger.status, 'open'),
        lt(requestLedger.createdAt, staleCutoff)
      )
    )
    .limit(BATCH);

  for (const row of staleRows) {
    if (!(await keepAlive())) return { backfilled: 0, swept, exhausted: 0 };
    if (
      await markFailedUnbilled(row.id, {
        errorCode: 'open_timeout',
      })
    ) {
      swept += 1;
    }
  }

  return { backfilled: 0, swept, exhausted: 0 };
}
