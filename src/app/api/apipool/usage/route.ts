import { getPublicPortalErrorMessage } from '@/features/api-console/lib/public-errors';
import { getPortalUsage } from '@/features/newapi-bridge/server/portal';

import { withNoStore } from '@/shared/lib/http-cache';
import { respData, respErr } from '@/shared/lib/resp';
import { getUserInfo } from '@/shared/models/user';

export const dynamic = 'force-dynamic';

export async function GET(req: Request) {
  try {
    const user = await getUserInfo();
    if (!user) return withNoStore(respErr('no auth, please sign in'));

    const url = new URL(req.url);
    const range = url.searchParams.get('range') || '7d';
    const usage = await getPortalUsage(
      user as any,
      range === '30d' || range === 'month' ? range : '7d'
    );

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
