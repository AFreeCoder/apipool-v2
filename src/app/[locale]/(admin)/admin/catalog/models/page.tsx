import { getTranslations, setRequestLocale } from 'next-intl/server';

import { PERMISSIONS, requirePermission } from '@/core/rbac';
import {
  getModelAdminRows,
  ModelAdminRow,
} from '@/features/api-catalog/server/catalog-service';
import { Header, Main, MainHeader } from '@/shared/blocks/dashboard';
import { TableCard } from '@/shared/blocks/table';
import { Crumb } from '@/shared/types/blocks/common';
import { type Table } from '@/shared/types/blocks/table';

import { CatalogPricingSyncControls } from './pricing-sync-controls';

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
  const models = await getModelAdminRows();

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
      { name: 'categoryNames', title: t('fields.categories') },
      { name: 'capabilityNames', title: t('fields.capabilities') },
      {
        name: 'inputPrice',
        title: t('fields.inputMicroUsd'),
        className: 'font-mono text-xs',
      },
      {
        name: 'outputPrice',
        title: t('fields.outputMicroUsd'),
        className: 'font-mono text-xs',
      },
      {
        name: 'imageInputPrice',
        title: t('fields.imageInputMicroUsd'),
        className: 'font-mono text-xs',
      },
      {
        name: 'imageOutputPrice',
        title: t('fields.imageOutputMicroUsd'),
        className: 'font-mono text-xs',
      },
      { name: 'createdAt', title: t('fields.createdAt'), type: 'time' },
      {
        name: 'actions',
        title: t('fields.actions'),
        type: 'dropdown',
        callback: (item: ModelAdminRow) => [
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
          {
            name: 'delete',
            title: t('actions.delete'),
            icon: 'Trash2',
            url: `/admin/catalog/models/${item.id}/delete`,
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
        <CatalogPricingSyncControls
          labels={{
            title: t('models.pricingSync.title'),
            description: t('models.pricingSync.description'),
            sync: t('models.pricingSync.sync'),
            syncing: t('models.pricingSync.syncing'),
            drift: t('models.pricingSync.drift'),
            loading: t('models.pricingSync.loading'),
            success: t('models.pricingSync.success'),
            error: t('models.pricingSync.error'),
          }}
        />
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
