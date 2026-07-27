import { getTranslations, setRequestLocale } from 'next-intl/server';

import { PERMISSIONS, requirePermission } from '@/core/rbac';
import { getModelById } from '@/features/api-catalog/server/catalog-service';
import {
  deletePricingProfile,
  getPricingProfileConfig,
  PricingProfileDeleteBlockedError,
} from '@/features/api-catalog/server/pricing-profile-service';
import { revalidateCatalog } from '@/features/api-catalog/server/queries';
import { Empty } from '@/shared/blocks/common';
import { Header, Main, MainHeader } from '@/shared/blocks/dashboard';
import { FormCard } from '@/shared/blocks/form';
import { Crumb } from '@/shared/types/blocks/common';
import { Form } from '@/shared/types/blocks/form';

export default async function CatalogModelPricingProfileDeletePage({
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
    return <Empty message={t('pricingProfiles.delete.notFound')} />;
  }
  const missingRecordMessage = t('errors.missingRecord');
  const form: Form = {
    fields: [],
    submit: {
      button: {
        title: t('pricingProfiles.delete.buttons.submit'),
        icon: 'Trash2',
        variant: 'destructive',
      },
      handler: async () => {
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
          await deletePricingProfile(freshModel.id, freshConfig.profile.id);
        } catch (error) {
          if (error instanceof PricingProfileDeleteBlockedError) {
            return { status: 'error' as const, message: error.message };
          }
          throw error;
        }
        revalidateCatalog();
        return {
          status: 'success',
          message: t('pricingProfiles.delete.success'),
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
    { title: t('pricingProfiles.delete.crumb'), is_active: true },
  ];
  return (
    <>
      <Header crumbs={crumbs} />
      <Main>
        <MainHeader
          title={t('pricingProfiles.delete.title')}
          description={t('pricingProfiles.delete.description', {
            profile: config.profile.name,
          })}
          actions={[
            {
              title: t('pricingProfiles.delete.buttons.cancel'),
              icon: 'ArrowLeft',
              variant: 'outline',
              url: `/admin/catalog/models/${model.id}/pricing-profiles`,
            },
          ]}
        />
        <FormCard form={form} className="md:max-w-xl" />
      </Main>
    </>
  );
}
