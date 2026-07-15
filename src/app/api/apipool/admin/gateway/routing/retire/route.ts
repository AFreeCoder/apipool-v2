import { PERMISSIONS } from '@/core/rbac/permission-codes';
import {
  authorizeAdminRoute,
  setAdminRouteAuthDepsForTest,
} from '@/features/routing-admin/server/admin-route-auth';
import { retireModelRoute } from '@/features/routing-admin/server/route-service';
import { withNoStore } from '@/shared/lib/http-cache';
import { respData, respErr } from '@/shared/lib/resp';

export const dynamic = 'force-dynamic';
export const __setDepsForTest = setAdminRouteAuthDepsForTest;

export async function POST(req: Request) {
  try {
    const auth = await authorizeAdminRoute(PERMISSIONS.APIPOOL_ROUTING_WRITE);
    if ('response' in auth) return auth.response;
    const body = await req.json().catch(() => ({}));
    const portalGroupId = String(body.portalGroupId ?? '').trim();
    const portalModelId = String(body.portalModelId ?? '').trim();
    const reason = String(body.reason ?? '').trim();
    if (!portalGroupId || !portalModelId || !reason) {
      return withNoStore(
        respErr('portalGroupId, portalModelId and reason are required')
      );
    }
    const retired = await retireModelRoute({
      portalGroupId,
      portalModelId,
      operatorUserId: auth.operatorId,
      reason,
    });
    return withNoStore(respData({ retired }));
  } catch (error) {
    const message =
      error instanceof Error && error.name === 'ConcurrentPublishError'
        ? error.message
        : 'gateway route retirement failed';
    return withNoStore(respErr(message));
  }
}
