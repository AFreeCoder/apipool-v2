import { parseWalletAdjustmentAmount } from '@/features/wallet/lib/adjustment-input';
import {
  applyManualAdjustment,
  IdempotencyConflictError,
} from '@/features/wallet/server/ledger';

import { PERMISSIONS } from '@/core/rbac';
import { withNoStore } from '@/shared/lib/http-cache';
import { respData, respErr, respJson } from '@/shared/lib/resp';
import { findUserById, getUserInfo } from '@/shared/models/user';
import { hasPermission } from '@/shared/services/rbac';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
  try {
    const operator = await getUserInfo();
    if (!operator) return withNoStore(respErr('no auth, please sign in'));

    const allowed = await hasPermission(
      operator.id,
      PERMISSIONS.APIPOOL_QUOTA_ADJUST
    );
    if (!allowed) {
      return withNoStore(
        respErr('APIPool quota adjustment permission required')
      );
    }

    const body = await req.json().catch(() => ({}));
    const portalUserId = String(body.portalUserId || '');
    const reason = String(body.reason || '').trim();
    const idempotencyKey = String(body.idempotencyKey || '').trim();

    if (!portalUserId) return withNoStore(respErr('portalUserId is required'));

    let amountUsd: number;
    try {
      ({ amountUsd } = parseWalletAdjustmentAmount(body.amountUsd));
    } catch (error: any) {
      return withNoStore(respErr(error?.message || 'invalid amountUsd'));
    }

    if (!reason) return withNoStore(respErr('reason is required'));

    const portalUser = await findUserById(portalUserId);
    if (!portalUser) return withNoStore(respErr('portal user not found'));

    if (!idempotencyKey) {
      return withNoStore(respErr('idempotencyKey is required'));
    }
    const signedAmountMicroUsd = amountUsd * 1_000_000;
    const result = await applyManualAdjustment({
      userId: portalUser.id,
      operatorUserId: operator.id,
      signedAmountMicroUsd,
      reason,
      idempotencyKey,
      audit: {
        action: 'wallet.adjust',
        targetType: 'wallet_account',
        targetId: portalUser.id,
        afterJson: { signedAmountMicroUsd, idempotencyKey },
      },
    });
    return withNoStore(
      respData({
        ledger: {
          id: result.ledgerId,
          status: 'applied',
          balanceAfterMicroUsd: result.balanceAfterMicroUsd,
          alreadyApplied: result.alreadyApplied,
        },
      })
    );
  } catch (error: unknown) {
    if (error instanceof IdempotencyConflictError) {
      return withNoStore(
        respJson(409, 'idempotency_conflict: 调额请求标识已被不同载荷使用')
      );
    }
    return withNoStore(
      respErr(error instanceof Error ? error.message : '钱包调额失败')
    );
  }
}
