import { APIPOOL_CONFIG } from '@/config/apipool';
import {
  assertPortalApiKeyCreationEnabled,
  sanitizePortalApiKeyCreateInput,
} from '@/features/api-console/lib/key-input';
import { getPublicPortalErrorMessage } from '@/features/api-console/lib/public-errors';
import {
  createPortalApiKey,
  listPortalApiKeys,
} from '@/features/newapi-bridge/server/portal';

import { withNoStore } from '@/shared/lib/http-cache';
import { respData, respErr } from '@/shared/lib/resp';
import { getUserInfo } from '@/shared/models/user';

export const dynamic = 'force-dynamic';

export async function GET() {
  try {
    const user = await getUserInfo();
    if (!user) return withNoStore(respErr('no auth, please sign in'));

    const keys = await listPortalApiKeys(user.id);
    return withNoStore(respData({ keys }));
  } catch (error: any) {
    return withNoStore(
      respErr(getPublicPortalErrorMessage(error, 'List API keys failed'))
    );
  }
}

export async function POST(req: Request) {
  try {
    const user = await getUserInfo();
    if (!user) return withNoStore(respErr('no auth, please sign in'));

    assertPortalApiKeyCreationEnabled(
      APIPOOL_CONFIG.isPortalKeyCreationEnabled
    );

    const body = await req.json().catch(() => ({}));
    const result = await createPortalApiKey(
      user as any,
      sanitizePortalApiKeyCreateInput(body)
    );

    return withNoStore(
      respData({
        key: result.binding,
        plainKey: result.plainKey,
      })
    );
  } catch (error: any) {
    return withNoStore(
      respErr(
        getPublicPortalErrorMessage(
          error,
          'Create API key is temporarily unavailable. Try again later.'
        )
      )
    );
  }
}
