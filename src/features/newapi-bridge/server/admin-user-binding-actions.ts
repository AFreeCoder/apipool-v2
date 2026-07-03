'use server';

import { PERMISSIONS, requirePermission } from '@/core/rbac';
import { getUserInfo } from '@/shared/models/user';

import {
  confirmNewapiUserConflictForAdmin,
  disableNewapiUserBindingForAdmin,
  retryNewapiUserBindingForAdmin,
} from './portal';

async function getCurrentAdminUser() {
  const currentUser = await getUserInfo();
  if (!currentUser?.id) {
    throw new Error('admin user session required');
  }
  return currentUser;
}

export async function retryNewapiUserBindingAction(input: {
  portalUserId: string;
}) {
  await requirePermission({ code: PERMISSIONS.USERS_WRITE });
  const currentUser = await getCurrentAdminUser();
  return retryNewapiUserBindingForAdmin({
    ...input,
    operatorUserId: currentUser.id,
  });
}

export async function confirmNewapiUserConflictAction(input: {
  portalUserId: string;
  newapiUserId: string;
}) {
  await requirePermission({ code: PERMISSIONS.USERS_WRITE });
  const currentUser = await getCurrentAdminUser();
  return confirmNewapiUserConflictForAdmin({
    ...input,
    operatorUserId: currentUser.id,
  });
}

export async function disableNewapiUserBindingAction(input: {
  portalUserId: string;
  reason: string;
}) {
  await requirePermission({ code: PERMISSIONS.USERS_WRITE });
  const currentUser = await getCurrentAdminUser();
  return disableNewapiUserBindingForAdmin({
    ...input,
    operatorUserId: currentUser.id,
  });
}
