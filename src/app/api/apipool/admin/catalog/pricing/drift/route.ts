import { buildCatalogPriceDriftReport } from '@/features/api-catalog/server/pricing-sync';
import { withNoStore } from '@/shared/lib/http-cache';
import { respData, respErr } from '@/shared/lib/resp';

export const dynamic = 'force-dynamic';

const CATALOG_READ_PERMISSION = 'admin.catalog.read';

type PricingDriftRouteDeps = {
  getOperator: () => Promise<{ id: string } | null | undefined>;
  hasPermissionForUser: (
    userId: string,
    permission: string
  ) => Promise<boolean>;
  buildReport: typeof buildCatalogPriceDriftReport;
};

const defaultDeps: PricingDriftRouteDeps = {
  getOperator: async () => {
    const { getUserInfo } = await import('@/shared/models/user');
    return getUserInfo();
  },
  hasPermissionForUser: async (userId, permission) => {
    const { hasPermission } = await import('@/shared/services/rbac');
    return hasPermission(userId, permission);
  },
  buildReport: buildCatalogPriceDriftReport,
};

let routeDeps = defaultDeps;

export function __setCatalogPricingDriftRouteDepsForTest(
  deps: Partial<PricingDriftRouteDeps>
) {
  routeDeps = { ...defaultDeps, ...deps };
}

export function __resetCatalogPricingDriftRouteDepsForTest() {
  routeDeps = defaultDeps;
}

export async function GET() {
  try {
    const operator = await routeDeps.getOperator();
    if (!operator) return withNoStore(respErr('no auth, please sign in'));

    const allowed = await routeDeps.hasPermissionForUser(
      operator.id,
      CATALOG_READ_PERMISSION
    );
    if (!allowed) {
      return withNoStore(respErr('Model catalog read permission required'));
    }

    return withNoStore(respData(await routeDeps.buildReport()));
  } catch (error: any) {
    return withNoStore(
      respErr(error?.message || 'Model pricing drift report is unavailable')
    );
  }
}
