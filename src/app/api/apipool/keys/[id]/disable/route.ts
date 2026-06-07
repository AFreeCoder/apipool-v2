import { getPublicPortalErrorMessage } from '@/features/api-console/lib/public-errors';
import { disablePortalApiKey } from '@/features/newapi-bridge/server/portal';

import { withNoStore } from '@/shared/lib/http-cache';
import { respData, respErr } from '@/shared/lib/resp';
import { getUserInfo } from '@/shared/models/user';

export const dynamic = 'force-dynamic';

export async function POST(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const user = await getUserInfo();
    if (!user) return withNoStore(respErr('no auth, please sign in'));

    const { id } = await params;
    const key = await disablePortalApiKey(user.id, id);
    return withNoStore(respData({ key }));
  } catch (error: any) {
    return withNoStore(
      respErr(
        getPublicPortalErrorMessage(
          error,
          'Disable API key is temporarily unavailable. Try again later.'
        )
      )
    );
  }
}
