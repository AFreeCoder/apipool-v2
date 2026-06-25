import {
  dollarsToMicroUsd,
  optionalDollarsToMicroUsd,
} from '@/features/api-catalog/lib/pricing';
import {
  createListing,
  getGroups,
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

function parseSortOrder(value: FormDataEntryValue | null): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
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
  const createFailedMessage = t('errors.createFailed');
  const invalidPriceMessage = t('errors.invalidPrice');
  const successMessage = t('listings.new.success');
  const model = await getModelById(id);

  if (!model) {
    return <Empty message={t('listings.new.notFound')} />;
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
        name: 'inputMicroUsd',
        type: 'number',
        title: t('fields.inputMicroUsd'),
        validation: { required: true, min: 0 },
      },
      {
        name: 'outputMicroUsd',
        type: 'number',
        title: t('fields.outputMicroUsd'),
        validation: { required: true, min: 0 },
      },
      {
        name: 'listInputMicroUsd',
        type: 'number',
        title: t('fields.listInputMicroUsd'),
        validation: { min: 0 },
      },
      {
        name: 'listOutputMicroUsd',
        type: 'number',
        title: t('fields.listOutputMicroUsd'),
        validation: { min: 0 },
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
      },
      {
        name: 'sortOrder',
        type: 'number',
        title: t('fields.sortOrder'),
        validation: { required: true },
      },
    ],
    passby: {
      model,
    },
    data: {
      groupId: groups[0]?.id ?? '',
      statusId: statuses[0]?.id ?? '',
      inputMicroUsd: '0',
      outputMicroUsd: '0',
      listInputMicroUsd: '',
      listOutputMicroUsd: '',
      discountNote: '',
      description: '',
      smokeTested: false,
      sortOrder: 0,
    },
    submit: {
      button: {
        title: t('listings.new.buttons.submit'),
      },
      handler: async (data, passby) => {
        'use server';

        const { model } = passby;

        if (!model) {
          throw new Error(missingRecordMessage);
        }

        let newListing: NewListing;
        try {
          newListing = {
            modelId: model.id,
            groupId: (data.get('groupId') as string).trim(),
            statusId: (data.get('statusId') as string).trim(),
            inputMicroUsd: dollarsToMicroUsd(
              data.get('inputMicroUsd') as string
            ),
            outputMicroUsd: dollarsToMicroUsd(
              data.get('outputMicroUsd') as string
            ),
            listInputMicroUsd: optionalDollarsToMicroUsd(
              data.get('listInputMicroUsd')
            ),
            listOutputMicroUsd: optionalDollarsToMicroUsd(
              data.get('listOutputMicroUsd')
            ),
            discountNote:
              (data.get('discountNote') as string | null)?.trim() || null,
            description:
              (data.get('description') as string | null)?.trim() || null,
            smokeTested: data.get('smokeTested') === 'true',
            featured: false,
            sortOrder: parseSortOrder(data.get('sortOrder')),
          } as NewListing;
        } catch (error) {
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
