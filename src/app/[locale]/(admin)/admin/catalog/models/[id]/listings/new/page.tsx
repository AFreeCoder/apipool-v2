import { getTranslations, setRequestLocale } from 'next-intl/server';

import { PERMISSIONS, requirePermission } from '@/core/rbac';
import { collectErrorMessages } from '@/features/api-catalog/lib/errors';
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
import {
  getPricingProfileConfig,
  getPricingProfilesByModel,
} from '@/features/api-catalog/server/pricing-profile-service';
import { assessPublishReadiness } from '@/features/api-catalog/server/publish-readiness';
import { revalidateCatalog } from '@/features/api-catalog/server/queries';
import { Empty } from '@/shared/blocks/common';
import { Header, Main, MainHeader } from '@/shared/blocks/dashboard';
import { FormCard } from '@/shared/blocks/form';
import { Crumb } from '@/shared/types/blocks/common';
import { Form } from '@/shared/types/blocks/form';

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
  const missingPricingProfileMessage = t('errors.missingPricingProfile');
  const createFailedMessage = t('errors.createFailed');
  const invalidPriceMessage = t('errors.invalidPrice');
  const duplicateListingMessage = t('errors.duplicateListing');
  const successMessage = t('listings.new.success');
  const [model, config, pricingProfiles] = await Promise.all([
    getModelById(id),
    getModelAdminConfig(id),
    getPricingProfilesByModel(id),
  ]);

  if (!model) {
    return <Empty message={t('listings.new.notFound')} />;
  }
  const defaultListing = config?.listing;

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
        name: 'newapiGroup',
        type: 'text',
        title: t('fields.newapiGroup'),
        tip: t('fields.newapiGroupTip'),
      },
      {
        name: 'pricingProfileId',
        type: 'select',
        title: t('fields.pricingProfile'),
        validation: { required: true },
        options: pricingProfiles.map((profile) => ({
          title: `${profile.name} · ${t(`pricingBasis.${profile.pricingBasis}` as any)}`,
          value: profile.id,
        })),
        tip: t('fields.pricingProfileTip'),
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
        // 上架折扣是公开售卖价的唯一折扣来源。
        tip: t('fields.discountFoldTip'),
      },
      {
        name: 'discountNote',
        type: 'text',
        title: t('fields.discountNote'),
      },
      {
        name: 'allowLongContext',
        type: 'switch',
        title: t('fields.allowLongContext'),
        tip: t('fields.allowLongContextTip'),
      },
      {
        name: 'description',
        type: 'textarea',
        title: t('fields.description'),
      },
    ],
    data: {
      groupId: groups[0]?.id ?? '',
      newapiGroup: '',
      pricingProfileId: pricingProfiles[0]?.id ?? '',
      statusId: statuses[0]?.id ?? '',
      discountFold: bpsToDiscountFold(defaultListing?.discountRateBps) || '',
      discountNote: '',
      allowLongContext: defaultListing?.allowLongContext ?? false,
      description: '',
    },
    submit: {
      button: {
        title: t('listings.new.buttons.submit'),
      },
      handler: async (data) => {
        'use server';

        await requirePermission({ code: PERMISSIONS.CATALOG_WRITE });

        // 绝不信任客户端回传的记录快照：表单实参可被伪造、也可能是陈旧页面的旧值。
        // 模型和定价档案一律按路由参数在服务端重查。
        const model = await getModelById(id);

        if (!model) {
          return { status: 'error' as const, message: missingRecordMessage };
        }

        const pricingProfileId = String(
          data.get('pricingProfileId') ?? ''
        ).trim();
        const pricingProfile = pricingProfileId
          ? await getPricingProfileConfig(pricingProfileId)
          : undefined;
        if (!pricingProfile || pricingProfile.profile.modelId !== model.id) {
          return {
            status: 'error' as const,
            message: missingPricingProfileMessage,
          };
        }

        // 空映射是显式的 fail-closed 状态：记录可以保存，但发布就绪检查
        // 会阻止它进入网关路由。这样管理员也能主动下线错误的上游映射。
        const newapiGroup = String(data.get('newapiGroup') ?? '').trim();

        let newListing: NewListing;
        try {
          newListing = {
            modelId: model.id,
            groupId: (data.get('groupId') as string).trim(),
            newapiGroup,
            pricingProfileId,
            statusId: (data.get('statusId') as string).trim(),
            // 遗留缓存列不再是售卖事实源；新发布只读取 pricingProfileId。
            inputMicroUsd: 0,
            outputMicroUsd: 0,
            imageInputMicroUsd: null,
            imageOutputMicroUsd: null,
            listInputMicroUsd: null,
            listOutputMicroUsd: null,
            discountRateBps: discountFoldToBps(data.get('discountFold')),
            discountNote:
              (data.get('discountNote') as string | null)?.trim() || null,
            priceDriftStatus: 'ok',
            effectivePriceFormula: JSON.stringify({
              source: 'pricing_profile_x_listing_discount',
              pricingProfileId,
            }),
            effectivePriceSyncedAt: new Date(),
            allowLongContext: data.get('allowLongContext') === 'true',
            description:
              (data.get('description') as string | null)?.trim() || null,
            featured: false,
            sortOrder: 0,
          } as NewListing;
        } catch {
          return { status: 'error' as const, message: invalidPriceMessage };
        }

        let result;
        try {
          result = await createListing(newListing);
        } catch (error) {
          // uniq_listing_model_group：同一模型在同一分组只能有一条售卖项。
          // 不捕获的话 admin 看到的是原始 SQLite 约束错误（生产还会被脱敏成通用错误）。
          // 约束文案落在 error.cause 里，必须走 collectErrorMessages 展开整条链。
          if (
            /uniq_listing_model_group|UNIQUE constraint/i.test(
              collectErrorMessages(error)
            )
          ) {
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

        const readiness = await assessPublishReadiness(
          result.groupId,
          model.modelId
        );
        if (!readiness.ready) {
          const actionT = await getTranslations({
            locale,
            namespace: 'admin.catalog',
          });
          return {
            status: 'error' as const,
            message: actionT('errors.pricingSavedButNotReady', {
              reasons: readiness.reasons.join('；'),
            }),
          };
        }

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
