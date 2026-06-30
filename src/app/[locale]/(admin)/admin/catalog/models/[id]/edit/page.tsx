import {
  getCapabilities,
  getCategories,
  getGroups,
  getModelAdminConfig,
  getStatuses,
  getVendors,
  upsertModelAdminConfig,
} from '@/features/api-catalog/server/catalog-service';
import {
  bpsToDiscountFold,
  discountFoldToBps,
  microUsdToDollars,
  optionalDollarsToMicroUsd,
} from '@/features/api-catalog/lib/pricing';
import { revalidateCatalog } from '@/features/api-catalog/server/queries';
import { getTranslations, setRequestLocale } from 'next-intl/server';

import { PERMISSIONS, requirePermission } from '@/core/rbac';
import { Empty } from '@/shared/blocks/common';
import { Header, Main, MainHeader } from '@/shared/blocks/dashboard';
import { Crumb } from '@/shared/types/blocks/common';

import { ModelAdminForm } from '../../model-admin-form';

function requiredPrice(
  value: FormDataEntryValue | null,
  message: string
): number {
  const price = optionalDollarsToMicroUsd(value);
  if (price === null) throw new Error(message);
  return price;
}

export default async function CatalogModelEditPage({
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
  const updateFailedMessage = t('errors.updateFailed');
  const invalidPriceMessage = t('errors.invalidPrice');
  const successMessage = t('models.edit.success');
  const config = await getModelAdminConfig(id);

  if (!config) {
    return <Empty message={t('models.edit.notFound')} />;
  }

  const { model, listing } = config;
  const [vendors, groups, categories, capabilities, statuses] =
    await Promise.all([
      getVendors(),
      getGroups(),
      getCategories(),
      getCapabilities(),
      getStatuses(),
    ]);
  const status =
    statuses.find((item) => item.id === listing?.statusId) ??
    statuses.find((item) => item.slug === 'available') ??
    statuses[0];
  const categoryIds =
    config.categories.length > 0
      ? config.categories.map((category) => category.id)
      : categories
          .filter((category) => category.slug === model.category)
          .map((category) => category.id);

  const crumbs: Crumb[] = [
    { title: t('crumbs.admin'), url: '/admin' },
    { title: t('crumbs.catalog'), url: '/admin/catalog/models' },
    { title: t('models.list.crumb'), url: '/admin/catalog/models' },
    { title: t('models.edit.crumb'), is_active: true },
  ];

  const action = async (data: FormData) => {
    'use server';

    await requirePermission({ code: PERMISSIONS.CATALOG_WRITE });

    if (!model) {
      throw new Error(missingRecordMessage);
    }

    const result = await upsertModelAdminConfig({
      modelId: model.id,
      model: {
        modelId: (data.get('modelId') as string).trim(),
        displayName: (data.get('displayName') as string).trim(),
        vendorId: (data.get('vendorId') as string).trim(),
        categoryIds: JSON.parse(data.get('categoryIds') as string),
      },
      listing: {
        id: listing?.id,
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
        smokeTested: listing?.smokeTested ?? false,
        featured: listing?.featured ?? false,
        sortOrder: listing?.sortOrder ?? 0,
      },
      capabilityIds: JSON.parse(data.get('capabilityIds') as string),
    });

    if (!result) {
      throw new Error(updateFailedMessage);
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
        <MainHeader title={t('models.edit.title')} />
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
            submit: t('models.edit.buttons.submit'),
            saving: t('models.form.saving'),
            searchPlaceholder: t('models.form.searchPlaceholder'),
            searching: t('models.form.searching'),
            noCandidates: t('models.form.noCandidates'),
            fixedPrice: t('models.form.fixedPrice'),
            discountPreview: t('models.form.discountPreview'),
          }}
          initial={{
            modelId: model.modelId,
            displayName: model.displayName,
            vendorId: model.vendorId,
            groupId: listing?.groupId ?? groups[0]?.id ?? '',
            statusId: status?.id ?? '',
            categoryIds,
            capabilityIds: config.capabilities.map(
              (capability) => capability.id
            ),
            inputMicroUsd: microUsdToDollars(listing?.inputMicroUsd),
            outputMicroUsd: microUsdToDollars(listing?.outputMicroUsd),
            imageInputMicroUsd: microUsdToDollars(
              listing?.imageInputMicroUsd
            ),
            imageOutputMicroUsd: microUsdToDollars(
              listing?.imageOutputMicroUsd
            ),
            discountFold: bpsToDiscountFold(listing?.discountRateBps) || '10',
            discountNote: listing?.discountNote ?? '',
            description: listing?.description ?? '',
          }}
        />
      </Main>
    </>
  );
}
