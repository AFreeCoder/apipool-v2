import { PERMISSIONS } from '@/core/rbac';
import { respData, respErr } from '@/shared/lib/resp';
import { getUserInfo } from '@/shared/models/user';
import { hasPermission } from '@/shared/services/rbac';

export async function POST() {
  try {
    // get sign user info
    const user = await getUserInfo();
    if (!user) {
      return respErr('no auth, please sign in');
    }

    // check if user is admin
    const isAdmin = await hasPermission(user.id, PERMISSIONS.ADMIN_ACCESS);

    return respData({ ...user, isAdmin });
  } catch (e) {
    console.log('get user info failed:', e);
    return respErr('get user info failed');
  }
}
