import {
  recordCatalogPriceSyncFailure,
  syncCatalogPricingFromSnapshot,
} from '@/features/api-catalog/server/pricing-sync';
import { revalidateCatalog } from '@/features/api-catalog/server/queries';
import { createNewApiClient } from '@/features/newapi-bridge/server/client';
import { withNoStore } from '@/shared/lib/http-cache';
import { respData, respErr } from '@/shared/lib/resp';

export const dynamic = 'force-dynamic';

const CATALOG_WRITE_PERMISSION = 'admin.catalog.write';

type PricingSyncRouteDeps = {
  getOperator: () => Promise<{ id: string } | null | undefined>;
  hasPermissionForUser: (
    userId: string,
    permission: string
  ) => Promise<boolean>;
  getPricingSnapshot: () => Promise<
    Awaited<
      ReturnType<ReturnType<typeof createNewApiClient>['getPricingSnapshot']>
    >
  >;
  syncPricing: typeof syncCatalogPricingFromSnapshot;
  recordFailure: typeof recordCatalogPriceSyncFailure;
  revalidate: typeof revalidateCatalog;
};

const defaultDeps: PricingSyncRouteDeps = {
  getOperator: async () => {
    const { getUserInfo } = await import('@/shared/models/user');
    return getUserInfo();
  },
  hasPermissionForUser: async (userId, permission) => {
    const { hasPermission } = await import('@/shared/services/rbac');
    return hasPermission(userId, permission);
  },
  getPricingSnapshot: () => createNewApiClient().getPricingSnapshot(),
  syncPricing: syncCatalogPricingFromSnapshot,
  recordFailure: recordCatalogPriceSyncFailure,
  revalidate: revalidateCatalog,
};

let routeDeps = defaultDeps;

export function __setCatalogPricingSyncRouteDepsForTest(
  deps: Partial<PricingSyncRouteDeps>
) {
  routeDeps = { ...defaultDeps, ...deps };
}

export function __resetCatalogPricingSyncRouteDepsForTest() {
  routeDeps = defaultDeps;
}

export async function POST() {
  let operatorId: string | undefined;
  let canRecordFailure = false;
  try {
    const operator = await routeDeps.getOperator();
    if (!operator) return withNoStore(respErr('no auth, please sign in'));
    operatorId = operator.id;

    const allowed = await routeDeps.hasPermissionForUser(
      operator.id,
      CATALOG_WRITE_PERMISSION
    );
    if (!allowed) {
      return withNoStore(respErr('Model catalog write permission required'));
    }
    canRecordFailure = true;

    const snapshot = await routeDeps.getPricingSnapshot();
    const report = await routeDeps.syncPricing({
      snapshot,
      operatorUserId: operator.id,
    });
    routeDeps.revalidate();

    return withNoStore(respData(report));
  } catch (error: any) {
    if (canRecordFailure) {
      try {
        await routeDeps.recordFailure({ operatorUserId: operatorId, error });
      } catch {
        // Preserve the original sync failure response even if audit logging fails.
      }
    }
    return withNoStore(respErr('Model pricing sync is unavailable'));
  }
}
