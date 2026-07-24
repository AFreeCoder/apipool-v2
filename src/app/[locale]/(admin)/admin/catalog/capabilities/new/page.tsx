import { getTranslations, setRequestLocale } from 'next-intl/server';

import { PERMISSIONS, requirePermission } from '@/core/rbac';
import { isUniqueConstraintError } from '@/features/api-catalog/lib/errors';
import {
  createCapability,
  NewCapability,
} from '@/features/api-catalog/server/catalog-service';
import { revalidateCatalog } from '@/features/api-catalog/server/queries';
import { Header, Main, MainHeader } from '@/shared/blocks/dashboard';
import { FormCard } from '@/shared/blocks/form';
import { Crumb } from '@/shared/types/blocks/common';
import { Form } from '@/shared/types/blocks/form';

export default async function CatalogCapabilityNewPage({
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
  const duplicateSlugMessage = t('errors.duplicateSlug');
  const successMessage = t('capabilities.new.success');

  const crumbs: Crumb[] = [
    { title: t('crumbs.admin'), url: '/admin' },
    { title: t('crumbs.catalog'), url: '/admin/catalog/capabilities' },
    {
      title: t('capabilities.list.crumb'),
      url: '/admin/catalog/capabilities',
    },
    { title: t('capabilities.new.crumb'), is_active: true },
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
    data: {
      sortOrder: 0,
      status: 'active',
    },
    submit: {
      button: {
        title: t('capabilities.new.buttons.submit'),
      },
      handler: async (data) => {
        'use server';

        await requirePermission({ code: PERMISSIONS.CATALOG_WRITE });

        const newCapability = {
          slug: (data.get('slug') as string).trim(),
          name: (data.get('name') as string).trim(),
          sortOrder: Number(data.get('sortOrder') ?? 0),
          status: (data.get('status') as string) || 'active',
        } as NewCapability;

        let result;
        try {
          result = await createCapability(newCapability);
        } catch (error) {
          // 撞 slug 唯一索引：给出可读提示而非原始 SQLite 错误
          // （生产还会被 Next.js 脱敏成通用英文）。约束文案在 error.cause 里。
          if (isUniqueConstraintError(error)) {
            return { status: 'error' as const, message: duplicateSlugMessage };
          }
          throw error;
        }

        if (!result) {
          return { status: 'error' as const, message: createFailedMessage };
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
        <MainHeader title={t('capabilities.new.title')} />
        <FormCard form={form} className="md:max-w-xl" />
      </Main>
    </>
  );
}
