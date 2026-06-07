import { getPublicPortalErrorMessage } from '@/features/api-console/lib/public-errors';
import { adjustPortalQuota } from '@/features/newapi-bridge/server/portal';

import { PERMISSIONS } from '@/core/rbac';
import { withNoStore } from '@/shared/lib/http-cache';
import { respData, respErr } from '@/shared/lib/resp';
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
    const amountUsd = Number(body.amountUsd);
    const reason = String(body.reason || '').trim();

    if (!portalUserId) return withNoStore(respErr('portalUserId is required'));
    if (!Number.isFinite(amountUsd) || amountUsd === 0) {
      return withNoStore(respErr('amountUsd must be a non-zero number'));
    }
    if (!reason) return withNoStore(respErr('reason is required'));

    const portalUser = await findUserById(portalUserId);
    if (!portalUser) return withNoStore(respErr('portal user not found'));

    const ledger = await adjustPortalQuota({
      portalUser,
      operatorUserId: operator.id,
      amountUsd,
      reason,
    });

    return withNoStore(respData({ ledger }));
  } catch (error: any) {
    return withNoStore(
      respErr(
        getPublicPortalErrorMessage(
          error,
          'Quota adjustment could not start. Try again later.'
        )
      )
    );
  }
}
