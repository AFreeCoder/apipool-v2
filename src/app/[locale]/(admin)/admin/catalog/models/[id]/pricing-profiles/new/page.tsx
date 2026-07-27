import { getTranslations, setRequestLocale } from 'next-intl/server';

import { PERMISSIONS, requirePermission } from '@/core/rbac';
import { isUniqueConstraintError } from '@/features/api-catalog/lib/errors';
import { getModelById } from '@/features/api-catalog/server/catalog-service';
import {
  getAllowedPricingBases,
  getAllowedQuantityMeters,
  parsePricingProfileFormData,
  PricingProfileValidationError,
  upsertPricingProfile,
} from '@/features/api-catalog/server/pricing-profile-service';
import { revalidateCatalog } from '@/features/api-catalog/server/queries';
import { Empty } from '@/shared/blocks/common';
import { Header, Main, MainHeader } from '@/shared/blocks/dashboard';
import { FormCard } from '@/shared/blocks/form';
import { getUserInfo } from '@/shared/models/user';
import { Crumb } from '@/shared/types/blocks/common';
import { Form } from '@/shared/types/blocks/form';

const IMAGE_SKU_RULE = `when quality is missing => "default"
when quality == "auto" => "default"
when size is missing => "default"
when size == "auto" => "default"
else => "quality=\${quality};size=\${size}"`;

function defaultRateJson(category: string, basis: string) {
  if (basis === 'unit' && category === 'image') {
    return JSON.stringify(
      {
        default: '',
        'quality=low;size=1024x1024': '',
      },
      null,
      2
    );
  }
  if (category === 'embedding') {
    return JSON.stringify({ input: '' }, null, 2);
  }
  if (category === 'image') {
    return JSON.stringify(
      { input: '', image_input: '', image_output: '' },
      null,
      2
    );
  }
  return JSON.stringify({ input: '', output: '' }, null, 2);
}

export default async function CatalogModelPricingProfileNewPage({
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
  const model = await getModelById(id);
  if (!model) return <Empty message={t('pricingProfiles.new.notFound')} />;

  const bases = getAllowedPricingBases(model.category);
  const defaultBasis =
    model.category === 'image' && bases.includes('unit') ? 'unit' : bases[0];
  const quantityMeters = [
    ...new Set(
      bases.flatMap((basis) => getAllowedQuantityMeters(model.category, basis))
    ),
  ];
  const defaultQuantityMeter =
    getAllowedQuantityMeters(model.category, defaultBasis)[0] ?? '';
  const missingRecordMessage = t('errors.missingRecord');
  const duplicateMessage = t('errors.duplicatePricingProfile');

  const form: Form = {
    fields: [
      {
        name: 'name',
        type: 'text',
        title: t('fields.name'),
        validation: { required: true },
      },
      {
        name: 'pricingBasis',
        type: 'select',
        title: t('fields.billingScheme'),
        validation: { required: true },
        options: bases.map((basis) => ({
          title: t(`pricingBasis.${basis}` as any),
          value: basis,
        })),
        tip: t('fields.pricingBasisTip', { category: model.category }),
      },
      {
        name: 'quantityMeter',
        type: 'select',
        title: t('fields.quantityMeter'),
        options: [
          { title: t('quantityMeter.none'), value: '' },
          ...quantityMeters.map((meter) => ({
            title: t(`quantityMeter.${meter}` as any),
            value: meter,
          })),
        ],
        tip: t('fields.quantityMeterTip'),
      },
      {
        name: 'ratesJson',
        type: 'textarea',
        title: t('fields.rates'),
        validation: { required: true },
        attributes: { rows: 12, className: 'font-mono text-xs' },
        tip: t('fields.ratesTip'),
      },
      {
        name: 'skuRuleSource',
        type: 'textarea',
        title: t('fields.skuRule'),
        attributes: { rows: 10, className: 'font-mono text-xs' },
        tip: t('fields.skuRuleTip'),
      },
      {
        name: 'longContextThresholdTokens',
        type: 'number',
        title: t('fields.longContextThresholdTokens'),
        validation: { min: 1 },
        tip: t('fields.profileLongContextTip'),
      },
      {
        name: 'reviewNote',
        type: 'textarea',
        title: t('fields.reviewNote'),
      },
    ],
    data: {
      name: '',
      pricingBasis: defaultBasis,
      quantityMeter: defaultQuantityMeter,
      ratesJson: defaultRateJson(model.category, defaultBasis),
      skuRuleSource:
        defaultBasis === 'unit' && model.category === 'image'
          ? IMAGE_SKU_RULE
          : '',
      longContextThresholdTokens: '',
      reviewNote: '',
    },
    submit: {
      button: { title: t('pricingProfiles.new.buttons.submit') },
      handler: async (data) => {
        'use server';
        await requirePermission({ code: PERMISSIONS.CATALOG_WRITE });
        const freshModel = await getModelById(id);
        if (!freshModel) {
          return { status: 'error' as const, message: missingRecordMessage };
        }
        try {
          const operator = await getUserInfo();
          await upsertPricingProfile({
            modelId: freshModel.id,
            operatorUserId: operator?.id,
            form: parsePricingProfileFormData(data),
          });
        } catch (error) {
          if (error instanceof PricingProfileValidationError) {
            return { status: 'error' as const, message: error.message };
          }
          if (isUniqueConstraintError(error)) {
            return { status: 'error' as const, message: duplicateMessage };
          }
          throw error;
        }
        revalidateCatalog();
        return {
          status: 'success',
          message: t('pricingProfiles.new.success'),
          redirect_url: `/admin/catalog/models/${freshModel.id}/pricing-profiles`,
        };
      },
    },
  };

  const crumbs: Crumb[] = [
    { title: t('crumbs.admin'), url: '/admin' },
    { title: t('crumbs.catalog'), url: '/admin/catalog/models' },
    {
      title: t('pricingProfiles.list.crumb'),
      url: `/admin/catalog/models/${model.id}/pricing-profiles`,
    },
    { title: t('pricingProfiles.new.crumb'), is_active: true },
  ];
  return (
    <>
      <Header crumbs={crumbs} />
      <Main>
        <MainHeader title={t('pricingProfiles.new.title')} />
        <FormCard form={form} className="md:max-w-3xl" />
      </Main>
    </>
  );
}
