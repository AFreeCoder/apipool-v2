import {
  CatalogDeleteBlockedError,
  deleteCategory,
  getCategoryById,
} from '@/features/api-catalog/server/catalog-service';
import { revalidateCatalog } from '@/features/api-catalog/server/queries';
import { getTranslations, setRequestLocale } from 'next-intl/server';

import { PERMISSIONS, requirePermission } from '@/core/rbac';
import { Empty } from '@/shared/blocks/common';
import { Header, Main, MainHeader } from '@/shared/blocks/dashboard';
import { FormCard } from '@/shared/blocks/form';
import { Crumb } from '@/shared/types/blocks/common';
import { Form } from '@/shared/types/blocks/form';

export default async function CatalogCategoryDeletePage({
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
  const blockedMessage = t('categories.delete.blocked');
  const successMessage = t('categories.delete.success');
  const category = await getCategoryById(id);

  if (!category) {
    return <Empty message={t('categories.delete.notFound')} />;
  }

  const crumbs: Crumb[] = [
    { title: t('crumbs.admin'), url: '/admin' },
    { title: t('crumbs.catalog'), url: '/admin/catalog/categories' },
    { title: t('categories.list.crumb'), url: '/admin/catalog/categories' },
    { title: t('categories.delete.crumb'), is_active: true },
  ];

  const form: Form = {
    fields: [],
    passby: {
      category,
    },
    submit: {
      button: {
        title: t('categories.delete.buttons.submit'),
        icon: 'Trash2',
        variant: 'destructive',
      },
      handler: async (_data, passby) => {
        'use server';

        await requirePermission({ code: PERMISSIONS.CATALOG_WRITE });

        const target = passby?.category;
        if (!target?.id) {
          return { status: 'error' as const, message: missingRecordMessage };
        }

        try {
          await deleteCategory(target.id);
        } catch (error) {
          if (error instanceof CatalogDeleteBlockedError) {
            return { status: 'error' as const, message: blockedMessage };
          }
          return { status: 'error' as const, message: deleteFailedMessage };
        }

        revalidateCatalog();

        return {
          status: 'success',
          message: successMessage,
          redirect_url: '/admin/catalog/categories',
        };
      },
    },
  };

  return (
    <>
      <Header crumbs={crumbs} />
      <Main>
        <MainHeader
          title={t('categories.delete.title')}
          description={t('categories.delete.description', {
            name: category.name,
            slug: category.slug,
          })}
          actions={[
            {
              title: t('categories.delete.buttons.cancel'),
              icon: 'ArrowLeft',
              variant: 'outline',
              url: '/admin/catalog/categories',
            },
          ]}
        />
        <FormCard form={form} className="md:max-w-xl" />
      </Main>
    </>
  );
}
