import { getTranslations, setRequestLocale } from 'next-intl/server';

import { PERMISSIONS, requirePermission } from '@/core/rbac';
import {
  deleteModel,
  getListingsByModel,
  getModelById,
} from '@/features/api-catalog/server/catalog-service';
import { revalidateCatalog } from '@/features/api-catalog/server/queries';
import { Empty } from '@/shared/blocks/common';
import { Header, Main, MainHeader } from '@/shared/blocks/dashboard';
import { FormCard } from '@/shared/blocks/form';
import { Crumb } from '@/shared/types/blocks/common';
import { Form } from '@/shared/types/blocks/form';

export default async function CatalogModelDeletePage({
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
  const successMessage = t('models.delete.success');
  const model = await getModelById(id);

  if (!model) {
    return <Empty message={t('models.delete.notFound')} />;
  }

  const listings = await getListingsByModel(model.id);
  const crumbs: Crumb[] = [
    { title: t('crumbs.admin'), url: '/admin' },
    { title: t('crumbs.catalog'), url: '/admin/catalog/models' },
    { title: t('models.list.crumb'), url: '/admin/catalog/models' },
    { title: t('models.delete.crumb'), is_active: true },
  ];

  const form: Form = {
    fields: [],
    submit: {
      button: {
        title: t('models.delete.buttons.submit'),
        icon: 'Trash2',
        variant: 'destructive',
      },
      handler: async () => {
        'use server';

        await requirePermission({ code: PERMISSIONS.CATALOG_WRITE });

        // 绝不信任客户端回传的记录快照：表单实参可伪造/可能陈旧，删除目标按路由参数重查。
        const freshModel = await getModelById(id);
        if (!freshModel) {
          return { status: 'error' as const, message: missingRecordMessage };
        }

        try {
          await deleteModel(freshModel.id);
        } catch {
          return { status: 'error' as const, message: deleteFailedMessage };
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
        <MainHeader
          title={t('models.delete.title')}
          description={t('models.delete.description', {
            modelId: model.modelId,
            listings: listings.length,
          })}
          actions={[
            {
              title: t('models.delete.buttons.cancel'),
              icon: 'ArrowLeft',
              variant: 'outline',
              url: '/admin/catalog/models',
            },
          ]}
        />
        <FormCard form={form} className="md:max-w-xl" />
      </Main>
    </>
  );
}
