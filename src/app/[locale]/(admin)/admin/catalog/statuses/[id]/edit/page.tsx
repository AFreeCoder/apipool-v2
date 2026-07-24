import { getTranslations, setRequestLocale } from 'next-intl/server';

import { PERMISSIONS, requirePermission } from '@/core/rbac';
import {
  getStatusById,
  UpdateCatalogStatus,
  updateStatus,
} from '@/features/api-catalog/server/catalog-service';
import { revalidateCatalog } from '@/features/api-catalog/server/queries';
import { Empty } from '@/shared/blocks/common';
import { Header, Main, MainHeader } from '@/shared/blocks/dashboard';
import { FormCard } from '@/shared/blocks/form';
import { Crumb } from '@/shared/types/blocks/common';
import { Form } from '@/shared/types/blocks/form';

export default async function CatalogStatusEditPage({
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
  const successMessage = t('statuses.edit.success');
  const catalogStatus = await getStatusById(id);

  if (!catalogStatus) {
    return <Empty message={t('statuses.edit.notFound')} />;
  }

  const crumbs: Crumb[] = [
    { title: t('crumbs.admin'), url: '/admin' },
    { title: t('crumbs.catalog'), url: '/admin/catalog/statuses' },
    { title: t('statuses.list.crumb'), url: '/admin/catalog/statuses' },
    { title: t('statuses.edit.crumb'), is_active: true },
  ];

  const form: Form = {
    fields: [
      {
        name: 'slug',
        type: 'text',
        title: t('fields.slug'),
        validation: { required: true },
        attributes: { disabled: true },
      },
      {
        name: 'name',
        type: 'text',
        title: t('fields.name'),
        validation: { required: true },
      },
      {
        name: 'isCallable',
        type: 'switch',
        title: t('fields.isCallable'),
      },
      {
        name: 'isPublicVisible',
        type: 'switch',
        title: t('fields.isPublicVisible'),
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
    data: catalogStatus,
    submit: {
      button: {
        title: t('statuses.edit.buttons.submit'),
      },
      handler: async (data) => {
        'use server';

        await requirePermission({ code: PERMISSIONS.CATALOG_WRITE });

        // 绝不信任客户端回传的记录快照：表单实参可被伪造、也可能是陈旧页面的旧值，
        // 写入目标一律按路由参数在服务端重查。
        const freshStatus = await getStatusById(id);

        if (!freshStatus) {
          return { status: 'error' as const, message: missingRecordMessage };
        }

        const patch: UpdateCatalogStatus = {
          slug: freshStatus.slug,
          name: (data.get('name') as string).trim(),
          isCallable: data.get('isCallable') === 'true',
          isPublicVisible: data.get('isPublicVisible') === 'true',
          sortOrder: Number(data.get('sortOrder') ?? 0),
          status: (data.get('status') as string) || 'active',
        };

        const result = await updateStatus(freshStatus.id, patch);

        if (!result) {
          return { status: 'error' as const, message: updateFailedMessage };
        }

        revalidateCatalog();

        return {
          status: 'success',
          message: successMessage,
          redirect_url: '/admin/catalog/statuses',
        };
      },
    },
  };

  return (
    <>
      <Header crumbs={crumbs} />
      <Main>
        <MainHeader title={t('statuses.edit.title')} />
        <FormCard form={form} className="md:max-w-xl" />
      </Main>
    </>
  );
}
