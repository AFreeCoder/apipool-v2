import {
  getModels,
  getVendors,
  Model,
} from '@/features/api-catalog/server/catalog-service';
import { getTranslations, setRequestLocale } from 'next-intl/server';

import { PERMISSIONS, requirePermission } from '@/core/rbac';
import { Header, Main, MainHeader } from '@/shared/blocks/dashboard';
import { TableCard } from '@/shared/blocks/table';
import { Crumb } from '@/shared/types/blocks/common';
import { type Table } from '@/shared/types/blocks/table';

type ModelRow = Model & {
  vendorName: string;
};

export default async function AdminCatalogModelsPage({
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
  const vendors = await getVendors();
  const vendorNames = new Map(
    vendors.map((vendor) => [vendor.id, vendor.name] as const)
  );
  const models: ModelRow[] = (await getModels()).map((model) => ({
    ...model,
    vendorName: vendorNames.get(model.vendorId) ?? model.vendorId,
  }));

  const crumbs: Crumb[] = [
    { title: t('crumbs.admin'), url: '/admin' },
    { title: t('crumbs.catalog'), is_active: true },
    { title: t('models.list.crumb'), is_active: true },
  ];

  const table: Table = {
    columns: [
      {
        name: 'modelId',
        title: t('fields.modelId'),
        type: 'copy',
        className: 'font-mono text-xs',
      },
      { name: 'displayName', title: t('fields.displayName') },
      { name: 'vendorName', title: t('fields.vendor') },
      { name: 'category', title: t('fields.category') },
      {
        name: 'contextWindow',
        title: t('fields.contextWindow'),
        className: 'font-mono text-xs',
      },
      { name: 'createdAt', title: t('fields.createdAt'), type: 'time' },
      {
        name: 'actions',
        title: t('fields.actions'),
        type: 'dropdown',
        callback: (item: ModelRow) => [
          {
            name: 'edit',
            title: t('actions.edit'),
            icon: 'RiEditLine',
            url: `/admin/catalog/models/${item.id}/edit`,
          },
          {
            name: 'capabilities',
            title: t('actions.capabilities'),
            icon: 'Tags',
            url: `/admin/catalog/models/${item.id}/capabilities`,
          },
          {
            name: 'listings',
            title: t('actions.listings'),
            icon: 'ListChecks',
            url: `/admin/catalog/models/${item.id}/listings`,
          },
        ],
      },
    ],
    data: models,
  };

  return (
    <>
      <Header crumbs={crumbs} />
      <Main>
        <MainHeader title={t('models.list.title')} />
        <TableCard
          table={table}
          buttons={[
            {
              title: t('models.list.buttons.new'),
              icon: 'Plus',
              url: '/admin/catalog/models/new',
            },
          ]}
        />
      </Main>
    </>
  );
}
