import {
  getCapabilities,
  getModelById,
  getModelCapabilities,
  setModelCapabilities,
} from '@/features/api-catalog/server/catalog-service';
import { revalidateCatalog } from '@/features/api-catalog/server/queries';
import { getTranslations, setRequestLocale } from 'next-intl/server';

import { PERMISSIONS, requirePermission } from '@/core/rbac';
import { Empty } from '@/shared/blocks/common';
import { Header, Main, MainHeader } from '@/shared/blocks/dashboard';
import { FormCard } from '@/shared/blocks/form';
import { Crumb } from '@/shared/types/blocks/common';
import { Form } from '@/shared/types/blocks/form';

export default async function CatalogModelCapabilitiesPage({
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
  const invalidSelectionMessage = t('models.capabilities.invalidSelection');
  const successMessage = t('models.capabilities.success');
  const model = await getModelById(id);

  if (!model) {
    return <Empty message={t('models.capabilities.notFound')} />;
  }

  const capabilities = await getCapabilities();
  const capabilitiesOptions = capabilities.map((capability) => ({
    title: capability.name,
    description: capability.slug,
    value: capability.id,
  }));
  const modelCapabilities = await getModelCapabilities(model.id);
  const modelCapabilityIds = modelCapabilities.map(
    (capability) => capability.id
  );

  const crumbs: Crumb[] = [
    { title: t('crumbs.admin'), url: '/admin' },
    { title: t('crumbs.catalog'), url: '/admin/catalog/models' },
    { title: t('models.list.crumb'), url: '/admin/catalog/models' },
    { title: t('models.capabilities.crumb'), is_active: true },
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
        attributes: { disabled: true },
      },
      {
        name: 'capabilities',
        type: 'checkbox',
        title: t('fields.capabilities'),
        options: capabilitiesOptions,
      },
    ],
    data: {
      ...model,
      capabilities: modelCapabilityIds,
    },
    submit: {
      button: {
        title: t('models.capabilities.buttons.submit'),
      },
      handler: async (data) => {
        'use server';

        await requirePermission({ code: PERMISSIONS.CATALOG_WRITE });

        // 绝不信任客户端回传的记录快照：表单实参可被伪造、也可能是陈旧页面的旧值，
        // 写入目标一律按路由参数在服务端重查。
        const freshModel = await getModelById(id);

        if (!freshModel) {
          return { status: 'error' as const, message: missingRecordMessage };
        }

        let capabilities = data.get('capabilities') as unknown as string[];
        if (typeof capabilities === 'string') {
          try {
            capabilities = JSON.parse(capabilities);
          } catch {
            return {
              status: 'error' as const,
              message: invalidSelectionMessage,
            };
          }
        }

        await setModelCapabilities(freshModel.id, capabilities);

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
        <MainHeader title={t('models.capabilities.title')} />
        <FormCard form={form} className="md:max-w-xl" />
      </Main>
    </>
  );
}
