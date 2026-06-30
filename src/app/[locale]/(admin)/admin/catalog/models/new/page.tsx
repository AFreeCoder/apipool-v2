import {
  getCapabilities,
  getCategories,
  getGroups,
  getStatuses,
  getVendors,
  upsertModelAdminConfig,
} from '@/features/api-catalog/server/catalog-service';
import {
  discountFoldToBps,
  optionalDollarsToMicroUsd,
} from '@/features/api-catalog/lib/pricing';
import { revalidateCatalog } from '@/features/api-catalog/server/queries';
import { getTranslations, setRequestLocale } from 'next-intl/server';

import { PERMISSIONS, requirePermission } from '@/core/rbac';
import { Header, Main, MainHeader } from '@/shared/blocks/dashboard';
import { Crumb } from '@/shared/types/blocks/common';

import { ModelAdminForm } from '../model-admin-form';

function requiredPrice(
  value: FormDataEntryValue | null,
  message: string
): number {
  const price = optionalDollarsToMicroUsd(value);
  if (price === null) throw new Error(message);
  return price;
}

export default async function CatalogModelNewPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);

  await requirePermission({
    code: PERMISSIONS.CATALOG_WRITE,
    redirectUrl: '/admin/no-permission',
    locale,
  });

  const t = await getTranslations('admin.catalog');
  const createFailedMessage = t('errors.createFailed');
  const successMessage = t('models.new.success');
  const invalidPriceMessage = t('errors.invalidPrice');
  const [vendors, groups, categories, capabilities, statuses] =
    await Promise.all([
      getVendors(),
      getGroups(),
      getCategories(),
      getCapabilities(),
      getStatuses(),
    ]);
  const status = statuses.find((item) => item.slug === 'available') ?? statuses[0];

  const crumbs: Crumb[] = [
    { title: t('crumbs.admin'), url: '/admin' },
    { title: t('crumbs.catalog'), url: '/admin/catalog/models' },
    { title: t('models.list.crumb'), url: '/admin/catalog/models' },
    { title: t('models.new.crumb'), is_active: true },
  ];

  const action = async (data: FormData) => {
    'use server';

    await requirePermission({ code: PERMISSIONS.CATALOG_WRITE });

    const result = await upsertModelAdminConfig({
      model: {
        modelId: (data.get('modelId') as string).trim(),
        displayName: (data.get('displayName') as string).trim(),
        vendorId: (data.get('vendorId') as string).trim(),
        categoryIds: JSON.parse(data.get('categoryIds') as string),
      },
      listing: {
        groupId: (data.get('groupId') as string).trim(),
        statusId: (data.get('statusId') as string).trim(),
        inputMicroUsd: requiredPrice(
          data.get('inputMicroUsd'),
          invalidPriceMessage
        ),
        outputMicroUsd: requiredPrice(
          data.get('outputMicroUsd'),
          invalidPriceMessage
        ),
        imageInputMicroUsd: optionalDollarsToMicroUsd(
          data.get('imageInputMicroUsd')
        ),
        imageOutputMicroUsd: optionalDollarsToMicroUsd(
          data.get('imageOutputMicroUsd')
        ),
        discountRateBps: discountFoldToBps(data.get('discountFold')),
        discountNote: (data.get('discountNote') as string | null)?.trim() || null,
        description: (data.get('description') as string | null)?.trim() || null,
      },
      capabilityIds: JSON.parse(data.get('capabilityIds') as string),
    });

    if (!result) {
      throw new Error(createFailedMessage);
    }

    revalidateCatalog();

    return {
      status: 'success' as const,
      message: successMessage,
      redirect_url: '/admin/catalog/models',
    };
  };

  return (
    <>
      <Header crumbs={crumbs} />
      <Main>
        <MainHeader title={t('models.new.title')} />
        <ModelAdminForm
          action={action}
          vendors={vendors.map((vendor) => ({
            title: vendor.name,
            value: vendor.id,
          }))}
          groups={groups.map((group) => ({ title: group.name, value: group.id }))}
          categories={categories.map((category) => ({
            title: category.name,
            value: category.id,
          }))}
          capabilities={capabilities.map((capability) => ({
            title: capability.name,
            value: capability.id,
          }))}
          labels={{
            modelId: t('fields.modelId'),
            displayName: t('fields.displayName'),
            vendor: t('fields.vendor'),
            group: t('fields.group'),
            categories: t('fields.categories'),
            capabilities: t('fields.capabilities'),
            inputMicroUsd: t('fields.inputMicroUsd'),
            outputMicroUsd: t('fields.outputMicroUsd'),
            imageInputMicroUsd: t('fields.imageInputMicroUsd'),
            imageOutputMicroUsd: t('fields.imageOutputMicroUsd'),
            discountRate: t('fields.discountRate'),
            discountNote: t('fields.discountNote'),
            description: t('fields.description'),
          }}
          messages={{
            submit: t('models.new.buttons.submit'),
            saving: t('models.form.saving'),
            searchPlaceholder: t('models.form.searchPlaceholder'),
            searching: t('models.form.searching'),
            noCandidates: t('models.form.noCandidates'),
            fixedPrice: t('models.form.fixedPrice'),
            discountPreview: t('models.form.discountPreview'),
          }}
          initial={{
            modelId: '',
            displayName: '',
            vendorId: vendors[0]?.id ?? '',
            groupId: groups[0]?.id ?? '',
            statusId: status?.id ?? '',
            categoryIds: categories[0] ? [categories[0].id] : [],
            capabilityIds: [],
            inputMicroUsd: '',
            outputMicroUsd: '',
            imageInputMicroUsd: '',
            imageOutputMicroUsd: '',
            discountFold: '10',
            discountNote: '',
            description: '',
          }}
        />
      </Main>
    </>
  );
}
