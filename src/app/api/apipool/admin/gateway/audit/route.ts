import { PERMISSIONS } from '@/core/rbac/permission-codes';
import {
  authorizeAdminRoute,
  setAdminRouteAuthDepsForTest,
} from '@/features/routing-admin/server/admin-route-auth';
import { getAuditPage } from '@/features/routing-admin/server/admin-service';
import { withNoStore } from '@/shared/lib/http-cache';
import { respData, respErr } from '@/shared/lib/resp';

export const dynamic = 'force-dynamic';
export const __setDepsForTest = setAdminRouteAuthDepsForTest;

export async function GET(req: Request) {
  try {
    const auth = await authorizeAdminRoute(PERMISSIONS.APIPOOL_ROUTING_READ);
    if ('response' in auth) return auth.response;
    return withNoStore(respData(await getAuditPage(new URL(req.url))));
  } catch {
    return withNoStore(respErr('gateway audit log is unavailable'));
  }
}
