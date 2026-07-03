import { getTranslations } from 'next-intl/server';

import { Link } from '@/core/i18n/navigation';
import { PERMISSIONS, requirePermission } from '@/core/rbac';
import { Header, Main, MainHeader } from '@/shared/blocks/dashboard';
import { TableCard } from '@/shared/blocks/table';
import { Badge } from '@/shared/components/ui/badge';
import {
  getUserInfo,
  getUsers,
  getUsersCount,
  User,
} from '@/shared/models/user';
import { getUserRoles, hasPermission } from '@/shared/services/rbac';
import { Crumb, Search } from '@/shared/types/blocks/common';
import { type Table } from '@/shared/types/blocks/table';

type AdminUsersSearchParams = {
  page?: number;
  pageSize?: number;
  email?: string;
  newApiBindingStatus?: string;
  lastSyncErrorCode?: string;
};

function translateStatus(
  t: (key: string) => string,
  prefix: string,
  value: string | null | undefined,
  fallback: string
) {
  if (!value) return fallback;
  try {
    return t(`${prefix}.${value}`);
  } catch {
    return value;
  }
}

function statusVariant(status: string | null | undefined) {
  if (status === 'username_sync_failed') {
    return 'destructive' as const;
  }
  if (status === 'active') {
    return 'default' as const;
  }
  return 'secondary' as const;
}

function usersFilterHref(
  current: AdminUsersSearchParams,
  patch: Partial<AdminUsersSearchParams>
) {
  const params = new URLSearchParams();
  const nextParams = { ...current, ...patch, page: undefined };

  for (const [key, value] of Object.entries(nextParams)) {
    if (value === undefined || value === null || value === '') continue;
    params.set(key, String(value));
  }

  const query = params.toString();
  return query ? `/admin/users?${query}` : '/admin/users';
}

export default async function AdminUsersPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<AdminUsersSearchParams>;
}) {
  const { locale } = await params;

  // Check if user has permission to read users
  await requirePermission({
    code: PERMISSIONS.USERS_READ,
    redirectUrl: '/admin/no-permission',
    locale,
  });
  const currentUser = await getUserInfo();
  const canAdjustApipoolQuota = currentUser
    ? await hasPermission(currentUser.id, PERMISSIONS.APIPOOL_QUOTA_ADJUST)
    : false;

  const t = await getTranslations('admin.users');

  const {
    page: pageNum,
    pageSize,
    email,
    newApiBindingStatus,
    lastSyncErrorCode,
  } = await searchParams;
  const page = pageNum || 1;
  const limit = pageSize || 30;
  const userFilters = { email, newApiBindingStatus, lastSyncErrorCode };
  const currentSearchParams = {
    page: pageNum,
    pageSize,
    email,
    newApiBindingStatus,
    lastSyncErrorCode,
  };

  const total = await getUsersCount(userFilters);
  const users = await getUsers({
    ...userFilters,
    page,
    limit,
  });

  const crumbs: Crumb[] = [
    { title: t('list.crumbs.admin'), url: '/admin' },
    { title: t('list.crumbs.users'), is_active: true },
  ];

  const search: Search = {
    name: 'email',
    title: t('list.search.email.title'),
    placeholder: t('list.search.email.placeholder'),
    value: email,
  };

  const table: Table = {
    columns: [
      {
        name: 'id',
        title: t('fields.id'),
        type: 'copy',
        className: 'font-mono text-xs',
      },
      { name: 'name', title: t('fields.name') },
      {
        name: 'image',
        title: t('fields.avatar'),
        type: 'image',
        placeholder: '-',
      },
      { name: 'email', title: t('fields.email'), type: 'copy' },
      {
        name: 'newApiBinding',
        title: t('fields.newapi_binding_status'),
        callback: (item: User) => (
          <Badge variant={statusVariant(item.newApiBinding?.status)}>
            {translateStatus(
              t,
              'detail.status.binding',
              item.newApiBinding?.status,
              '-'
            )}
          </Badge>
        ),
      },
      {
        name: 'newApiBindingError',
        title: t('fields.newapi_sync_error'),
        callback: (item: User) =>
          item.newApiBinding?.lastSyncErrorCode || '-',
      },
      {
        name: 'roles',
        title: t('fields.roles'),
        callback: async (item: User) => {
          const roles = await getUserRoles(item.id);

          return (
            <div className="flex flex-col gap-2">
              {roles.map((role) => (
                <Badge key={role.id} variant="outline">
                  {role.title}
                </Badge>
              ))}
            </div>
          );
        },
      },
      {
        name: 'emailVerified',
        title: t('fields.email_verified'),
        type: 'label',
        placeholder: '-',
      },
      { name: 'createdAt', title: t('fields.created_at'), type: 'time' },
      { name: 'ip', title: t('fields.ip'), type: 'copy', className: 'font-mono text-xs' },
      { name: 'locale', title: t('fields.locale') },
      { name: 'utmSource', title: t('fields.utm_source') },
      {
        name: 'actions',
        title: t('fields.actions'),
        type: 'dropdown',
        callback: (item: User) => [
          {
            name: 'view-detail',
            title: t('list.buttons.view_detail'),
            icon: 'Eye',
            url: `/admin/users/${item.id}/detail`,
          },
          {
            name: 'edit',
            title: t('list.buttons.edit'),
            icon: 'RiEditLine',
            url: `/admin/users/${item.id}/edit`,
          },
          {
            name: 'edit-roles',
            title: t('list.buttons.edit_roles'),
            icon: 'Users',
            url: `/admin/users/${item.id}/edit-roles`,
          },
          ...(canAdjustApipoolQuota
            ? [
                {
                  name: 'adjust-quota',
                  title: t('list.buttons.adjust_quota'),
                  icon: 'Gauge',
                  url: `/admin/apipool-adjustments?portalUserId=${item.id}`,
                },
              ]
            : []),
        ],
      },
    ],
    data: users,
    pagination: {
      total,
      page,
      limit,
    },
  };

  return (
    <>
      <Header crumbs={crumbs} />
      <Main>
        <MainHeader title={t('list.title')} search={search} />
        <div className="mb-4 flex flex-wrap gap-2">
          <Link
            className="border-input bg-background hover:bg-accent hover:text-accent-foreground rounded-md border px-3 py-1.5 text-sm"
            href={usersFilterHref(currentSearchParams, {
              newApiBindingStatus: 'username_sync_failed',
            })}
          >
            {t('list.filters.username_sync_failed')}
          </Link>
          <Link
            className="border-input bg-background hover:bg-accent hover:text-accent-foreground rounded-md border px-3 py-1.5 text-sm"
            href={usersFilterHref(currentSearchParams, {
              newApiBindingStatus: 'conflict_requires_review',
            })}
          >
            {t('list.filters.conflict_requires_review')}
          </Link>
          <Link
            className="border-input bg-background hover:bg-accent hover:text-accent-foreground rounded-md border px-3 py-1.5 text-sm"
            href={usersFilterHref(currentSearchParams, {
              lastSyncErrorCode: 'newapi_username_too_long',
            })}
          >
            {t('list.filters.newapi_username_too_long')}
          </Link>
        </div>
        <TableCard table={table} />
      </Main>
    </>
  );
}
