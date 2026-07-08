import {
  CatalogDeleteBlockedError,
  deleteVendor,
  getVendorById,
} from '@/features/api-catalog/server/catalog-service';
import { revalidateCatalog } from '@/features/api-catalog/server/queries';
import { getTranslations, setRequestLocale } from 'next-intl/server';

import { PERMISSIONS, requirePermission } from '@/core/rbac';
import { Empty } from '@/shared/blocks/common';
import { Header, Main, MainHeader } from '@/shared/blocks/dashboard';
import { FormCard } from '@/shared/blocks/form';
import { Crumb } from '@/shared/types/blocks/common';
import { Form } from '@/shared/types/blocks/form';

export default async function CatalogVendorDeletePage({
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
  const blockedMessage = t('vendors.delete.blocked');
  const successMessage = t('vendors.delete.success');
  const vendor = await getVendorById(id);

  if (!vendor) {
    return <Empty message={t('vendors.delete.notFound')} />;
  }

  const crumbs: Crumb[] = [
    { title: t('crumbs.admin'), url: '/admin' },
    { title: t('crumbs.catalog'), url: '/admin/catalog/vendors' },
    { title: t('vendors.list.crumb'), url: '/admin/catalog/vendors' },
    { title: t('vendors.delete.crumb'), is_active: true },
  ];

  const form: Form = {
    fields: [],
    passby: {
      vendor,
    },
    submit: {
      button: {
        title: t('vendors.delete.buttons.submit'),
        icon: 'Trash2',
        variant: 'destructive',
      },
      handler: async (_data, passby) => {
        'use server';

        await requirePermission({ code: PERMISSIONS.CATALOG_WRITE });

        const target = passby?.vendor;
        if (!target?.id) {
          throw new Error(missingRecordMessage);
        }

        try {
          await deleteVendor(target.id);
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
          redirect_url: '/admin/catalog/vendors',
        };
      },
    },
  };

  return (
    <>
      <Header crumbs={crumbs} />
      <Main>
        <MainHeader
          title={t('vendors.delete.title')}
          description={t('vendors.delete.description', {
            name: vendor.name,
            slug: vendor.slug,
          })}
          actions={[
            {
              title: t('vendors.delete.buttons.cancel'),
              icon: 'ArrowLeft',
              variant: 'outline',
              url: '/admin/catalog/vendors',
            },
          ]}
        />
        <FormCard form={form} className="md:max-w-xl" />
      </Main>
    </>
  );
}
