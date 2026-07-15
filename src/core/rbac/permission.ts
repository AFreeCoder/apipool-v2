import { headers } from 'next/headers';

import { defaultLocale } from '@/config/locale';
import { redirect } from '@/core/i18n/navigation';
import { safeInternalPath } from '@/shared/lib/safe-path';
import { getSignUser } from '@/shared/models/user';
import {
  hasAllPermissions,
  hasAnyPermission,
  hasAnyRole,
  hasPermission,
  hasRole,
} from '@/shared/services/rbac';
import { PERMISSIONS as PURE_PERMISSION_CODES } from './permission-codes';

// 保留在既有模块中的声明是管理端源码契约；纯常量模块供不加载 Next.js
// Server API 的路由/单测使用。satisfies 会在两份声明发生漂移时让构建失败。
export const PERMISSIONS = {
  ADMIN_ACCESS: 'admin.access',
  USERS_READ: 'admin.users.read',
  USERS_WRITE: 'admin.users.write',
  USERS_DELETE: 'admin.users.delete',
  POSTS_READ: 'admin.posts.read',
  POSTS_WRITE: 'admin.posts.write',
  POSTS_DELETE: 'admin.posts.delete',
  CATEGORIES_READ: 'admin.categories.read',
  CATEGORIES_WRITE: 'admin.categories.write',
  CATEGORIES_DELETE: 'admin.categories.delete',
  PAYMENTS_READ: 'admin.payments.read',
  SUBSCRIPTIONS_READ: 'admin.subscriptions.read',
  CREDITS_READ: 'admin.credits.read',
  CREDITS_WRITE: 'admin.credits.write',
  APIPOOL_QUOTA_ADJUST: 'admin.apipool.quota.adjust',
  APIPOOL_ROUTING_READ: 'admin.apipool.routing.read',
  APIPOOL_ROUTING_WRITE: 'admin.apipool.routing.write',
  APIPOOL_WALLET_READ: 'admin.apipool.wallet.read',
  APIPOOL_WALLET_ADJUST: 'admin.apipool.wallet.adjust',
  APIPOOL_WALLET_FREEZE: 'admin.apipool.wallet.freeze',
  APIPOOL_RECONCILIATION_READ: 'admin.apipool.reconciliation.read',
  APIPOOL_RECONCILIATION_RESOLVE:
    'admin.apipool.reconciliation.resolve',
  APIKEYS_READ: 'admin.apikeys.read',
  APIKEYS_WRITE: 'admin.apikeys.write',
  APIKEYS_DELETE: 'admin.apikeys.delete',
  SETTINGS_READ: 'admin.settings.read',
  SETTINGS_WRITE: 'admin.settings.write',
  CATALOG_READ: 'admin.catalog.read',
  CATALOG_WRITE: 'admin.catalog.write',
  ROLES_READ: 'admin.roles.read',
  ROLES_WRITE: 'admin.roles.write',
  ROLES_DELETE: 'admin.roles.delete',
  PERMISSIONS_READ: 'admin.permissions.read',
  PERMISSIONS_WRITE: 'admin.permissions.write',
  PERMISSIONS_DELETE: 'admin.permissions.delete',
  AITASKS_READ: 'admin.ai-tasks.read',
  AITASKS_WRITE: 'admin.ai-tasks.write',
  AITASKS_DELETE: 'admin.ai-tasks.delete',
} as const satisfies typeof PURE_PERMISSION_CODES;

/**
 * Permission guard error
 */
export class PermissionDeniedError extends Error {
  constructor(message = 'Permission denied') {
    super(message);
    this.name = 'PermissionDeniedError';
  }
}

/**
 * Check if user can access admin area
 */
export async function canAccessAdmin(userId: string): Promise<boolean> {
  return await hasPermission(userId, PERMISSIONS.ADMIN_ACCESS);
}

/**
 * Check if current user has permission, throw error if not
 */
export async function requirePermission({
  code,
  redirectUrl,
  locale,
}: {
  code: string;
  redirectUrl?: string;
  locale?: string;
}): Promise<void> {
  const user = await getSignUser();

  if (!user) {
    if (redirectUrl) {
      redirect({ href: redirectUrl, locale: locale || '' });
    }
    throw new PermissionDeniedError('User not authenticated');
  }

  const allowed = await hasPermission(user.id, code);

  if (!allowed) {
    if (redirectUrl) {
      redirect({ href: redirectUrl, locale: locale || '' });
    }
    throw new PermissionDeniedError(`Permission required: ${code}`);
  }
}

/**
 * Check if current user has any of the permissions, throw error if not
 */
export async function requireAnyPermission({
  codes,
  redirectUrl,
  locale,
}: {
  codes: string[];
  redirectUrl?: string;
  locale?: string;
}): Promise<void> {
  const user = await getSignUser();

  if (!user) {
    if (redirectUrl) {
      redirect({ href: redirectUrl, locale: locale || '' });
    }
    throw new PermissionDeniedError('User not authenticated');
  }

  const allowed = await hasAnyPermission(user.id, codes);

  if (!allowed) {
    if (redirectUrl) {
      redirect({ href: redirectUrl, locale: locale || '' });
    }
    throw new PermissionDeniedError(
      `Any of these permissions required: ${codes.join(', ')}`
    );
  }
}

/**
 * Check if current user has all of the permissions, throw error if not
 */
export async function requireAllPermissions({
  codes,
  redirectUrl,
  locale,
}: {
  codes: string[];
  redirectUrl?: string;
  locale?: string;
}): Promise<void> {
  const user = await getSignUser();

  if (!user) {
    if (redirectUrl) {
      redirect({ href: redirectUrl, locale: locale || '' });
    }
    throw new PermissionDeniedError('User not authenticated');
  }

  const allowed = await hasAllPermissions(user.id, codes);

  if (!allowed) {
    if (redirectUrl) {
      redirect({ href: redirectUrl, locale: locale || '' });
    }
    throw new PermissionDeniedError(
      `All of these permissions required: ${codes.join(', ')}`
    );
  }
}

/**
 * Check if current user has role, throw error if not
 */
export async function requireRole({
  roleName,
  redirectUrl,
  locale,
}: {
  roleName: string;
  redirectUrl?: string;
  locale?: string;
}): Promise<void> {
  const user = await getSignUser();

  if (!user) {
    if (redirectUrl) {
      redirect({ href: redirectUrl, locale: locale || '' });
    }
    throw new PermissionDeniedError('User not authenticated');
  }

  const allowed = await hasRole(user.id, roleName);

  if (!allowed) {
    if (redirectUrl) {
      redirect({ href: redirectUrl, locale: locale || '' });
    }
    throw new PermissionDeniedError(`Role required: ${roleName}`);
  }
}

/**
 * Check if current user has any of the roles, throw error if not
 */
export async function requireAnyRole({
  roleNames,
  redirectUrl,
  locale,
}: {
  roleNames: string[];
  redirectUrl?: string;
  locale?: string;
}): Promise<void> {
  const user = await getSignUser();

  if (!user) {
    if (redirectUrl) {
      redirect({ href: redirectUrl, locale: locale || '' });
    }
    throw new PermissionDeniedError('User not authenticated');
  }

  const allowed = await hasAnyRole(user.id, roleNames);

  if (!allowed) {
    if (redirectUrl) {
      redirect({ href: redirectUrl, locale: locale || '' });
    }
    throw new PermissionDeniedError(
      `Any of these roles required: ${roleNames.join(', ')}`
    );
  }
}

/**
 * Check if current user can access admin area
 */
export async function requireAdminAccess({
  redirectUrl,
  locale,
}: {
  redirectUrl?: string;
  locale?: string;
}): Promise<void> {
  const user = await getSignUser();

  if (!user) {
    // Send the operator back to the admin page they asked for after
    // signing in (deep links otherwise land on the site home). Mirrors
    // the dashboard layout: proxy.ts writes the path into x-pathname.
    const pathname = (await headers()).get('x-pathname') || '';
    const safe = safeInternalPath(pathname);
    const stripped =
      locale && locale !== defaultLocale && safe.startsWith(`/${locale}/`)
        ? safe.slice(locale.length + 1)
        : safe;
    const callbackUrl = stripped.startsWith('/admin') ? stripped : '/admin';
    redirect({
      href: `/sign-in?callbackUrl=${encodeURIComponent(callbackUrl)}`,
      locale: locale || '',
    });
  }

  const allowed = await canAccessAdmin(user!.id);

  if (!allowed) {
    redirect({ href: redirectUrl || '', locale: locale || '' });
  }
}

/**
 * Get current user with permission check
 * Returns null if user doesn't have permission
 */
export async function getCurrentUserWithPermission({
  code,
  locale,
}: {
  code: string;
  locale?: string;
}): Promise<{ id: string; email: string; name: string } | null> {
  const user = await getSignUser();
  if (!user) return null;

  const allowed = await hasPermission(user.id, code);
  if (!allowed) return null;

  return user;
}

/**
 * Check page access permissions
 * Returns true if user has access, false otherwise
 */
export async function checkPageAccess({
  codes,
  locale,
}: {
  codes: string[];
  locale?: string;
}): Promise<boolean> {
  const user = await getSignUser();
  if (!user) return false;

  return await hasAnyPermission(user.id, codes);
}

/**
 * Higher-order function for API routes with permission check
 */
export function withPermission<T extends (...args: any[]) => any>(
  handler: T,
  {
    code,
    locale,
  }: {
    code: string;
    locale?: string;
  }
): T {
  return (async (...args: Parameters<T>) => {
    await requirePermission({ code, locale });
    return handler(...args);
  }) as T;
}

/**
 * Higher-order function for API routes with role check
 */
export function withRole<T extends (...args: any[]) => any>(
  handler: T,
  {
    roleName,
    locale,
  }: {
    roleName: string;
    locale?: string;
  }
): T {
  return (async (...args: Parameters<T>) => {
    await requireRole({ roleName, locale });
    return handler(...args);
  }) as T;
}
