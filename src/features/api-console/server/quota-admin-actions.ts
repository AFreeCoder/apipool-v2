'use server';

import { PERMISSIONS, requirePermission } from '@/core/rbac';
import { findUsersByExactEmail } from '@/shared/models/user';

export type PortalUserLookupResult = {
  id: string;
  name: string;
  email: string;
} | null;

/**
 * 按 email 精确查找门户用户，用于调额页（管理员通常知道邮箱而非内部 UUID）。
 * 二次鉴权与调额页门控一致（APIPOOL_QUOTA_ADJUST）。
 *
 * 这里刻意使用大小写不敏感的「精确」匹配，而非用户列表的模糊 LIKE：
 * 调额直接改动余额，命中错误的用户即资损；模糊匹配可能返回多个/错误用户，
 * 因此要求唯一命中。0 命中或 >1 命中一律返回 null（视为「未找到」，
 * 管理员可改为直接粘贴 UUID）。
 */
export async function lookupPortalUserByEmail(
  email: string
): Promise<PortalUserLookupResult> {
  await requirePermission({ code: PERMISSIONS.APIPOOL_QUOTA_ADJUST });

  const trimmed = email.trim();
  if (!trimmed) return null;

  const matches = await findUsersByExactEmail(trimmed);
  if (matches.length !== 1) return null;

  const [found] = matches;
  return { id: found.id, name: found.name, email: found.email };
}
