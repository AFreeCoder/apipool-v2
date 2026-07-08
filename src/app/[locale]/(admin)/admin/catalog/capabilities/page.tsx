import {
  Capability,
  getCapabilities,
} from '@/features/api-catalog/server/catalog-service';
import { getTranslations, setRequestLocale } from 'next-intl/server';

import { PERMISSIONS, requirePermission } from '@/core/rbac';
import { Header, Main, MainHeader } from '@/shared/blocks/dashboard';
import { TableCard } from '@/shared/blocks/table';
import { Crumb } from '@/shared/types/blocks/common';
import { type Table } from '@/shared/types/blocks/table';

export default async function AdminCatalogCapabilitiesPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);

  await requirePermission({
    code: PERMISSIONS.CATALOG_READ,
    redirectUrl: '/admin/no-permission',
    locale,
  });

  const t = await getTranslations('admin.catalog');
  const capabilities = (await getCapabilities()).map((capability) => ({
    ...capability,
    status: t(`statusOptions.${capability.status}`),
  }));

  const crumbs: Crumb[] = [
    { title: t('crumbs.admin'), url: '/admin' },
    { title: t('crumbs.catalog'), is_active: true },
    { title: t('capabilities.list.crumb'), is_active: true },
  ];

  const table: Table = {
    columns: [
      { name: 'slug', title: t('fields.slug'), type: 'copy' },
      { name: 'name', title: t('fields.name') },
      { name: 'sortOrder', title: t('fields.sortOrder') },
      { name: 'status', title: t('fields.status'), type: 'label' },
      { name: 'createdAt', title: t('fields.createdAt'), type: 'time' },
      {
        name: 'actions',
        title: t('fields.actions'),
        type: 'dropdown',
        callback: (item: Capability) => [
          {
            name: 'edit',
            title: t('actions.edit'),
            icon: 'RiEditLine',
            url: `/admin/catalog/capabilities/${item.id}/edit`,
          },
          {
            name: 'delete',
            title: t('actions.delete'),
            icon: 'Trash2',
            url: `/admin/catalog/capabilities/${item.id}/delete`,
          },
        ],
      },
    ],
    data: capabilities,
  };

  return (
    <>
      <Header crumbs={crumbs} />
      <Main>
        <MainHeader title={t('capabilities.list.title')} />
        <TableCard
          table={table}
          buttons={[
            {
              title: t('capabilities.list.buttons.new'),
              icon: 'Plus',
              url: '/admin/catalog/capabilities/new',
            },
          ]}
        />
      </Main>
    </>
  );
}
