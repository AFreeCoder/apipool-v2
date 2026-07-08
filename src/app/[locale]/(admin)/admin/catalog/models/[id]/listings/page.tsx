import { formatDiscountRate } from '@/features/api-catalog/lib/pricing';
import {
  getGroups,
  getListingsByModel,
  getModelById,
  getStatuses,
  Listing,
} from '@/features/api-catalog/server/catalog-service';
import { getTranslations, setRequestLocale } from 'next-intl/server';

import { PERMISSIONS, requirePermission } from '@/core/rbac';
import { Empty } from '@/shared/blocks/common';
import { Header, Main, MainHeader } from '@/shared/blocks/dashboard';
import { TableCard } from '@/shared/blocks/table';
import { Crumb } from '@/shared/types/blocks/common';
import { type Table } from '@/shared/types/blocks/table';

type ListingRow = Listing & {
  groupName: string;
  statusName: string;
  discountRate: string;
};

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

  const [groups, statuses, listings] = await Promise.all([
    getGroups(),
    getStatuses(),
    getListingsByModel(model.id),
  ]);
  const groupNames = new Map(groups.map((group) => [group.id, group.name]));
  const statusNames = new Map(
    statuses.map((status) => [status.id, status.name])
  );
  const rows: ListingRow[] = listings.map((listing) => ({
    ...listing,
    groupName: groupNames.get(listing.groupId) ?? listing.groupId,
    statusName: statusNames.get(listing.statusId) ?? listing.statusId,
    discountRate: formatDiscountRate(listing.discountRateBps),
  }));

  const crumbs: Crumb[] = [
    { title: t('crumbs.admin'), url: '/admin' },
    { title: t('crumbs.catalog'), url: '/admin/catalog/models' },
    { title: t('models.list.crumb'), url: '/admin/catalog/models' },
    { title: t('listings.list.crumb'), is_active: true },
  ];

  const table: Table = {
    columns: [
      { name: 'groupName', title: t('fields.group') },
      { name: 'statusName', title: t('fields.status'), type: 'label' },
      { name: 'discountRate', title: t('fields.discountRate') },
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
