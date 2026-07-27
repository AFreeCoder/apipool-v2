import { getTranslations, setRequestLocale } from 'next-intl/server';

import { PERMISSIONS, requirePermission } from '@/core/rbac';
import { isUniqueConstraintError } from '@/features/api-catalog/lib/errors';
import { getModelById } from '@/features/api-catalog/server/catalog-service';
import {
  formatPricingRatesForForm,
  getAllowedPricingBases,
  getAllowedQuantityMeters,
  getPricingProfileConfig,
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

export default async function CatalogModelPricingProfileEditPage({
  params,
}: {
  params: Promise<{ locale: string; id: string; profileId: string }>;
}) {
  const { locale, id, profileId } = await params;
  setRequestLocale(locale);
  await requirePermission({
    code: PERMISSIONS.CATALOG_WRITE,
    redirectUrl: '/admin/no-permission',
    locale,
  });

  const t = await getTranslations('admin.catalog');
  const [model, config] = await Promise.all([
    getModelById(id),
    getPricingProfileConfig(profileId),
  ]);
  if (!model || !config || config.profile.modelId !== model.id) {
    return <Empty message={t('pricingProfiles.edit.notFound')} />;
  }

  const bases = getAllowedPricingBases(model.category);
  const quantityMeters = [
    ...new Set(
      bases.flatMap((basis) => getAllowedQuantityMeters(model.category, basis))
    ),
  ];
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
      name: config.profile.name,
      pricingBasis: config.profile.pricingBasis,
      quantityMeter: config.profile.quantityMeter ?? '',
      ratesJson: formatPricingRatesForForm(config.rates),
      skuRuleSource: config.profile.skuRuleSource ?? '',
      longContextThresholdTokens:
        config.profile.longContextThresholdTokens ?? '',
      reviewNote: config.profile.reviewNote ?? '',
    },
    submit: {
      button: { title: t('pricingProfiles.edit.buttons.submit') },
      handler: async (data) => {
        'use server';
        await requirePermission({ code: PERMISSIONS.CATALOG_WRITE });
        const [freshModel, freshConfig] = await Promise.all([
          getModelById(id),
          getPricingProfileConfig(profileId),
        ]);
        if (
          !freshModel ||
          !freshConfig ||
          freshConfig.profile.modelId !== freshModel.id
        ) {
          return { status: 'error' as const, message: missingRecordMessage };
        }
        try {
          const operator = await getUserInfo();
          await upsertPricingProfile({
            profileId: freshConfig.profile.id,
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
          message: t('pricingProfiles.edit.success'),
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
    { title: t('pricingProfiles.edit.crumb'), is_active: true },
  ];
  return (
    <>
      <Header crumbs={crumbs} />
      <Main>
        <MainHeader title={t('pricingProfiles.edit.title')} />
        <FormCard form={form} className="md:max-w-3xl" />
      </Main>
    </>
  );
}
