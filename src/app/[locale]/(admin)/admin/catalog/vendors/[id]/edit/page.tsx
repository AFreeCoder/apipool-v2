import {
  getVendorById,
  updateVendor,
  UpdateVendor,
} from '@/features/api-catalog/server/catalog-service';
import { revalidateCatalog } from '@/features/api-catalog/server/queries';
import { getTranslations, setRequestLocale } from 'next-intl/server';

import { PERMISSIONS, requirePermission } from '@/core/rbac';
import { Empty } from '@/shared/blocks/common';
import { Header, Main, MainHeader } from '@/shared/blocks/dashboard';
import { FormCard } from '@/shared/blocks/form';
import { Crumb } from '@/shared/types/blocks/common';
import { Form } from '@/shared/types/blocks/form';

export default async function CatalogVendorEditPage({
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
  const successMessage = t('vendors.edit.success');
  const vendor = await getVendorById(id);

  if (!vendor) {
    return <Empty message={t('vendors.edit.notFound')} />;
  }

  const crumbs: Crumb[] = [
    { title: t('crumbs.admin'), url: '/admin' },
    { title: t('crumbs.catalog'), url: '/admin/catalog/vendors' },
    { title: t('vendors.list.crumb'), url: '/admin/catalog/vendors' },
    { title: t('vendors.edit.crumb'), is_active: true },
  ];

  const form: Form = {
    fields: [
      {
        name: 'slug',
        type: 'text',
        title: t('fields.slug'),
        validation: { required: true },
      },
      {
        name: 'name',
        type: 'text',
        title: t('fields.name'),
        validation: { required: true },
      },
      {
        name: 'sortOrder',
        type: 'number',
        title: t('fields.sortOrder'),
        validation: { required: true },
      },
      {
        name: 'status',
        type: 'select',
        title: t('fields.status'),
        validation: { required: true },
        options: [
          { title: t('statusOptions.active'), value: 'active' },
          { title: t('statusOptions.disabled'), value: 'disabled' },
        ],
      },
    ],
    passby: {
      vendor,
    },
    data: vendor,
    submit: {
      button: {
        title: t('vendors.edit.buttons.submit'),
      },
      handler: async (data, passby) => {
        'use server';

        const { vendor } = passby;

        if (!vendor) {
          throw new Error(missingRecordMessage);
        }

        const patch: UpdateVendor = {
          slug: (data.get('slug') as string).trim(),
          name: (data.get('name') as string).trim(),
          sortOrder: Number(data.get('sortOrder') ?? 0),
          status: (data.get('status') as string) || 'active',
        };

        const result = await updateVendor(vendor.id as string, patch);

        if (!result) {
          throw new Error(updateFailedMessage);
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
        <MainHeader title={t('vendors.edit.title')} />
        <FormCard form={form} className="md:max-w-xl" />
      </Main>
    </>
  );
}
