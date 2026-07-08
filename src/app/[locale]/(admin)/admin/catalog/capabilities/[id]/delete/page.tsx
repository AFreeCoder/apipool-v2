import {
  CatalogDeleteBlockedError,
  deleteCapability,
  getCapabilityById,
} from '@/features/api-catalog/server/catalog-service';
import { revalidateCatalog } from '@/features/api-catalog/server/queries';
import { getTranslations, setRequestLocale } from 'next-intl/server';

import { PERMISSIONS, requirePermission } from '@/core/rbac';
import { Empty } from '@/shared/blocks/common';
import { Header, Main, MainHeader } from '@/shared/blocks/dashboard';
import { FormCard } from '@/shared/blocks/form';
import { Crumb } from '@/shared/types/blocks/common';
import { Form } from '@/shared/types/blocks/form';

export default async function CatalogCapabilityDeletePage({
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
  const deleteFailedMessage = t('errors.deleteFailed');
  const blockedMessage = t('capabilities.delete.blocked');
  const successMessage = t('capabilities.delete.success');
  const capability = await getCapabilityById(id);

  if (!capability) {
    return <Empty message={t('capabilities.delete.notFound')} />;
  }

  const crumbs: Crumb[] = [
    { title: t('crumbs.admin'), url: '/admin' },
    { title: t('crumbs.catalog'), url: '/admin/catalog/capabilities' },
    {
      title: t('capabilities.list.crumb'),
      url: '/admin/catalog/capabilities',
    },
    { title: t('capabilities.delete.crumb'), is_active: true },
  ];

  const form: Form = {
    fields: [],
    passby: {
      capability,
    },
    submit: {
      button: {
        title: t('capabilities.delete.buttons.submit'),
        icon: 'Trash2',
        variant: 'destructive',
      },
      handler: async (_data, passby) => {
        'use server';

        await requirePermission({ code: PERMISSIONS.CATALOG_WRITE });

        const target = passby?.capability;
        if (!target?.id) {
          throw new Error(missingRecordMessage);
        }

        try {
          await deleteCapability(target.id);
        } catch (error) {
          if (error instanceof CatalogDeleteBlockedError) {
            throw new Error(blockedMessage);
          }
          throw new Error(deleteFailedMessage);
        }

        revalidateCatalog();

        return {
          status: 'success',
          message: successMessage,
          redirect_url: '/admin/catalog/capabilities',
        };
      },
    },
  };

  return (
    <>
      <Header crumbs={crumbs} />
      <Main>
        <MainHeader
          title={t('capabilities.delete.title')}
          description={t('capabilities.delete.description', {
            name: capability.name,
            slug: capability.slug,
          })}
          actions={[
            {
              title: t('capabilities.delete.buttons.cancel'),
              icon: 'ArrowLeft',
              variant: 'outline',
              url: '/admin/catalog/capabilities',
            },
          ]}
        />
        <FormCard form={form} className="md:max-w-xl" />
      </Main>
    </>
  );
}
