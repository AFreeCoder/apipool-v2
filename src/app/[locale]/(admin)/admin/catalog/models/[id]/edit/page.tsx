import {
  getCategories,
  getModelById,
  getVendors,
  updateModel,
  UpdateModel,
} from '@/features/api-catalog/server/catalog-service';
import { revalidateCatalog } from '@/features/api-catalog/server/queries';
import { getTranslations, setRequestLocale } from 'next-intl/server';

import { PERMISSIONS, requirePermission } from '@/core/rbac';
import { Empty } from '@/shared/blocks/common';
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

export default async function CatalogModelEditPage({
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
  const successMessage = t('models.edit.success');
  const model = await getModelById(id);

  if (!model) {
    return <Empty message={t('models.edit.notFound')} />;
  }

  const vendors = await getVendors();
  const vendorOptions = vendors.map((vendor) => ({
    title: vendor.name,
    value: vendor.id,
  }));
  const categories = await getCategories();
  const categoryOptions = categories.map((category) => ({
    title: category.name,
    value: category.slug,
  }));

  const crumbs: Crumb[] = [
    { title: t('crumbs.admin'), url: '/admin' },
    { title: t('crumbs.catalog'), url: '/admin/catalog/models' },
    { title: t('models.list.crumb'), url: '/admin/catalog/models' },
    { title: t('models.edit.crumb'), is_active: true },
  ];

  const form: Form = {
    fields: [
      {
        name: 'modelId',
        type: 'text',
        title: t('fields.modelId'),
        validation: { required: true },
        attributes: { disabled: true },
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
        type: 'select',
        title: t('fields.category'),
        validation: { required: true },
        options: categoryOptions,
      },
      {
        name: 'contextWindow',
        type: 'number',
        title: t('fields.contextWindow'),
        validation: { min: 0 },
      },
    ],
    passby: {
      model,
    },
    data: model,
    submit: {
      button: {
        title: t('models.edit.buttons.submit'),
      },
      handler: async (data, passby) => {
        'use server';

        await requirePermission({ code: PERMISSIONS.CATALOG_WRITE });

        const { model } = passby;

        if (!model) {
          throw new Error(missingRecordMessage);
        }

        const patch: UpdateModel = {
          modelId: model.modelId,
          displayName: (data.get('displayName') as string).trim(),
          vendorId: (data.get('vendorId') as string).trim(),
          category: (data.get('category') as string | null)?.trim() || 'llm',
          contextWindow: optionalNumber(data.get('contextWindow')),
        };

        const result = await updateModel(model.id as string, patch);

        if (!result) {
          throw new Error(updateFailedMessage);
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
        <MainHeader title={t('models.edit.title')} />
        <FormCard form={form} className="md:max-w-xl" />
      </Main>
    </>
  );
}
