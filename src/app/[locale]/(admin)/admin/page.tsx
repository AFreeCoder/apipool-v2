import { getTranslations, setRequestLocale } from 'next-intl/server';

import { PERMISSIONS } from '@/core/rbac';
import { AdminOverview } from '@/features/api-console/components/admin/admin-overview';
import { getAdminOverviewSignals } from '@/features/api-console/server/admin-overview';
import { Header, Main, MainHeader } from '@/shared/blocks/dashboard';
import { getSignUser } from '@/shared/models/user';
import { hasPermission } from '@/shared/services/rbac';
import { Crumb } from '@/shared/types/blocks/common';

/**
 * 后台首页 = 运维信号 overview。对全体 `admin.access` 开放，不要求任何额外
 * 权限——这里是所有面包屑「管理后台」与侧栏品牌链接的落点，绝不能再无条件
 * 跳到需要 `APIPOOL_QUOTA_ADJUST` 的调额页（低权限角色一进后台就被弹走）。
 * 资金卡片按权限渲染；读列表的跳转链接按各自读权限出现。
 */
export default async function AdminPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);

  const t = await getTranslations('admin.overview');

  const user = await getSignUser();
  const [canAdjustQuota, canReadUsers, canReadCatalog] = user
    ? await Promise.all([
        hasPermission(user.id, PERMISSIONS.APIPOOL_QUOTA_ADJUST),
        hasPermission(user.id, PERMISSIONS.USERS_READ),
        hasPermission(user.id, PERMISSIONS.CATALOG_READ),
      ])
    : [false, false, false];

  const signals = await getAdminOverviewSignals();

  const crumbs: Crumb[] = [{ title: t('page.crumb'), is_active: true }];

  return (
    <>
      <Header crumbs={crumbs} />
      <Main>
        <MainHeader
          title={t('page.title')}
          description={t('page.description')}
        />
        <AdminOverview
          signals={signals}
          canAdjustQuota={canAdjustQuota}
          canReadUsers={canReadUsers}
          canReadCatalog={canReadCatalog}
        />
      </Main>
    </>
  );
}
