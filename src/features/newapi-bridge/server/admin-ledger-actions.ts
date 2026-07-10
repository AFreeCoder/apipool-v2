'use server';

import { PERMISSIONS, requirePermission } from '@/core/rbac';
import { getUserInfo } from '@/shared/models/user';

import { resolveQuotaAdjustment } from './portal';

/**
 * 人工结清一条卡住的调额/充值账本行。这是 fail-closed 守卫唯一的解封出口，
 * 因此按最高危权限（调额权限）门控，而不是 USERS_WRITE。
 */
export async function resolveQuotaAdjustmentAction(input: {
  ledgerId: string;
  resolution: 'confirm_applied' | 'mark_void';
  note: string;
}) {
  await requirePermission({ code: PERMISSIONS.APIPOOL_QUOTA_ADJUST });
  const operator = await getUserInfo();
  if (!operator?.id) {
    throw new Error('admin user session required');
  }

  await resolveQuotaAdjustment({
    ledgerId: input.ledgerId,
    operatorUserId: operator.id,
    resolution: input.resolution,
    note: input.note,
  });
}
