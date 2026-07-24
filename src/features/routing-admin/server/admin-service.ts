import 'server-only';

import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';

import {
  portalAdminAuditLog,
  reconcileOrphanObservation,
  requestLedger,
  runtimeCredential,
  walletAccount,
  walletLedger,
} from '@/config/db/schema';
import { db } from '@/core/db';
import { runWalletInvariantCheckOnce } from '@/features/gateway/server/reconcile';
import { recordPortalAdminAudit } from '@/shared/models/portal-admin-audit';

function boundedPage(raw: string | null) {
  const parsed = Number(raw ?? '1');
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 1;
}

function affectedRows(result: any) {
  if (typeof result?.rowsAffected === 'number') return result.rowsAffected;
  if (typeof result?.affectedRows === 'number') return result.affectedRows;
  if (Array.isArray(result)) {
    return Number(result[0]?.rowsAffected ?? result[0]?.affectedRows ?? 0);
  }
  return 0;
}

export async function findRequests(url: URL) {
  const id = url.searchParams.get('id')?.trim();
  const newapiRequestId = url.searchParams.get('newapiRequestId')?.trim();
  if (id || newapiRequestId) {
    const [row] = await db()
      .select()
      .from(requestLedger)
      .where(
        id
          ? eq(requestLedger.id, id)
          : eq(requestLedger.newapiRequestId, newapiRequestId!)
      )
      .limit(1);
    return { request: row ?? null };
  }
  const userId = url.searchParams.get('userId')?.trim();
  const page = boundedPage(url.searchParams.get('page'));
  if (!userId) return { requests: [], page };
  const requests = await db()
    .select()
    .from(requestLedger)
    .where(eq(requestLedger.userId, userId))
    .orderBy(desc(requestLedger.createdAt))
    .limit(50)
    .offset((page - 1) * 50);
  return { requests, page };
}

export async function getWalletAdminView(url: URL) {
  const userId = url.searchParams.get('userId')?.trim();
  if (!userId) throw new Error('userId is required');
  const page = boundedPage(url.searchParams.get('page'));
  const [[account], ledger] = await Promise.all([
    db()
      .select()
      .from(walletAccount)
      .where(eq(walletAccount.userId, userId))
      .limit(1),
    db()
      .select()
      .from(walletLedger)
      .where(eq(walletLedger.userId, userId))
      .orderBy(desc(walletLedger.createdAt))
      .limit(50)
      .offset((page - 1) * 50),
  ]);
  return { account: account ?? null, ledger, page };
}

export async function getReconciliationAdminView() {
  const [mismatches, waivedLedger, waivedOrphans, stuck, invariant] =
    await Promise.all([
      db()
        .select()
        .from(requestLedger)
        .where(
          inArray(requestLedger.reconcileStatus, [
            'token_mismatch',
            'amount_mismatch',
          ])
        )
        .orderBy(desc(requestLedger.updatedAt)),
      db()
        .select()
        .from(requestLedger)
        .where(eq(requestLedger.reconcileStatus, 'waived_by_failure'))
        .orderBy(desc(requestLedger.updatedAt)),
      db()
        .select()
        .from(reconcileOrphanObservation)
        .where(isNull(reconcileOrphanObservation.resolvedAt))
        .orderBy(desc(reconcileOrphanObservation.createdAt)),
      db()
        .select()
        .from(requestLedger)
        .where(
          and(
            eq(requestLedger.status, 'pending_backfill'),
            isNull(requestLedger.nextBackfillAt),
            isNull(requestLedger.resolvedAt)
          )
        )
        .orderBy(desc(requestLedger.updatedAt)),
      runWalletInvariantCheckOnce(),
    ]);
  return {
    mismatches,
    waived: [
      ...waivedLedger.map((row: any) => ({
        ...row,
        source: 'ledger' as const,
      })),
      ...waivedOrphans.map((row: any) => ({
        ...row,
        source: 'orphan' as const,
      })),
    ],
    stuck,
    invariant,
  };
}

export async function resolveReconciliation(input: {
  ledgerId?: string;
  orphanId?: string;
  resolution: 'explained' | 'manual_closed' | 'orphan_acknowledged';
  note: string;
  operatorUserId: string;
}) {
  const now = new Date();
  if (input.resolution === 'orphan_acknowledged') {
    if (!input.orphanId) throw new Error('orphanId is required');
    return db().transaction(async (tx: any) => {
      const result = await tx
        .update(reconcileOrphanObservation)
        .set({ resolvedAt: now, note: input.note })
        .where(
          and(
            eq(reconcileOrphanObservation.id, input.orphanId!),
            isNull(reconcileOrphanObservation.resolvedAt)
          )
        );
      if (affectedRows(result) !== 1) return false;
      await recordPortalAdminAudit(
        {
          action: 'ledger.waive',
          operatorUserId: input.operatorUserId,
          targetType: 'reconcile_orphan_observation',
          targetId: input.orphanId,
          afterJson: { resolution: input.resolution },
          reason: input.note,
        },
        tx
      );
      return true;
    });
  }

  if (!input.ledgerId) throw new Error('ledgerId is required');
  return db().transaction(async (tx: any) => {
    const result =
      input.resolution === 'explained'
        ? await tx
            .update(requestLedger)
            .set({
              reconcileStatus: 'explained',
              reconcileNote: input.note,
              reconciledAt: now,
            })
            .where(
              and(
                eq(requestLedger.id, input.ledgerId!),
                inArray(requestLedger.reconcileStatus, [
                  'token_mismatch',
                  'amount_mismatch',
                ])
              )
            )
        : await tx
            .update(requestLedger)
            .set({
              status: 'failed_unbilled',
              resolvedAt: now,
              reconcileNote: input.note,
              updatedAt: now,
            })
            .where(
              and(
                eq(requestLedger.id, input.ledgerId!),
                eq(requestLedger.status, 'pending_backfill'),
                isNull(requestLedger.resolvedAt)
              )
            );
    if (affectedRows(result) !== 1) return false;
    await recordPortalAdminAudit(
      {
        action: 'ledger.waive',
        operatorUserId: input.operatorUserId,
        targetType: 'request_ledger',
        targetId: input.ledgerId,
        afterJson: { resolution: input.resolution },
        reason: input.note,
      },
      tx
    );
    return true;
  });
}

export async function getGatewayMetrics() {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1_000);
  const [[requests], [wallets], [credentials]] = await Promise.all([
    db()
      .select({
        settled: sql<number>`COALESCE(SUM(CASE WHEN ${requestLedger.status} = 'settled' THEN 1 ELSE 0 END), 0)`,
        failedUnbilled: sql<number>`COALESCE(SUM(CASE WHEN ${requestLedger.status} = 'failed_unbilled' THEN 1 ELSE 0 END), 0)`,
        pendingBackfill: sql<number>`COALESCE(SUM(CASE WHEN ${requestLedger.status} = 'pending_backfill' THEN 1 ELSE 0 END), 0)`,
        waived: sql<number>`COALESCE(SUM(CASE WHEN ${requestLedger.reconcileStatus} = 'waived_by_failure' THEN 1 ELSE 0 END), 0)`,
      })
      .from(requestLedger)
      .where(sql`${requestLedger.createdAt} >= ${since}`),
    db()
      .select({
        negativeUsers: sql<number>`COALESCE(SUM(CASE WHEN ${walletAccount.balanceMicroUsd} < 0 THEN 1 ELSE 0 END), 0)`,
        overdraftExposureMicroUsd: sql<number>`COALESCE(SUM(CASE WHEN ${walletAccount.balanceMicroUsd} < 0 THEN ${walletAccount.balanceMicroUsd} ELSE 0 END), 0)`,
        frozenUsers: sql<number>`COALESCE(SUM(CASE WHEN ${walletAccount.frozenAt} IS NOT NULL THEN 1 ELSE 0 END), 0)`,
      })
      .from(walletAccount),
    db()
      .select({
        pending: sql<number>`COALESCE(SUM(CASE WHEN ${runtimeCredential.status} = 'pending' THEN 1 ELSE 0 END), 0)`,
        invalid: sql<number>`COALESCE(SUM(CASE WHEN ${runtimeCredential.status} = 'invalid' THEN 1 ELSE 0 END), 0)`,
      })
      .from(runtimeCredential),
  ]);
  const settled = Number(requests.settled);
  const failedUnbilled = Number(requests.failedUnbilled);
  const terminal = settled + failedUnbilled;
  return {
    requests24h: {
      settled,
      failedUnbilled,
      successRate: terminal === 0 ? null : settled / terminal,
    },
    pendingBackfill: Number(requests.pendingBackfill),
    waived: Number(requests.waived),
    wallets: {
      negativeUsers: Number(wallets.negativeUsers),
      overdraftExposureMicroUsd: Number(wallets.overdraftExposureMicroUsd),
      frozenUsers: Number(wallets.frozenUsers),
    },
    credentials: {
      pending: Number(credentials.pending),
      invalid: Number(credentials.invalid),
    },
  };
}

export async function getAuditPage(url: URL) {
  const page = boundedPage(url.searchParams.get('page'));
  const action = url.searchParams.get('action')?.trim();
  const rows = await db()
    .select()
    .from(portalAdminAuditLog)
    .where(action ? eq(portalAdminAuditLog.action, action) : undefined)
    .orderBy(desc(portalAdminAuditLog.createdAt))
    .limit(50)
    .offset((page - 1) * 50);
  return { audits: rows, page };
}
