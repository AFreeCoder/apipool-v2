import { getPublicPortalErrorMessage } from '@/features/api-console/lib/public-errors';
import { getWalletBillingView } from '@/features/wallet/server/usage-view';
import { withNoStore } from '@/shared/lib/http-cache';
import { respData, respErr } from '@/shared/lib/resp';
import { getUserInfo } from '@/shared/models/user';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const user = await getUserInfo();
    if (!user) return withNoStore(respErr('no auth, please sign in'));

    return withNoStore(respData(await getWalletBillingView(user.id)));
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
