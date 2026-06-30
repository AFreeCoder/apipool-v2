import { setRequestLocale } from 'next-intl/server';

import { PERMISSIONS, requirePermission } from '@/core/rbac';
import { QuotaAdjustmentForm } from '@/features/api-console/components/admin/quota-adjustment-form';
import { Header, Main, MainHeader } from '@/shared/blocks/dashboard';
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

  const crumbs: Crumb[] = [
    { title: 'Admin', url: '/admin' },
    { title: 'Quota adjustments', is_active: true },
  ];

  return (
    <>
      <Header crumbs={crumbs} />
      <Main>
        <MainHeader
          title="APIPool quota adjustments"
          description="MVP-only operator flow. Every adjustment writes APIPool ledger v0 and then calls the internal quota executor."
        />
        <QuotaAdjustmentForm initialPortalUserId={portalUserId} />
      </Main>
    </>
  );
}
