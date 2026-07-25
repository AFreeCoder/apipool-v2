import { getTranslations, setRequestLocale } from 'next-intl/server';

import { PERMISSIONS, requirePermission } from '@/core/rbac';
import {
  getGroupById,
  UpdateCatalogGroup,
  updateGroup,
} from '@/features/api-catalog/server/catalog-service';
import { revalidateCatalog } from '@/features/api-catalog/server/queries';
import { Empty } from '@/shared/blocks/common';
import { Header, Main, MainHeader } from '@/shared/blocks/dashboard';
import { FormCard } from '@/shared/blocks/form';
import { Crumb } from '@/shared/types/blocks/common';
import { Form } from '@/shared/types/blocks/form';

export default async function CatalogGroupEditPage({
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
  const successMessage = t('groups.edit.success');
  const group = await getGroupById(id);

  if (!group) {
    return <Empty message={t('groups.edit.notFound')} />;
  }

  const crumbs: Crumb[] = [
    { title: t('crumbs.admin'), url: '/admin' },
    { title: t('crumbs.catalog'), url: '/admin/catalog/groups' },
    { title: t('groups.list.crumb'), url: '/admin/catalog/groups' },
    { title: t('groups.edit.crumb'), is_active: true },
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
        name: 'userDescription',
        type: 'textarea',
        title: t('fields.userDescription'),
      },
      {
        name: 'allowCreateKey',
        type: 'switch',
        title: t('fields.allowCreateKey'),
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
    data: group,
    submit: {
      button: {
        title: t('groups.edit.buttons.submit'),
      },
      handler: async (data) => {
        'use server';

        await requirePermission({ code: PERMISSIONS.CATALOG_WRITE });

        // 绝不信任客户端回传的记录快照：表单实参可被伪造、也可能是陈旧页面的旧值，
        // 写入目标一律按路由参数在服务端重查。
        const freshGroup = await getGroupById(id);

        if (!freshGroup) {
          return { status: 'error' as const, message: missingRecordMessage };
        }

        const patch: UpdateCatalogGroup = {
          slug: freshGroup.slug,
          name: (data.get('name') as string).trim(),
          userDescription:
            (data.get('userDescription') as string | null)?.trim() || null,
          allowCreateKey: data.get('allowCreateKey') === 'true',
          sortOrder: Number(data.get('sortOrder') ?? 0),
          status: (data.get('status') as string) || 'active',
        };

        const result = await updateGroup(freshGroup.id, patch);

        if (!result) {
          return { status: 'error' as const, message: updateFailedMessage };
        }

        revalidateCatalog();

        return {
          status: 'success',
          message: successMessage,
          redirect_url: '/admin/catalog/groups',
        };
      },
    },
  };

  return (
    <>
      <Header crumbs={crumbs} />
      <Main>
        <MainHeader title={t('groups.edit.title')} />
        <FormCard form={form} className="md:max-w-xl" />
      </Main>
    </>
  );
}
