import { isUniqueConstraintError } from '@/features/api-catalog/lib/errors';
import {
  bpsToDiscountFold,
  discountFoldToBps,
  microUsdToDollars,
  optionalDollarsToMicroUsd,
} from '@/features/api-catalog/lib/pricing';
import {
  getCapabilities,
  getCategories,
  getGroups,
  getModelAdminConfig,
  getStatuses,
  getVendors,
  upsertModelAdminConfig,
} from '@/features/api-catalog/server/catalog-service';
import { revalidateCatalog } from '@/features/api-catalog/server/queries';
import { getTranslations, setRequestLocale } from 'next-intl/server';

import { PERMISSIONS, requirePermission } from '@/core/rbac';
import { Empty } from '@/shared/blocks/common';
import { Header, Main, MainHeader } from '@/shared/blocks/dashboard';
import { getUserInfo } from '@/shared/models/user';
import { Crumb } from '@/shared/types/blocks/common';

import { ModelAdminForm } from '../../model-admin-form';

// 业务校验错误：server action 里捕获后转成 { status: 'error' } 返回。
// 直接 throw 的话生产环境会被 Next.js 脱敏成通用英文错误。
class FormValidationError extends Error {}

function requiredPrice(
  value: FormDataEntryValue | null,
  message: string
): number {
  const price = optionalDollarsToMicroUsd(value);
  if (price === null) throw new FormValidationError(message);
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
  const duplicateModelIdMessage = t('errors.duplicateModelId');
  // 0 能力的模型会被 mapListingRows 的 capabilities.length>0 过滤掉 → 从公开页
  // 与建 Key 候选里静默消失。保存能成功，但成功消息必须点破这点。
  const capabilitiesEmptyWarning = t('messages.capabilitiesEmptyWarning');
  // 保存模型会把该模型所有 listing 的 priceDriftStatus 打回 needs_live_check，
  // 公开价随即隐藏为「—」。不提示的话运营改个名字就以为没事发生。
  const successMessage = `${t('models.edit.success')} ${t('messages.priceHiddenAfterSave')}`;
  const config = await getModelAdminConfig(id);

  if (!config) {
    return <Empty message={t('models.edit.notFound')} />;
  }

  const { model, listing, basePrice } = config;
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
      return { status: 'error' as const, message: missingRecordMessage };
    }

    const operator = await getUserInfo();

    const capabilityIds = JSON.parse(data.get('capabilityIds') as string);

    try {
      const result = await upsertModelAdminConfig({
        modelId: model.id,
        operatorUserId: operator?.id,
        model: {
          modelId: (data.get('modelId') as string).trim(),
          displayName: (data.get('displayName') as string).trim(),
          vendorId: (data.get('vendorId') as string).trim(),
          categoryIds: JSON.parse(data.get('categoryIds') as string),
        },
        basePrice: {
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
        },
        listing: {
          id: listing?.id,
          groupId: (data.get('groupId') as string).trim(),
          statusId: (data.get('statusId') as string).trim(),
          discountRateBps: discountFoldToBps(data.get('discountFold')),
          discountNote:
            (data.get('discountNote') as string | null)?.trim() || null,
          description:
            (data.get('description') as string | null)?.trim() || null,
          smokeTested: listing?.smokeTested ?? false,
          featured: listing?.featured ?? false,
          sortOrder: listing?.sortOrder ?? 0,
        },
        capabilityIds,
      });

      if (!result) {
        return { status: 'error' as const, message: updateFailedMessage };
      }
    } catch (error) {
      if (error instanceof FormValidationError) {
        return { status: 'error' as const, message: error.message };
      }
      // 撞 catalog_model.model_id 唯一索引（编辑可改 modelId）：给出可读提示
      // 而非原始 SQLite 错误（生产还会被 Next.js 脱敏成通用英文）。约束文案在 cause 里。
      if (isUniqueConstraintError(error)) {
        return { status: 'error' as const, message: duplicateModelIdMessage };
      }
      // 未知错误继续上抛：真 500 应进 error 边界，而不是伪装成业务错误。
      throw error;
    }

    revalidateCatalog();

    const capabilityWarning =
      capabilityIds.length === 0 ? ` ${capabilitiesEmptyWarning}` : '';

    return {
      status: 'success' as const,
      message: `${successMessage}${capabilityWarning}`,
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
          groups={groups.map((group) => ({
            title: group.name,
            value: group.id,
          }))}
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
          }}
          messages={{
            submit: t('models.edit.buttons.submit'),
            saving: t('models.form.saving'),
            searchPlaceholder: t('models.form.searchPlaceholder'),
            searching: t('models.form.searching'),
            noCandidates: t('models.form.noCandidates'),
            fixedPrice: t('models.form.fixedPrice'),
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
            inputMicroUsd: microUsdToDollars(
              basePrice?.baseInputMicroUsd ?? listing?.inputMicroUsd
            ),
            outputMicroUsd: microUsdToDollars(
              basePrice?.baseOutputMicroUsd ?? listing?.outputMicroUsd
            ),
            imageInputMicroUsd: microUsdToDollars(
              basePrice?.baseImageInputMicroUsd ?? listing?.imageInputMicroUsd
            ),
            imageOutputMicroUsd: microUsdToDollars(
              basePrice?.baseImageOutputMicroUsd ?? listing?.imageOutputMicroUsd
            ),
            discountFold: bpsToDiscountFold(listing?.discountRateBps) || '',
            discountNote: listing?.discountNote ?? '',
            description: listing?.description ?? '',
          }}
        />
      </Main>
    </>
  );
}
