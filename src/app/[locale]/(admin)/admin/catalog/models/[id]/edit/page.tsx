import { getTranslations, setRequestLocale } from 'next-intl/server';

import { PERMISSIONS, requirePermission } from '@/core/rbac';
import { isUniqueConstraintError } from '@/features/api-catalog/lib/errors';
import {
  getCapabilities,
  getCategories,
  getListingsByModel,
  getModelAdminConfig,
  getVendors,
  upsertModelAdminConfig,
} from '@/features/api-catalog/server/catalog-service';
import { assessPublishReadiness } from '@/features/api-catalog/server/publish-readiness';
import { revalidateCatalog } from '@/features/api-catalog/server/queries';
import { Empty } from '@/shared/blocks/common';
import { Header, Main, MainHeader } from '@/shared/blocks/dashboard';
import { Crumb } from '@/shared/types/blocks/common';

import { ModelAdminForm } from '../../model-admin-form';

// 业务校验错误：server action 里捕获后转成 { status: 'error' } 返回。
// 直接 throw 的话生产环境会被 Next.js 脱敏成通用英文错误。
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
  const duplicateModelIdMessage = t('errors.duplicateModelId');
  // 0 能力的模型会被 mapListingRows 的 capabilities.length>0 过滤掉 → 从公开页
  // 与建 Key 候选里静默消失。保存能成功，但成功消息必须点破这点。
  const capabilitiesEmptyWarning = t('messages.capabilitiesEmptyWarning');
  const successMessage = t('models.edit.success');
  const config = await getModelAdminConfig(id);

  if (!config) {
    return <Empty message={t('models.edit.notFound')} />;
  }

  const { model } = config;
  const [vendors, categories, capabilities] = await Promise.all([
    getVendors(),
    getCategories(),
    getCapabilities(),
  ]);
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

    const capabilityIds = JSON.parse(data.get('capabilityIds') as string);
    let publishReasons: string[] = [];

    try {
      const result = await upsertModelAdminConfig({
        modelId: model.id,
        model: {
          modelId: (data.get('modelId') as string).trim(),
          displayName: (data.get('displayName') as string).trim(),
          vendorId: (data.get('vendorId') as string).trim(),
          categoryIds: JSON.parse(data.get('categoryIds') as string),
        },
        capabilityIds,
      });

      if (!result) {
        return { status: 'error' as const, message: updateFailedMessage };
      }
      const listings = await getListingsByModel(result.model.id);
      const readiness = await Promise.all(
        listings.map((listing) =>
          assessPublishReadiness(listing.groupId, result.model.modelId)
        )
      );
      publishReasons = [
        ...new Set(
          readiness.flatMap((item) => (item.ready ? [] : item.reasons))
        ),
      ];
    } catch (error) {
      // 撞 catalog_model.model_id 唯一索引（编辑可改 modelId）：给出可读提示
      // 而非原始 SQLite 错误（生产还会被 Next.js 脱敏成通用英文）。约束文案在 cause 里。
      if (isUniqueConstraintError(error)) {
        return { status: 'error' as const, message: duplicateModelIdMessage };
      }
      // 未知错误继续上抛：真 500 应进 error 边界，而不是伪装成业务错误。
      throw error;
    }

    revalidateCatalog();

    if (publishReasons.length > 0) {
      const actionT = await getTranslations({
        locale,
        namespace: 'admin.catalog',
      });
      return {
        status: 'error' as const,
        message: actionT('errors.pricingSavedButNotReady', {
          reasons: publishReasons.join('；'),
        }),
      };
    }

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
            categories: t('fields.categories'),
            capabilities: t('fields.capabilities'),
          }}
          messages={{
            submit: t('models.edit.buttons.submit'),
            saving: t('models.form.saving'),
            searchPlaceholder: t('models.form.searchPlaceholder'),
            searching: t('models.form.searching'),
            noCandidates: t('models.form.noCandidates'),
          }}
          initial={{
            modelId: model.modelId,
            displayName: model.displayName,
            vendorId: model.vendorId,
            categoryIds,
            capabilityIds: config.capabilities.map(
              (capability) => capability.id
            ),
          }}
        />
      </Main>
    </>
  );
}
