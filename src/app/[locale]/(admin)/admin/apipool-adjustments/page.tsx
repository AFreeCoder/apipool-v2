import { setRequestLocale } from 'next-intl/server';

import { PERMISSIONS, requirePermission } from '@/core/rbac';
import { QuotaAdjustmentForm } from '@/features/api-console/components/admin/quota-adjustment-form';

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

  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold">APIPool quota adjustments</h1>
        <p className="mt-2 text-muted-foreground">
          MVP-only operator flow. Every adjustment writes APIPool ledger v0 and
          then calls the internal quota executor.
        </p>
      </div>
      <QuotaAdjustmentForm initialPortalUserId={portalUserId} />
    </div>
  );
}
