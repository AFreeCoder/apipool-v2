import { PERMISSIONS } from '@/core/rbac/permission-codes';
import {
  authorizeAdminRoute,
  setAdminRouteAuthDepsForTest,
} from '@/features/routing-admin/server/admin-route-auth';
import { freezeWallet, unfreezeWallet } from '@/features/wallet/server/freeze';
import { withNoStore } from '@/shared/lib/http-cache';
import { respData, respErr } from '@/shared/lib/resp';
import { recordPortalAdminAudit } from '@/shared/models/portal-admin-audit';

export const dynamic = 'force-dynamic';
export const __setDepsForTest = setAdminRouteAuthDepsForTest;

export async function POST(req: Request) {
  try {
    const auth = await authorizeAdminRoute(PERMISSIONS.APIPOOL_WALLET_FREEZE);
    if ('response' in auth) return auth.response;
    const body = await req.json().catch(() => ({}));
    const userId = String(body.userId ?? '').trim();
    const action = String(body.action ?? '').trim();
    const reason = String(body.reason ?? '').trim();
    if (!userId) return withNoStore(respErr('userId is required'));
    if (!reason) return withNoStore(respErr('reason is required'));
    if (action !== 'freeze' && action !== 'unfreeze') {
      return withNoStore(respErr('action must be freeze or unfreeze'));
    }
    const changed =
      action === 'freeze'
        ? await freezeWallet({
            userId,
            reason: 'manual',
            frozenBy: auth.operatorId,
          })
        : await unfreezeWallet({
            userId,
            operatorUserId: auth.operatorId,
            reason,
          });
    if (changed && action === 'freeze') {
      await recordPortalAdminAudit({
        action: 'wallet.freeze',
        operatorUserId: auth.operatorId,
        targetType: 'wallet_account',
        targetId: userId,
        reason,
      });
    }
    return withNoStore(respData({ changed }));
  } catch (error) {
    return withNoStore(
      respErr(error instanceof Error ? error.message : 'wallet freeze failed')
    );
  }
}
