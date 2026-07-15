import { PERMISSIONS } from '@/core/rbac/permission-codes';
import {
  authorizeAdminRoute,
  setAdminRouteAuthDepsForTest,
} from '@/features/routing-admin/server/admin-route-auth';
import { resolveReconciliation } from '@/features/routing-admin/server/admin-service';
import { withNoStore } from '@/shared/lib/http-cache';
import { respData, respErr } from '@/shared/lib/resp';

export const dynamic = 'force-dynamic';
export const __setDepsForTest = setAdminRouteAuthDepsForTest;

const RESOLUTIONS = new Set([
  'explained',
  'manual_closed',
  'orphan_acknowledged',
]);

export async function POST(req: Request) {
  try {
    const auth = await authorizeAdminRoute(
      PERMISSIONS.APIPOOL_RECONCILIATION_RESOLVE
    );
    if ('response' in auth) return auth.response;
    const body = await req.json().catch(() => ({}));
    const ledgerId = String(body.ledgerId ?? '').trim() || undefined;
    const orphanId = String(body.orphanId ?? '').trim() || undefined;
    const resolution = String(body.resolution ?? '').trim();
    const note = String(body.note ?? '').trim();
    if (!RESOLUTIONS.has(resolution)) {
      return withNoStore(respErr('invalid resolution'));
    }
    if (!note) return withNoStore(respErr('note is required'));
    const resolved = await resolveReconciliation({
      ledgerId,
      orphanId,
      resolution: resolution as
        | 'explained'
        | 'manual_closed'
        | 'orphan_acknowledged',
      note,
      operatorUserId: auth.operatorId,
    });
    return withNoStore(respData({ resolved }));
  } catch (error) {
    return withNoStore(
      respErr(
        error instanceof Error
          ? error.message
          : 'reconciliation resolution failed'
      )
    );
  }
}
