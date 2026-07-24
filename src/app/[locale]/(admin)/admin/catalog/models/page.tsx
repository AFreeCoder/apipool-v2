import { getTranslations, setRequestLocale } from 'next-intl/server';

import { PERMISSIONS, requirePermission } from '@/core/rbac';
import {
  getModelAdminRows,
  ModelAdminRow,
  type ModelAdminPriceMeterKey,
} from '@/features/api-catalog/server/catalog-service';
import { Header, Main, MainHeader } from '@/shared/blocks/dashboard';
import { TableCard } from '@/shared/blocks/table';
import { Crumb } from '@/shared/types/blocks/common';
import { type Table } from '@/shared/types/blocks/table';

import { ModelPriceCell, type ModelPriceLabels } from './model-price-cell';
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

  // meter 明细的行标签直接复用编辑表单那套 fields.* 文案，保证同名同义；
  // 摘要与分组标题用 models.list.pricing.* 下的精简文案。
  const meterLabels: Record<ModelAdminPriceMeterKey, string> = {
    inputMicroUsd: t('fields.inputMicroUsd'),
    cachedInputMicroUsd: t('fields.cachedInputMicroUsd'),
    cacheWriteMicroUsd: t('fields.cacheWriteMicroUsd'),
    cacheWrite5mMicroUsd: t('fields.cacheWrite5mMicroUsd'),
    cacheWrite1hMicroUsd: t('fields.cacheWrite1hMicroUsd'),
    outputMicroUsd: t('fields.outputMicroUsd'),
    imageInputMicroUsd: t('fields.imageInputMicroUsd'),
    cachedImageInputMicroUsd: t('fields.cachedImageInputMicroUsd'),
    imageOutputMicroUsd: t('fields.imageOutputMicroUsd'),
    webSearchMicroUsd: t('fields.webSearchMicroUsd'),
    inputLongMicroUsd: t('fields.inputLongMicroUsd'),
    cachedInputLongMicroUsd: t('fields.cachedInputLongMicroUsd'),
    cacheWriteLongMicroUsd: t('fields.cacheWriteLongMicroUsd'),
    outputLongMicroUsd: t('fields.outputLongMicroUsd'),
  };
  const priceLabels: ModelPriceLabels = {
    detail: t('models.list.pricing.detail'),
    empty: t('models.list.pricing.empty'),
    perCall: t('models.list.pricing.perCall'),
    inputShort: t('models.list.pricing.inputShort'),
    outputShort: t('models.list.pricing.outputShort'),
    sectionBase: t('models.list.pricing.sectionBase'),
    sectionLong: t('models.list.pricing.sectionLong'),
    threshold: t('models.list.pricing.threshold'),
    meterLabels,
  };

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
        name: 'price',
        title: t('fields.price'),
        callback: (item: ModelAdminRow) => (
          <ModelPriceCell price={item.price} labels={priceLabels} />
        ),
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
