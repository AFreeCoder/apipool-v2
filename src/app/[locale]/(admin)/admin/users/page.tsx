import { getTranslations } from 'next-intl/server';

import { Link } from '@/core/i18n/navigation';
import { PERMISSIONS, requirePermission } from '@/core/rbac';
import { Header, Main, MainHeader } from '@/shared/blocks/dashboard';
import { TableCard } from '@/shared/blocks/table';
import { Badge } from '@/shared/components/ui/badge';
import {
  getUserInfo,
  getUserRolesForUserIds,
  getUsers,
  getUsersCount,
  User,
} from '@/shared/models/user';
import { hasPermission } from '@/shared/services/rbac';
import { Crumb, Search } from '@/shared/types/blocks/common';
import { type Table } from '@/shared/types/blocks/table';

type AdminUsersSearchParams = {
  page?: number;
  pageSize?: number;
  email?: string;
  newApiBindingStatus?: string;
  lastSyncErrorCode?: string;
  ledger?: string;
};

type StatusTranslator = ((key: string) => string) & {
  has: (key: string) => boolean;
};

function translateStatus(
  t: StatusTranslator,
  prefix: string,
  value: string | null | undefined,
  fallback: string
) {
  if (!value) return fallback;
  const key = `${prefix}.${value}`;
  // next-intl v4 does not throw on a missing key — it logs a warning and
  // echoes the full key path (e.g. `admin.users.detail.status.binding.xxx`).
  // The old try/catch was a dead guard; probe with `t.has` so an unmapped
  // status falls back to its raw value instead of leaking the key path.
  return t.has(key) ? t(key) : value;
}

const activePillClass =
  'border-primary bg-primary text-primary-foreground rounded-md border px-3 py-1.5 text-sm';
const inactivePillClass =
  'border-input bg-background hover:bg-accent hover:text-accent-foreground rounded-md border px-3 py-1.5 text-sm';

function pillClass(active: boolean) {
  return active ? activePillClass : inactivePillClass;
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
    ledger,
  } = await searchParams;
  const page = pageNum || 1;
  const limit = pageSize || 30;
  const userFilters = {
    email,
    newApiBindingStatus,
    lastSyncErrorCode,
    unresolvedLedger: ledger === 'unresolved',
  };
  const currentSearchParams = {
    page: pageNum,
    pageSize,
    email,
    newApiBindingStatus,
    lastSyncErrorCode,
    ledger,
  };

  const total = await getUsersCount(userFilters);
  const users = await getUsers({
    ...userFilters,
    page,
    limit,
  });

  // Batch-load roles for the whole page in one query instead of calling
  // getUserRoles per row (30 rows = 30 extra queries).
  const rolesByUser = await getUserRolesForUserIds(users.map((u) => u.id));

  const hasActiveStatusFilter =
    Boolean(newApiBindingStatus) ||
    Boolean(lastSyncErrorCode) ||
    Boolean(ledger);

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
        // Truncate the UUID so it stops eating ~300px and pushing the SYNC
        // columns off-screen; the copy button still copies the full id.
        callback: (item: User) => (
          <span title={item.id}>{`${item.id.slice(0, 8)}…`}</span>
        ),
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
        callback: (item: User) => item.newApiBinding?.lastSyncErrorCode || '-',
      },
      {
        name: 'roles',
        title: t('fields.roles'),
        callback: (item: User) => {
          const roles = rolesByUser.get(item.id) ?? [];

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
      {
        name: 'ip',
        title: t('fields.ip'),
        type: 'copy',
        className: 'font-mono text-xs',
      },
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
            className={pillClass(!hasActiveStatusFilter)}
            href={usersFilterHref(currentSearchParams, {
              newApiBindingStatus: undefined,
              lastSyncErrorCode: undefined,
              ledger: undefined,
            })}
          >
            {t('list.filters.all')}
          </Link>
          <Link
            className={pillClass(
              newApiBindingStatus === 'username_sync_failed'
            )}
            href={usersFilterHref(currentSearchParams, {
              newApiBindingStatus: 'username_sync_failed',
              lastSyncErrorCode: undefined,
              ledger: undefined,
            })}
          >
            {t('list.filters.username_sync_failed')}
          </Link>
          <Link
            className={pillClass(
              newApiBindingStatus === 'conflict_requires_review'
            )}
            href={usersFilterHref(currentSearchParams, {
              newApiBindingStatus: 'conflict_requires_review',
              lastSyncErrorCode: undefined,
              ledger: undefined,
            })}
          >
            {t('list.filters.conflict_requires_review')}
          </Link>
          <Link
            className={pillClass(
              lastSyncErrorCode === 'newapi_username_too_long'
            )}
            href={usersFilterHref(currentSearchParams, {
              lastSyncErrorCode: 'newapi_username_too_long',
              newApiBindingStatus: undefined,
              ledger: undefined,
            })}
          >
            {t('list.filters.newapi_username_too_long')}
          </Link>
          {/* 对账告警的落点：结清入口在用户详情页的账本行上 */}
          <Link
            className={pillClass(ledger === 'unresolved')}
            href={usersFilterHref(currentSearchParams, {
              ledger: 'unresolved',
              newApiBindingStatus: undefined,
              lastSyncErrorCode: undefined,
            })}
          >
            {t('list.filters.unresolved_ledger')}
          </Link>
        </div>
        <TableCard table={table} />
      </Main>
    </>
  );
}
