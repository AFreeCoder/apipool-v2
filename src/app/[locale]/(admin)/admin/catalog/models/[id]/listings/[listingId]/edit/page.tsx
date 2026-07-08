import {
  bpsToDiscountFold,
  discountFoldToBps,
} from '@/features/api-catalog/lib/pricing';
import {
  getGroups,
  getListingById,
  getModelById,
  getStatuses,
  updateListing,
  UpdateListing,
} from '@/features/api-catalog/server/catalog-service';
import { revalidateCatalog } from '@/features/api-catalog/server/queries';
import { getTranslations, setRequestLocale } from 'next-intl/server';

import { PERMISSIONS, requirePermission } from '@/core/rbac';
import { Empty } from '@/shared/blocks/common';
import { Header, Main, MainHeader } from '@/shared/blocks/dashboard';
import { FormCard } from '@/shared/blocks/form';
import { Crumb } from '@/shared/types/blocks/common';
import { Form } from '@/shared/types/blocks/form';

export default async function CatalogModelListingEditPage({
  params,
}: {
  params: Promise<{ locale: string; id: string; listingId: string }>;
}) {
  const { locale, id, listingId } = await params;
  setRequestLocale(locale);

  await requirePermission({
    code: PERMISSIONS.CATALOG_WRITE,
    redirectUrl: '/admin/no-permission',
    locale,
  });

  const t = await getTranslations('admin.catalog');
  const missingRecordMessage = t('errors.missingRecord');
  const updateFailedMessage = t('errors.updateFailed');
  const invalidPriceMessage = t('errors.invalidPrice');
  const successMessage = t('listings.edit.success');
  const [model, listing] = await Promise.all([
    getModelById(id),
    getListingById(listingId),
  ]);

  if (!model || !listing || listing.modelId !== model.id) {
    return <Empty message={t('listings.edit.notFound')} />;
  }

  const [groups, statuses] = await Promise.all([getGroups(), getStatuses()]);
  const groupOptions = groups.map((group) => ({
    title: group.name,
    value: group.id,
  }));
  const statusOptions = statuses.map((status) => ({
    title: status.name,
    value: status.id,
  }));

  const crumbs: Crumb[] = [
    { title: t('crumbs.admin'), url: '/admin' },
    { title: t('crumbs.catalog'), url: '/admin/catalog/models' },
    { title: t('models.list.crumb'), url: '/admin/catalog/models' },
    {
      title: t('listings.list.crumb'),
      url: `/admin/catalog/models/${model.id}/listings`,
    },
    { title: t('listings.edit.crumb'), is_active: true },
  ];

  const form: Form = {
    fields: [
      {
        name: 'groupId',
        type: 'select',
        title: t('fields.group'),
        validation: { required: true },
        options: groupOptions,
        attributes: { disabled: true },
      },
      {
        name: 'statusId',
        type: 'select',
        title: t('fields.status'),
        validation: { required: true },
        options: statusOptions,
      },
      {
        name: 'discountFold',
        type: 'number',
        title: t('fields.discountRate'),
        validation: { min: 0.01, max: 10 },
      },
      {
        name: 'discountNote',
        type: 'text',
        title: t('fields.discountNote'),
      },
      {
        name: 'description',
        type: 'textarea',
        title: t('fields.description'),
      },
      {
        name: 'smokeTested',
        type: 'switch',
        title: t('fields.smokeTested'),
        tip: t('fields.smokeTestedTip'),
      },
    ],
    passby: {
      model,
      listing,
    },
    data: {
      ...listing,
      discountFold: bpsToDiscountFold(listing.discountRateBps) || '',
    },
    submit: {
      button: {
        title: t('listings.edit.buttons.submit'),
      },
      handler: async (data, passby) => {
        'use server';

        await requirePermission({ code: PERMISSIONS.CATALOG_WRITE });

        const { model, listing } = passby;

        if (!model || !listing) {
          throw new Error(missingRecordMessage);
        }

        let patch: UpdateListing;
        try {
          patch = {
            modelId: model.id,
            groupId: listing.groupId,
            statusId: (data.get('statusId') as string).trim(),
            discountRateBps: discountFoldToBps(data.get('discountFold')),
            discountNote:
              (data.get('discountNote') as string | null)?.trim() || null,
            description:
              (data.get('description') as string | null)?.trim() || null,
            smokeTested: data.get('smokeTested') === 'true',
            pricePolicy: listing.pricePolicy,
            featured: listing.featured,
            sortOrder: listing.sortOrder,
          };
        } catch {
          throw new Error(invalidPriceMessage);
        }

        const result = await updateListing(listing.id as string, patch);

        if (!result) {
          throw new Error(updateFailedMessage);
        }

        revalidateCatalog();

        return {
          status: 'success',
          message: successMessage,
          redirect_url: `/admin/catalog/models/${model.id}/listings`,
        };
      },
    },
  };

  return (
    <>
      <Header crumbs={crumbs} />
      <Main>
        <MainHeader title={t('listings.edit.title')} />
        <FormCard form={form} className="md:max-w-xl" />
      </Main>
    </>
  );
}
