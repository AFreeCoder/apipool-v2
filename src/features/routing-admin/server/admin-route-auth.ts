import { withNoStore } from '@/shared/lib/http-cache';
import { respErr } from '@/shared/lib/resp';

type AdminRouteAuthDeps = {
  getUserInfo: () => Promise<{ id: string } | null | undefined>;
  hasPermission: (userId: string, permission: string) => Promise<boolean>;
};

const defaultDeps: AdminRouteAuthDeps = {
  getUserInfo: async () => {
    const { getUserInfo } = await import('@/shared/models/user');
    return getUserInfo();
  },
  hasPermission: async (userId, permission) => {
    const { hasPermission } = await import('@/shared/services/rbac');
    return hasPermission(userId, permission);
  },
};

let authDeps = defaultDeps;

export function setAdminRouteAuthDepsForTest(
  deps: Partial<AdminRouteAuthDeps>
) {
  authDeps = { ...defaultDeps, ...deps };
}

export function resetAdminRouteAuthDepsForTest() {
  authDeps = defaultDeps;
}

export async function authorizeAdminRoute(
  permission: string
): Promise<{ operatorId: string } | { response: Response }> {
  const operator = await authDeps.getUserInfo();
  if (!operator) {
    return {
      response: withNoStore(respErr('no auth, please sign in')),
    };
  }
  if (!(await authDeps.hasPermission(operator.id, permission))) {
    return {
      response: withNoStore(respErr(`permission required: ${permission}`)),
    };
  }
  return { operatorId: operator.id };
}
