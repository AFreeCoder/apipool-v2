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

// 业务校验错误：server action 里捕获后转成 { status: 'error' } 返回。
// 直接 throw 的话生产环境会被 Next.js 脱敏成通用英文错误。
class FormValidationError extends Error {}

function requiredBasePrice(
  value: number | null | undefined,
  message: string
): number {
  if (value === null || value === undefined) {
    throw new FormValidationError(message);
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
  const duplicateListingMessage = t('errors.duplicateListing');
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
        // Fractional folds like 9.5 are legal; the browser default step=1
        // would reject them before the form is even submitted.
        attributes: { step: 'any' },
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
      basePrice,
      defaultListing,
    },
    data: {
      groupId: groups[0]?.id ?? '',
      statusId: statuses[0]?.id ?? '',
      discountFold: bpsToDiscountFold(defaultListing?.discountRateBps) || '',
      discountNote: '',
      description: '',
      smokeTested: 'false',
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
          return { status: 'error' as const, message: missingRecordMessage };
        }

        let inputMicroUsd: number;
        let outputMicroUsd: number;
        try {
          inputMicroUsd = requiredBasePrice(
            basePrice?.baseInputMicroUsd ?? defaultListing?.inputMicroUsd,
            missingBasePriceMessage
          );
          outputMicroUsd = requiredBasePrice(
            basePrice?.baseOutputMicroUsd ?? defaultListing?.outputMicroUsd,
            missingBasePriceMessage
          );
        } catch (error) {
          if (error instanceof FormValidationError) {
            return { status: 'error' as const, message: error.message };
          }
          // 未知错误继续上抛：真 500 应进 error 边界，而不是伪装成业务错误。
          throw error;
        }

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
            smokeTested: data.get('smokeTested') === 'true',
            featured: false,
            sortOrder: 0,
          } as NewListing;
        } catch {
          return { status: 'error' as const, message: invalidPriceMessage };
        }

        let result;
        try {
          result = await createListing(newListing);
        } catch (error: any) {
          // uniq_listing_model_group：同一模型在同一分组只能有一条售卖项。
          // 不捕获的话 admin 看到的是原始 SQLite 约束错误（生产还会被脱敏成通用错误）。
          if (/uniq_listing_model_group|UNIQUE constraint/i.test(String(error?.message))) {
            return {
              status: 'error' as const,
              message: duplicateListingMessage,
            };
          }
          throw error;
        }

        if (!result) {
          return { status: 'error' as const, message: createFailedMessage };
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
