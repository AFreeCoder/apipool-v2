import {
  authorizeAdminRoute,
  setAdminRouteAuthDepsForTest,
} from '@/features/routing-admin/server/admin-route-auth';
import { reverseRequestCharge } from '@/features/wallet/server/ledger';

import { PERMISSIONS } from '@/core/rbac/permission-codes';
import { withNoStore } from '@/shared/lib/http-cache';
import { respData, respErr } from '@/shared/lib/resp';

export const dynamic = 'force-dynamic';
export const __setDepsForTest = setAdminRouteAuthDepsForTest;

export async function POST(req: Request) {
  try {
    const auth = await authorizeAdminRoute(PERMISSIONS.APIPOOL_WALLET_ADJUST);
    if ('response' in auth) return auth.response;
    const body = await req.json().catch(() => ({}));
    const reverseWalletLedgerId = String(
      body.reverseWalletLedgerId ?? ''
    ).trim();
    if (!reverseWalletLedgerId) {
      return withNoStore(respErr('请统一通过 APIPool 调额入口修改钱包余额'));
    }
    const result = await reverseRequestCharge({
      walletLedgerId: reverseWalletLedgerId,
      operatorUserId: auth.operatorId,
    });
    return withNoStore(respData(result));
  } catch (error) {
    return withNoStore(
      respErr(
        error instanceof Error ? error.message : 'wallet adjustment failed'
      )
    );
  }
}
