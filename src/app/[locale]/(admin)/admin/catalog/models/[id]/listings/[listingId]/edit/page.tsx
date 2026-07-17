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
        // Fractional folds like 9.5 are legal; the browser default step=1
        // would reject them before the form is even submitted.
        attributes: { step: 'any' },
        // 公开折扣当前由分组倍率决定，本字段仅作记录/预留（UI 只能产出
        // inherit_group 策略，resolveEffectiveCatalogPrice 不读 discountRateBps）。
        tip: t('fields.discountFoldTip'),
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
    data: {
      ...listing,
      discountFold: bpsToDiscountFold(listing.discountRateBps) || '',
    },
    submit: {
      button: {
        title: t('listings.edit.buttons.submit'),
      },
      handler: async (data) => {
        'use server';

        await requirePermission({ code: PERMISSIONS.CATALOG_WRITE });

        // 绝不信任客户端回传的记录快照：Form 是客户端组件，`passby` 会作为
        // server action 的实参往返（不是闭包，Next 不加密不签名），可被伪造
        // （例如把 pricePolicy 改成 listing_multiplier 让公开价直接按
        // discountRateBps 缩放），也可能是过期页面的陈旧值。写入目标与价格
        // 策略一律以服务端按路由参数重查为准。
        const [freshModel, freshListing] = await Promise.all([
          getModelById(id),
          getListingById(listingId),
        ]);

        if (
          !freshModel ||
          !freshListing ||
          freshListing.modelId !== freshModel.id
        ) {
          return { status: 'error' as const, message: missingRecordMessage };
        }

        let patch: UpdateListing;
        try {
          // 只写本表单拥有的字段。modelId/groupId/pricePolicy/featured/
          // sortOrder 不在 patch 里 —— Partial 更新，未提供即保持不变。
          patch = {
            statusId: (data.get('statusId') as string).trim(),
            discountRateBps: discountFoldToBps(data.get('discountFold')),
            discountNote:
              (data.get('discountNote') as string | null)?.trim() || null,
            description:
              (data.get('description') as string | null)?.trim() || null,
          };
        } catch {
          return { status: 'error' as const, message: invalidPriceMessage };
        }

        // 折扣在 listing_multiplier 策略下直接决定公开价：改了它就必须重新
        // 核验，否则展示价会立刻变而 New API 的实际计费没变（hide-until-confirmed）。
        if (
          freshListing.pricePolicy === 'listing_multiplier' &&
          patch.discountRateBps !== freshListing.discountRateBps
        ) {
          patch.priceDriftStatus = 'needs_live_check';
          patch.effectivePriceFormula = null;
          patch.effectivePriceSyncedAt = null;
        }

        const result = await updateListing(freshListing.id, patch);

        if (!result) {
          return { status: 'error' as const, message: updateFailedMessage };
        }

        revalidateCatalog();

        return {
          status: 'success',
          message: successMessage,
          redirect_url: `/admin/catalog/models/${freshModel.id}/listings`,
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
