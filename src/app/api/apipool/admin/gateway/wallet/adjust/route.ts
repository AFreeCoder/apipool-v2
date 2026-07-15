import { PERMISSIONS } from '@/core/rbac/permission-codes';
import {
  authorizeAdminRoute,
  setAdminRouteAuthDepsForTest,
} from '@/features/routing-admin/server/admin-route-auth';
import {
  applyManualAdjustment,
  IdempotencyConflictError,
  reverseRequestCharge,
} from '@/features/wallet/server/ledger';
import { withNoStore } from '@/shared/lib/http-cache';
import { respData, respErr, respJson } from '@/shared/lib/resp';

export const dynamic = 'force-dynamic';
export const __setDepsForTest = setAdminRouteAuthDepsForTest;

const OPERATION_ID = /^[A-Za-z0-9_-]{8,64}$/;

export async function POST(req: Request) {
  try {
    const auth = await authorizeAdminRoute(PERMISSIONS.APIPOOL_WALLET_ADJUST);
    if ('response' in auth) return auth.response;
    const body = await req.json().catch(() => ({}));
    const reverseWalletLedgerId = String(
      body.reverseWalletLedgerId ?? ''
    ).trim();
    if (reverseWalletLedgerId) {
      const result = await reverseRequestCharge({
        walletLedgerId: reverseWalletLedgerId,
        operatorUserId: auth.operatorId,
      });
      return withNoStore(respData(result));
    }

    const userId = String(body.userId ?? '').trim();
    const reason = String(body.reason ?? '').trim();
    const operationId = String(body.operationId ?? '').trim();
    const signedAmountMicroUsd = Number(body.signedAmountMicroUsd);
    if (!userId) return withNoStore(respErr('userId is required'));
    if (!reason) return withNoStore(respErr('reason is required'));
    if (!OPERATION_ID.test(operationId)) {
      return withNoStore(respErr('operationId format is invalid'));
    }
    if (!Number.isSafeInteger(signedAmountMicroUsd) || signedAmountMicroUsd === 0) {
      return withNoStore(respErr('signedAmountMicroUsd must be a non-zero safe integer'));
    }
    const result = await applyManualAdjustment({
      userId,
      signedAmountMicroUsd,
      reason,
      operatorUserId: auth.operatorId,
      idempotencyKey: `manual:${operationId}`,
      audit: {
        action: 'wallet.adjust',
        targetType: 'wallet_account',
        targetId: userId,
        afterJson: { signedAmountMicroUsd, operationId },
      },
    });
    return withNoStore(respData(result));
  } catch (error) {
    if (error instanceof IdempotencyConflictError) {
      return withNoStore(
        respJson(
          409,
          'idempotency_conflict: operationId 已被不同载荷使用'
        )
      );
    }
    return withNoStore(
      respErr(error instanceof Error ? error.message : 'wallet adjustment failed')
    );
  }
}
