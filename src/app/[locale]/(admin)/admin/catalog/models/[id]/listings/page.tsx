import { getTranslations, setRequestLocale } from 'next-intl/server';

import { PERMISSIONS, requirePermission } from '@/core/rbac';
import {
  formatDecimal,
  microUsdToDollars,
  scaleMicroUsdByBps,
} from '@/features/api-catalog/lib/pricing';
import {
  getGroups,
  getListingsByModel,
  getModelById,
  getStatuses,
  Listing,
} from '@/features/api-catalog/server/catalog-service';
import {
  getPricingProfileConfig,
  getPricingProfilesByModel,
} from '@/features/api-catalog/server/pricing-profile-service';
import {
  getLatestCostReferences,
  type CostReference,
} from '@/features/api-catalog/server/pricing-sync';
import { Empty } from '@/shared/blocks/common';
import { Header, Main, MainHeader } from '@/shared/blocks/dashboard';
import { TableCard } from '@/shared/blocks/table';
import { Crumb } from '@/shared/types/blocks/common';
import { type Table } from '@/shared/types/blocks/table';

type ListingRow = Listing & {
  groupSlug: string;
  groupName: string;
  statusName: string;
  pricingProfile: string;
  pricingBasis: string;
  discountRate: string;
  basePrice: string;
  effectivePrice: string;
  costReference: string;
  longContext: string;
};

function formatPricePair(input?: number | null, output?: number | null) {
  const values = [input, output]
    .filter((value): value is number => value !== null && value !== undefined)
    .map((value) => `$${microUsdToDollars(value)}`);
  return values.join(' / ');
}

function formatCostReference(
  reference: CostReference | undefined,
  newapiGroup: string
) {
  if (!reference || reference.newapiGroup !== newapiGroup) return '';
  if (reference.billingScheme === 'per_call') {
    return formatPricePair(reference.defaultTier);
  }
  return formatPricePair(reference.rates?.input, reference.rates?.output);
}

export default async function AdminCatalogModelListingsPage({
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
    return <Empty message={t('listings.list.notFound')} />;
  }

  const [groups, statuses, listings, pricingProfiles, costReferences] =
    await Promise.all([
      getGroups(),
      getStatuses(),
      getListingsByModel(model.id),
      getPricingProfilesByModel(model.id),
      getLatestCostReferences(),
    ]);
  const profileConfigs = await Promise.all(
    pricingProfiles.map((profile) => getPricingProfileConfig(profile.id))
  );
  const profileById = new Map(
    profileConfigs.flatMap((config) =>
      config ? [[config.profile.id, config] as const] : []
    )
  );
  const groupById = new Map(groups.map((group) => [group.id, group]));
  const statusNames = new Map(
    statuses.map((status) => [status.id, status.name])
  );
  // 折扣文案按 locale 渲染：只从结构化 discountRateBps 生成，
  // 中文「折」绝不漏进英文后台（对齐 /models 公开页 P0-6 方案）。
  const renderDiscount = (bps: number | null) =>
    bps === null
      ? ''
      : t('discount.value', {
          fold: formatDecimal(bps / 1000),
          percent: formatDecimal(bps / 100),
        });
  const rows: ListingRow[] = listings.map((listing) => {
    const group = groupById.get(listing.groupId);
    const discountBps = listing.discountRateBps ?? 10_000;
    const profile = listing.pricingProfileId
      ? profileById.get(listing.pricingProfileId)
      : undefined;
    const defaultRate = profile?.rates.find(
      (rate) => rate.skuKey === 'default'
    );
    const inputRate = profile?.rates.find((rate) => rate.meterKey === 'input');
    const outputRate = profile?.rates.find(
      (rate) => rate.meterKey === 'output'
    );
    const baseInput =
      profile?.profile.pricingBasis === 'token'
        ? inputRate?.priceMicroUsd
        : defaultRate?.priceMicroUsd;
    const baseOutput =
      profile?.profile.pricingBasis === 'token'
        ? outputRate?.priceMicroUsd
        : null;
    return {
      ...listing,
      groupSlug: group?.slug ?? listing.groupId,
      groupName: group?.name ?? listing.groupId,
      statusName: statusNames.get(listing.statusId) ?? listing.statusId,
      pricingProfile: profile?.profile.name ?? '',
      pricingBasis: profile
        ? t(`pricingBasis.${profile.profile.pricingBasis}` as any)
        : '',
      discountRate: renderDiscount(listing.discountRateBps),
      basePrice: formatPricePair(baseInput, baseOutput),
      effectivePrice: formatPricePair(
        scaleMicroUsdByBps(baseInput, discountBps),
        scaleMicroUsdByBps(baseOutput, discountBps)
      ),
      costReference: formatCostReference(
        costReferences[listing.id],
        listing.newapiGroup
      ),
      longContext: listing.allowLongContext
        ? t('boolean.yes')
        : t('boolean.no'),
    };
  });

  const crumbs: Crumb[] = [
    { title: t('crumbs.admin'), url: '/admin' },
    { title: t('crumbs.catalog'), url: '/admin/catalog/models' },
    { title: t('models.list.crumb'), url: '/admin/catalog/models' },
    { title: t('listings.list.crumb'), is_active: true },
  ];

  const table: Table = {
    columns: [
      { name: 'groupSlug', title: t('fields.groupSlug'), type: 'copy' },
      { name: 'groupName', title: t('fields.name') },
      {
        name: 'newapiGroup',
        title: t('fields.newapiGroup'),
        type: 'copy',
      },
      { name: 'statusName', title: t('fields.status'), type: 'label' },
      { name: 'pricingProfile', title: t('fields.pricingProfile') },
      { name: 'pricingBasis', title: t('fields.billingScheme') },
      { name: 'basePrice', title: t('fields.basePrice') },
      { name: 'discountRate', title: t('fields.discountRate') },
      { name: 'effectivePrice', title: t('fields.effectivePrice') },
      { name: 'costReference', title: t('fields.costReference') },
      { name: 'longContext', title: t('fields.allowLongContext') },
      { name: 'discountNote', title: t('fields.discountNote') },
      { name: 'description', title: t('fields.description') },
      { name: 'createdAt', title: t('fields.createdAt'), type: 'time' },
      {
        name: 'actions',
        title: t('fields.actions'),
        type: 'dropdown',
        callback: (item: ListingRow) => [
          {
            name: 'edit',
            title: t('actions.edit'),
            icon: 'RiEditLine',
            url: `/admin/catalog/models/${model.id}/listings/${item.id}/edit`,
          },
          {
            name: 'delete',
            title: t('actions.delete'),
            icon: 'Trash2',
            url: `/admin/catalog/models/${model.id}/listings/${item.id}/delete`,
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
        <MainHeader title={t('listings.list.title')} />
        <TableCard
          table={table}
          buttons={[
            {
              title: t('listings.list.buttons.new'),
              icon: 'Plus',
              url: `/admin/catalog/models/${model.id}/listings/new`,
            },
          ]}
        />
      </Main>
    </>
  );
}
