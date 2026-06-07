import { buildBillingUsageCharges } from '@/features/api-console/lib/billing';
import { getPublicPortalErrorMessage } from '@/features/api-console/lib/public-errors';
import {
  getPortalUsage,
  listLedgerEntries,
} from '@/features/newapi-bridge/server/portal';

import { withNoStore } from '@/shared/lib/http-cache';
import { respData, respErr } from '@/shared/lib/resp';
import { getUserInfo } from '@/shared/models/user';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const user = await getUserInfo();
    if (!user) return withNoStore(respErr('no auth, please sign in'));

    const [usage, ledger] = await Promise.all([
      getPortalUsage(user as any, '7d'),
      listLedgerEntries(user.id),
    ]);

    return withNoStore(
      respData({
        balance: {
          balanceUsd: usage.summary.balanceUsd,
          quotaRemaining: usage.summary.quotaRemaining,
          status: usage.summary.status,
          syncedAt: usage.summary.syncedAt,
        },
        ledger,
        charges: buildBillingUsageCharges(usage),
      })
    );
  } catch (error: any) {
    return withNoStore(
      respErr(
        getPublicPortalErrorMessage(
          error,
          'Billing is temporarily unavailable. Try again later.'
        )
      )
    );
  }
}
