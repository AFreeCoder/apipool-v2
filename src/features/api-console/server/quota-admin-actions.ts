'use server';

import { PERMISSIONS, requirePermission } from '@/core/rbac';
import { getUsers } from '@/shared/models/user';

export type PortalUserLookupResult = {
  id: string;
  name: string;
  email: string;
} | null;

/**
 * 按 email 精确查找门户用户，用于调额页（管理员通常知道邮箱而非内部 UUID）。
 * 二次鉴权与调额页门控一致（APIPOOL_QUOTA_ADJUST）。
 */
export async function lookupPortalUserByEmail(
  email: string
): Promise<PortalUserLookupResult> {
  await requirePermission({ code: PERMISSIONS.APIPOOL_QUOTA_ADJUST });

  const trimmed = email.trim();
  if (!trimmed) return null;

  const [found] = await getUsers({ email: trimmed, limit: 1 });
  if (!found) return null;

  return { id: found.id, name: found.name, email: found.email };
}
