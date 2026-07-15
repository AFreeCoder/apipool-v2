import { PERMISSIONS } from '@/core/rbac/permission-codes';
import {
  authorizeAdminRoute,
  setAdminRouteAuthDepsForTest,
} from '@/features/routing-admin/server/admin-route-auth';
import { getReconciliationAdminView } from '@/features/routing-admin/server/admin-service';
import { withNoStore } from '@/shared/lib/http-cache';
import { respData, respErr } from '@/shared/lib/resp';

export const dynamic = 'force-dynamic';
export const __setDepsForTest = setAdminRouteAuthDepsForTest;

export async function GET() {
  try {
    const auth = await authorizeAdminRoute(
      PERMISSIONS.APIPOOL_RECONCILIATION_READ
    );
    if ('response' in auth) return auth.response;
    return withNoStore(respData(await getReconciliationAdminView()));
  } catch {
    return withNoStore(respErr('gateway reconciliation is unavailable'));
  }
}
