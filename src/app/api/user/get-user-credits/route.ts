import { respErr } from '@/shared/lib/resp';
import { getUserInfo } from '@/shared/models/user';

export async function POST() {
  try {
    const user = await getUserInfo();
    if (!user) {
      return respErr('no auth, please sign in');
    }

    return respErr('Legacy credits are disabled for APIPool billing; use /dashboard/billing');
  } catch (e) {
    console.log('get user credits failed:', e);
    return respErr('get user credits failed');
  }
}
