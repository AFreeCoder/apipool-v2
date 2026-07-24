import { getTranslations, setRequestLocale } from 'next-intl/server';

import { PERMISSIONS, requirePermission } from '@/core/rbac';
import { QuotaAdjustmentForm } from '@/features/api-console/components/admin/quota-adjustment-form';
import { Header, Main, MainHeader } from '@/shared/blocks/dashboard';
import { findUserById } from '@/shared/models/user';
import { Crumb } from '@/shared/types/blocks/common';

export default async function ApipoolAdjustmentsPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ portalUserId?: string }>;
}) {
  const { locale } = await params;
  const { portalUserId = '' } = await searchParams;
  setRequestLocale(locale);
  await requirePermission({
    code: PERMISSIONS.APIPOOL_QUOTA_ADJUST,
    redirectUrl: '/admin/no-permission',
    locale,
  });

  const t = await getTranslations('admin.apipoolAdjustments');

  // 带 ?portalUserId= 直达时只显示裸 UUID，管理员无法确认调的是谁
  const targetUser = portalUserId ? await findUserById(portalUserId) : null;
  const resolvedUser = targetUser
    ? `${targetUser.name} (${targetUser.email})`
    : '';

  const crumbs: Crumb[] = [
    { title: t('page.crumbs.admin'), url: '/admin' },
    { title: t('page.crumbs.current'), is_active: true },
  ];

  return (
    <>
      <Header crumbs={crumbs} />
      <Main>
        <MainHeader
          title={t('page.title')}
          description={t('page.description')}
        />
        <QuotaAdjustmentForm
          initialPortalUserId={portalUserId}
          initialResolvedUser={resolvedUser}
        />
      </Main>
    </>
  );
}
