import { getTranslations, setRequestLocale } from 'next-intl/server';

import { PERMISSIONS, requirePermission } from '@/core/rbac';
import { microUsdToDollars } from '@/features/api-catalog/lib/pricing';
import { getModelById } from '@/features/api-catalog/server/catalog-service';
import {
  getPricingProfileConfig,
  getPricingProfilesByModel,
} from '@/features/api-catalog/server/pricing-profile-service';
import { Empty } from '@/shared/blocks/common';
import { Header, Main, MainHeader } from '@/shared/blocks/dashboard';
import { TableCard } from '@/shared/blocks/table';
import { Crumb } from '@/shared/types/blocks/common';
import { type Table } from '@/shared/types/blocks/table';

type PricingProfileRow = {
  id: string;
  name: string;
  pricingBasis: string;
  quantityMeter: string;
  rateSummary: string;
  reviewedAt: Date | null;
  createdAt: Date;
};

export default async function CatalogModelPricingProfilesPage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const { locale, id } = await params;
  setRequestLocale(locale);

  await requirePermission({
    code: PERMISSIONS.CATALOG_READ,
    redirectUrl: '/admin/no-permission',
    locale,
  });

  const t = await getTranslations('admin.catalog');
  const model = await getModelById(id);
  if (!model) {
    return <Empty message={t('pricingProfiles.list.notFound')} />;
  }

  const profiles = await getPricingProfilesByModel(model.id);
  const configs = await Promise.all(
    profiles.map((profile) => getPricingProfileConfig(profile.id))
  );
  const rows: PricingProfileRow[] = configs.flatMap((config) => {
    if (!config) return [];
    const preview = config.rates
      .slice(0, 3)
      .map((rate) => {
        const key =
          config.profile.pricingBasis === 'token' ? rate.meterKey : rate.skuKey;
        return `${key} $${microUsdToDollars(rate.priceMicroUsd)}`;
      })
      .join(' · ');
    return [
      {
        id: config.profile.id,
        name: config.profile.name,
        pricingBasis: t(`pricingBasis.${config.profile.pricingBasis}` as any),
        quantityMeter: config.profile.quantityMeter
          ? t(`quantityMeter.${config.profile.quantityMeter}` as any)
          : '',
        rateSummary:
          config.rates.length > 3
            ? `${preview} · +${config.rates.length - 3}`
            : preview,
        reviewedAt: config.profile.reviewedAt,
        createdAt: config.profile.createdAt,
      },
    ];
  });

  const crumbs: Crumb[] = [
    { title: t('crumbs.admin'), url: '/admin' },
    { title: t('crumbs.catalog'), url: '/admin/catalog/models' },
    { title: t('models.list.crumb'), url: '/admin/catalog/models' },
    { title: t('pricingProfiles.list.crumb'), is_active: true },
  ];
  const table: Table = {
    columns: [
      { name: 'name', title: t('fields.name') },
      { name: 'pricingBasis', title: t('fields.billingScheme') },
      { name: 'quantityMeter', title: t('fields.quantityMeter') },
      { name: 'rateSummary', title: t('fields.rates') },
      { name: 'reviewedAt', title: t('fields.reviewedAt'), type: 'time' },
      { name: 'createdAt', title: t('fields.createdAt'), type: 'time' },
      {
        name: 'actions',
        title: t('fields.actions'),
        type: 'dropdown',
        callback: (item: PricingProfileRow) => [
          {
            name: 'edit',
            title: t('actions.edit'),
            icon: 'RiEditLine',
            url: `/admin/catalog/models/${model.id}/pricing-profiles/${item.id}/edit`,
          },
          {
            name: 'delete',
            title: t('actions.delete'),
            icon: 'Trash2',
            url: `/admin/catalog/models/${model.id}/pricing-profiles/${item.id}/delete`,
          },
        ],
      },
    ],
    data: rows,
  };

  return (
    <>
      <Header crumbs={crumbs} />
      <Main>
        <MainHeader
          title={t('pricingProfiles.list.title', { model: model.modelId })}
          description={t('pricingProfiles.list.description')}
        />
        <TableCard
          table={table}
          buttons={[
            {
              title: t('pricingProfiles.list.buttons.new'),
              icon: 'Plus',
              url: `/admin/catalog/models/${model.id}/pricing-profiles/new`,
            },
          ]}
        />
      </Main>
    </>
  );
}
