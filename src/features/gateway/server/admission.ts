import 'server-only';

import { gatewayConfig } from '@/features/gateway/lib/config';
import type { GatewayEndpointKey } from '@/features/gateway/lib/endpoints';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';

import { db } from '@/core/db';
import { requestLedger, walletAccount } from '@/config/db/schema';

export interface AdmissionInput {
  id: string;
  userId: string;
  portalKeyId: string;
  portalGroupId: string;
  portalModelId: string;
  newapiGroup: string;
  newapiModelId: string;
  credentialId: string;
  routeVersion: number;
  priceVersionId: string;
  endpoint: GatewayEndpointKey;
  isStream: boolean;
}

export async function admitRequest(
  input: AdmissionInput,
  riskLimit: number
): Promise<boolean> {
  const now = Date.now();
  const result = await db().run(sql`
    INSERT INTO request_ledger (
      id, user_id, portal_key_id, portal_group_id, portal_model_id,
      newapi_group, newapi_model_id, credential_id, route_version,
      price_version_id, endpoint, is_stream, status, created_at, updated_at
    )
    SELECT
      ${input.id}, ${input.userId}, ${input.portalKeyId},
      ${input.portalGroupId}, ${input.portalModelId}, ${input.newapiGroup},
      ${input.newapiModelId}, ${input.credentialId}, ${input.routeVersion},
      ${input.priceVersionId}, ${input.endpoint}, ${input.isStream ? 1 : 0},
      'open', ${now}, ${now}
    WHERE (
      SELECT COUNT(*) FROM request_ledger
      WHERE user_id = ${input.userId}
        AND status IN ('open', 'pending_backfill')
    ) < ${riskLimit}
  `);
  return Number(result?.rowsAffected ?? 0) === 1;
}

export async function resolveRiskLimit(userId: string): Promise<number> {
  const [row] = await db()
    .select({ override: walletAccount.riskLimitOverride })
    .from(walletAccount)
    .where(eq(walletAccount.userId, userId))
    .limit(1);
  return row?.override ?? gatewayConfig().riskSlotLimit;
}

function isUniqueConstraint(error: unknown): boolean {
  const candidate = error as {
    code?: unknown;
    message?: unknown;
    cause?: unknown;
  };
  const code = String(candidate?.code ?? '');
  const message = String(candidate?.cause ?? candidate?.message ?? error);
  return (
    /SQLITE_CONSTRAINT_(UNIQUE|PRIMARYKEY)/i.test(code) ||
    /UNIQUE constraint failed/i.test(message)
  );
}

export async function captureRequestId(
  ledgerId: string,
  newapiRequestId: string
): Promise<boolean> {
  try {
    const [row] = await db()
      .update(requestLedger)
      .set({
        newapiRequestId,
        respondedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(requestLedger.id, ledgerId),
          eq(requestLedger.status, 'open'),
          isNull(requestLedger.newapiRequestId)
        )
      )
      .returning();
    return Boolean(row);
  } catch (error) {
    if (isUniqueConstraint(error)) {
      console.error('[gateway] duplicate newapi_request_id', {
        ledgerId,
        newapiRequestId,
      });
      return false;
    }
    throw error;
  }
}

export async function markFailedUnbilled(
  ledgerId: string,
  patch: {
    httpStatus?: number;
    errorCode?: string;
    streamAborted?: boolean;
  }
): Promise<boolean> {
  const [row] = await db()
    .update(requestLedger)
    .set({
      status: 'failed_unbilled',
      finishedAt: new Date(),
      updatedAt: new Date(),
      httpStatus: patch.httpStatus,
      errorCode: patch.errorCode,
      streamAborted: patch.streamAborted,
    })
    .where(
      and(
        eq(requestLedger.id, ledgerId),
        inArray(requestLedger.status, ['open', 'pending_backfill'])
      )
    )
    .returning();
  return Boolean(row);
}

export async function markPendingBackfill(
  ledgerId: string,
  patch: { httpStatus?: number }
): Promise<boolean> {
  const [row] = await db()
    .update(requestLedger)
    .set({
      status: 'pending_backfill',
      finishedAt: new Date(),
      updatedAt: new Date(),
      httpStatus: patch.httpStatus,
      nextBackfillAt: new Date(Date.now() + 5_000),
      backfillAttempts: 0,
    })
    .where(
      and(eq(requestLedger.id, ledgerId), eq(requestLedger.status, 'open'))
    )
    .returning();
  return Boolean(row);
}
