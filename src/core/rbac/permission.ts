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
import { PERMISSIONS } from './permission-codes';

export { PERMISSIONS } from './permission-codes';

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
