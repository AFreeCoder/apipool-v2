import {
  deleteListing,
  getGroups,
  getListingById,
  getModelById,
} from '@/features/api-catalog/server/catalog-service';
import { revalidateCatalog } from '@/features/api-catalog/server/queries';
import { getTranslations, setRequestLocale } from 'next-intl/server';

import { PERMISSIONS, requirePermission } from '@/core/rbac';
import { Empty } from '@/shared/blocks/common';
import { Header, Main, MainHeader } from '@/shared/blocks/dashboard';
import { FormCard } from '@/shared/blocks/form';
import { Crumb } from '@/shared/types/blocks/common';
import { Form } from '@/shared/types/blocks/form';

export default async function CatalogModelListingDeletePage({
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
  const deleteFailedMessage = t('errors.deleteFailed');
  const successMessage = t('listings.delete.success');
  const [model, listing, groups] = await Promise.all([
    getModelById(id),
    getListingById(listingId),
    getGroups(),
  ]);

  if (!model || !listing || listing.modelId !== model.id) {
    return <Empty message={t('listings.delete.notFound')} />;
  }

  const group = groups.find((candidate) => candidate.id === listing.groupId);
  const groupLabel = group
    ? `${group.slug} / ${group.name}`
    : listing.groupId;

  const crumbs: Crumb[] = [
    { title: t('crumbs.admin'), url: '/admin' },
    { title: t('crumbs.catalog'), url: '/admin/catalog/models' },
    { title: t('models.list.crumb'), url: '/admin/catalog/models' },
    {
      title: t('listings.list.crumb'),
      url: `/admin/catalog/models/${model.id}/listings`,
    },
    { title: t('listings.delete.crumb'), is_active: true },
  ];

  const form: Form = {
    fields: [],
    passby: {
      model,
      listing,
    },
    submit: {
      button: {
        title: t('listings.delete.buttons.submit'),
        icon: 'Trash2',
        variant: 'destructive',
      },
      handler: async (_data, passby) => {
        'use server';

        await requirePermission({ code: PERMISSIONS.CATALOG_WRITE });

        const targetModel = passby?.model;
        const targetListing = passby?.listing;
        if (!targetModel?.id || !targetListing?.id) {
          throw new Error(missingRecordMessage);
        }

        try {
          await deleteListing(targetListing.id);
        } catch {
          throw new Error(deleteFailedMessage);
        }

        revalidateCatalog();

        return {
          status: 'success',
          message: successMessage,
          redirect_url: `/admin/catalog/models/${targetModel.id}/listings`,
        };
      },
    },
  };

  return (
    <>
      <Header crumbs={crumbs} />
      <Main>
        <MainHeader
          title={t('listings.delete.title')}
          description={t('listings.delete.description', {
            model: model.modelId,
            group: groupLabel,
          })}
          actions={[
            {
              title: t('listings.delete.buttons.cancel'),
              icon: 'ArrowLeft',
              variant: 'outline',
              url: `/admin/catalog/models/${model.id}/listings`,
            },
          ]}
        />
        <FormCard form={form} className="md:max-w-xl" />
      </Main>
    </>
  );
}
