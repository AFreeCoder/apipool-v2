import { getPublicPortalErrorMessage } from '@/features/api-console/lib/public-errors';
import { getWalletUsageView } from '@/features/wallet/server/usage-view';

import { withNoStore } from '@/shared/lib/http-cache';
import { respData, respErr } from '@/shared/lib/resp';
import { getUserInfo } from '@/shared/models/user';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  try {
    const user = await getUserInfo();
    if (!user) return withNoStore(respErr('no auth, please sign in'));

    const url = new URL(req.url);
    const requestedRange = url.searchParams.get('range') || '7d';
    const range =
      requestedRange === '30d' || requestedRange === 'month'
        ? requestedRange
        : '7d';
    const usage = await getWalletUsageView(user.id, range);

    return withNoStore(respData(usage));
  } catch (error: any) {
    return withNoStore(
      respErr(
        getPublicPortalErrorMessage(
          error,
          'Usage is temporarily unavailable. Try again later.'
        )
      )
    );
  }
}
