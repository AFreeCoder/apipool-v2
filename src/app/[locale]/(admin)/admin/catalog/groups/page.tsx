import {
  CatalogGroup,
  getGroups,
} from '@/features/api-catalog/server/catalog-service';
import { getTranslations, setRequestLocale } from 'next-intl/server';

import { PERMISSIONS, requirePermission } from '@/core/rbac';
import { Header, Main, MainHeader } from '@/shared/blocks/dashboard';
import { TableCard } from '@/shared/blocks/table';
import { Crumb } from '@/shared/types/blocks/common';
import { type Table } from '@/shared/types/blocks/table';

export default async function AdminCatalogGroupsPage({
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
  const groups = (await getGroups()).map((group) => ({
    ...group,
    status: t(`statusOptions.${group.status}`),
  }));

  const crumbs: Crumb[] = [
    { title: t('crumbs.admin'), url: '/admin' },
    { title: t('crumbs.catalog'), is_active: true },
    { title: t('groups.list.crumb'), is_active: true },
  ];

  const table: Table = {
    columns: [
      { name: 'slug', title: t('fields.slug'), type: 'copy' },
      { name: 'name', title: t('fields.name') },
      { name: 'newapiGroup', title: t('fields.newapiGroup'), type: 'copy' },
      {
        name: 'allowCreateKey',
        title: t('fields.allowCreateKey'),
        callback: (item: CatalogGroup) =>
          item.allowCreateKey ? t('boolean.yes') : t('boolean.no'),
      },
      { name: 'sortOrder', title: t('fields.sortOrder') },
      { name: 'status', title: t('fields.status'), type: 'label' },
      { name: 'createdAt', title: t('fields.createdAt'), type: 'time' },
      {
        name: 'actions',
        title: t('fields.actions'),
        type: 'dropdown',
        callback: (item: CatalogGroup) => [
          {
            name: 'edit',
            title: t('actions.edit'),
            icon: 'RiEditLine',
            url: `/admin/catalog/groups/${item.id}/edit`,
          },
          {
            name: 'delete',
            title: t('actions.delete'),
            icon: 'Trash2',
            url: `/admin/catalog/groups/${item.id}/delete`,
          },
        ],
      },
    ],
    data: groups,
  };

  return (
    <>
      <Header crumbs={crumbs} />
      <Main>
        <MainHeader title={t('groups.list.title')} />
        <TableCard
          table={table}
          buttons={[
            {
              title: t('groups.list.buttons.new'),
              icon: 'Plus',
              url: '/admin/catalog/groups/new',
            },
          ]}
        />
      </Main>
    </>
  );
}
