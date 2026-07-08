import {
  CatalogDeleteBlockedError,
  deleteGroup,
  getGroupById,
} from '@/features/api-catalog/server/catalog-service';
import { revalidateCatalog } from '@/features/api-catalog/server/queries';
import { getTranslations, setRequestLocale } from 'next-intl/server';

import { PERMISSIONS, requirePermission } from '@/core/rbac';
import { Empty } from '@/shared/blocks/common';
import { Header, Main, MainHeader } from '@/shared/blocks/dashboard';
import { FormCard } from '@/shared/blocks/form';
import { Crumb } from '@/shared/types/blocks/common';
import { Form } from '@/shared/types/blocks/form';

export default async function CatalogGroupDeletePage({
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
  const blockedMessage = t('groups.delete.blocked');
  const successMessage = t('groups.delete.success');
  const group = await getGroupById(id);

  if (!group) {
    return <Empty message={t('groups.delete.notFound')} />;
  }

  const crumbs: Crumb[] = [
    { title: t('crumbs.admin'), url: '/admin' },
    { title: t('crumbs.catalog'), url: '/admin/catalog/groups' },
    { title: t('groups.list.crumb'), url: '/admin/catalog/groups' },
    { title: t('groups.delete.crumb'), is_active: true },
  ];

  const form: Form = {
    fields: [],
    passby: {
      group,
    },
    submit: {
      button: {
        title: t('groups.delete.buttons.submit'),
        icon: 'Trash2',
        variant: 'destructive',
      },
      handler: async (_data, passby) => {
        'use server';

        await requirePermission({ code: PERMISSIONS.CATALOG_WRITE });

        const target = passby?.group;
        if (!target?.id) {
          throw new Error(missingRecordMessage);
        }

        try {
          await deleteGroup(target.id);
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
          redirect_url: '/admin/catalog/groups',
        };
      },
    },
  };

  return (
    <>
      <Header crumbs={crumbs} />
      <Main>
        <MainHeader
          title={t('groups.delete.title')}
          description={t('groups.delete.description', {
            name: group.name,
            slug: group.slug,
          })}
          actions={[
            {
              title: t('groups.delete.buttons.cancel'),
              icon: 'ArrowLeft',
              variant: 'outline',
              url: '/admin/catalog/groups',
            },
          ]}
        />
        <FormCard form={form} className="md:max-w-xl" />
      </Main>
    </>
  );
}
