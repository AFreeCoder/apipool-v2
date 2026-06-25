import {
  createModel,
  getVendors,
  NewModel,
} from '@/features/api-catalog/server/catalog-service';
import { revalidateCatalog } from '@/features/api-catalog/server/queries';
import { getTranslations, setRequestLocale } from 'next-intl/server';

import { PERMISSIONS, requirePermission } from '@/core/rbac';
import { Header, Main, MainHeader } from '@/shared/blocks/dashboard';
import { FormCard } from '@/shared/blocks/form';
import { Crumb } from '@/shared/types/blocks/common';
import { Form } from '@/shared/types/blocks/form';

function optionalNumber(value: FormDataEntryValue | null): number | null {
  const raw = String(value ?? '').trim();
  if (!raw) return null;

  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
}

export default async function CatalogModelNewPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);

  await requirePermission({
    code: PERMISSIONS.CATALOG_WRITE,
    redirectUrl: '/admin/no-permission',
    locale,
  });

  const t = await getTranslations('admin.catalog');
  const createFailedMessage = t('errors.createFailed');
  const successMessage = t('models.new.success');
  const vendors = await getVendors();
  const vendorOptions = vendors.map((vendor) => ({
    title: vendor.name,
    value: vendor.id,
  }));

  const crumbs: Crumb[] = [
    { title: t('crumbs.admin'), url: '/admin' },
    { title: t('crumbs.catalog'), url: '/admin/catalog/models' },
    { title: t('models.list.crumb'), url: '/admin/catalog/models' },
    { title: t('models.new.crumb'), is_active: true },
  ];

  const form: Form = {
    fields: [
      {
        name: 'modelId',
        type: 'text',
        title: t('fields.modelId'),
        validation: { required: true },
      },
      {
        name: 'displayName',
        type: 'text',
        title: t('fields.displayName'),
        validation: { required: true },
      },
      {
        name: 'vendorId',
        type: 'select',
        title: t('fields.vendor'),
        validation: { required: true },
        options: vendorOptions,
      },
      {
        name: 'category',
        type: 'text',
        title: t('fields.category'),
        validation: { required: true },
      },
      {
        name: 'contextWindow',
        type: 'number',
        title: t('fields.contextWindow'),
        validation: { min: 0 },
      },
    ],
    data: {
      vendorId: vendors[0]?.id ?? '',
      category: 'llm',
      contextWindow: '',
    },
    submit: {
      button: {
        title: t('models.new.buttons.submit'),
      },
      handler: async (data) => {
        'use server';

        const newModel = {
          modelId: (data.get('modelId') as string).trim(),
          displayName: (data.get('displayName') as string).trim(),
          vendorId: (data.get('vendorId') as string).trim(),
          category: (data.get('category') as string | null)?.trim() || 'llm',
          contextWindow: optionalNumber(data.get('contextWindow')),
        } as NewModel;

        const result = await createModel(newModel);

        if (!result) {
          throw new Error(createFailedMessage);
        }

        revalidateCatalog();

        return {
          status: 'success',
          message: successMessage,
          redirect_url: '/admin/catalog/models',
        };
      },
    },
  };

  return (
    <>
      <Header crumbs={crumbs} />
      <Main>
        <MainHeader title={t('models.new.title')} />
        <FormCard form={form} className="md:max-w-xl" />
      </Main>
    </>
  );
}
