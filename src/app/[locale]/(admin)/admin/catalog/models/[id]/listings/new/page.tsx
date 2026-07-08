import {
  bpsToDiscountFold,
  discountFoldToBps,
} from '@/features/api-catalog/lib/pricing';
import {
  createListing,
  getGroups,
  getModelAdminConfig,
  getModelById,
  getStatuses,
  NewListing,
} from '@/features/api-catalog/server/catalog-service';
import { revalidateCatalog } from '@/features/api-catalog/server/queries';
import { getTranslations, setRequestLocale } from 'next-intl/server';

import { PERMISSIONS, requirePermission } from '@/core/rbac';
import { Empty } from '@/shared/blocks/common';
import { Header, Main, MainHeader } from '@/shared/blocks/dashboard';
import { FormCard } from '@/shared/blocks/form';
import { Crumb } from '@/shared/types/blocks/common';
import { Form } from '@/shared/types/blocks/form';

function requiredBasePrice(
  value: number | null | undefined,
  message: string
): number {
  if (value === null || value === undefined) {
    throw new Error(message);
  }
  return value;
}

export default async function CatalogModelListingNewPage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const { locale, id } = await params;
  setRequestLocale(locale);

  await requirePermission({
    code: PERMISSIONS.CATALOG_WRITE,
    redirectUrl: '/admin/no-permission',
    locale,
  });

  const t = await getTranslations('admin.catalog');
  const missingRecordMessage = t('errors.missingRecord');
  const missingBasePriceMessage = t('errors.missingBasePrice');
  const createFailedMessage = t('errors.createFailed');
  const invalidPriceMessage = t('errors.invalidPrice');
  const successMessage = t('listings.new.success');
  const [model, config] = await Promise.all([
    getModelById(id),
    getModelAdminConfig(id),
  ]);

  if (!model) {
    return <Empty message={t('listings.new.notFound')} />;
  }
  const defaultListing = config?.listing;
  const basePrice = config?.basePrice;

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
    { title: t('listings.new.crumb'), is_active: true },
  ];

  const form: Form = {
    fields: [
      {
        name: 'groupId',
        type: 'select',
        title: t('fields.group'),
        validation: { required: true },
        options: groupOptions,
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
    ],
    passby: {
      model,
      basePrice,
      defaultListing,
    },
    data: {
      groupId: groups[0]?.id ?? '',
      statusId: statuses[0]?.id ?? '',
      discountFold: bpsToDiscountFold(defaultListing?.discountRateBps) || '10',
      discountNote: '',
      description: '',
    },
    submit: {
      button: {
        title: t('listings.new.buttons.submit'),
      },
      handler: async (data, passby) => {
        'use server';

        await requirePermission({ code: PERMISSIONS.CATALOG_WRITE });

        const { model, basePrice, defaultListing } = passby;

        if (!model) {
          throw new Error(missingRecordMessage);
        }

        const inputMicroUsd = requiredBasePrice(
          basePrice?.baseInputMicroUsd ?? defaultListing?.inputMicroUsd,
          missingBasePriceMessage
        );
        const outputMicroUsd = requiredBasePrice(
          basePrice?.baseOutputMicroUsd ?? defaultListing?.outputMicroUsd,
          missingBasePriceMessage
        );

        let newListing: NewListing;
        try {
          newListing = {
            modelId: model.id,
            groupId: (data.get('groupId') as string).trim(),
            statusId: (data.get('statusId') as string).trim(),
            inputMicroUsd,
            outputMicroUsd,
            imageInputMicroUsd:
              basePrice?.baseImageInputMicroUsd ??
              defaultListing?.imageInputMicroUsd ??
              null,
            imageOutputMicroUsd:
              basePrice?.baseImageOutputMicroUsd ??
              defaultListing?.imageOutputMicroUsd ??
              null,
            listInputMicroUsd: defaultListing?.listInputMicroUsd ?? null,
            listOutputMicroUsd: defaultListing?.listOutputMicroUsd ?? null,
            discountRateBps: discountFoldToBps(data.get('discountFold')),
            discountNote:
              (data.get('discountNote') as string | null)?.trim() || null,
            description:
              (data.get('description') as string | null)?.trim() || null,
            smokeTested: false,
            featured: false,
            sortOrder: 0,
          } as NewListing;
        } catch {
          throw new Error(invalidPriceMessage);
        }

        const result = await createListing(newListing);

        if (!result) {
          throw new Error(createFailedMessage);
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
        <MainHeader title={t('listings.new.title')} />
        <FormCard form={form} className="md:max-w-xl" />
      </Main>
    </>
  );
}
