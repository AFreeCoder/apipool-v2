import { getTranslations, setRequestLocale } from 'next-intl/server';

import { PERMISSIONS, requirePermission } from '@/core/rbac';
import { ApipoolWorkbench } from '@/features/routing-admin/components/workbench';
import { Header, Main, MainHeader } from '@/shared/blocks/dashboard';
import type { Crumb } from '@/shared/types/blocks/common';

export default async function AdminApipoolPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  await requirePermission({
    code: PERMISSIONS.APIPOOL_ROUTING_READ,
    redirectUrl: '/admin/no-permission',
    locale,
  });
  const t = await getTranslations('admin.apipool');
  const crumbs: Crumb[] = [
    { title: t('crumbs.admin'), url: '/admin' },
    { title: t('crumbs.operations'), is_active: true },
    { title: t('title'), is_active: true },
  ];

  return (
    <>
      <Header crumbs={crumbs} />
      <Main>
        <MainHeader title={t('title')} description={t('description')} />
        <ApipoolWorkbench />
      </Main>
    </>
  );
}
