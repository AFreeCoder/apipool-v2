import {
  createGroup,
  NewCatalogGroup,
} from '@/features/api-catalog/server/catalog-service';
import { revalidateCatalog } from '@/features/api-catalog/server/queries';
import { getTranslations, setRequestLocale } from 'next-intl/server';

import { PERMISSIONS, requirePermission } from '@/core/rbac';
import { Header, Main, MainHeader } from '@/shared/blocks/dashboard';
import { FormCard } from '@/shared/blocks/form';
import { Crumb } from '@/shared/types/blocks/common';
import { Form } from '@/shared/types/blocks/form';

export default async function CatalogGroupNewPage({
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
  const successMessage = t('groups.new.success');

  const crumbs: Crumb[] = [
    { title: t('crumbs.admin'), url: '/admin' },
    { title: t('crumbs.catalog'), url: '/admin/catalog/groups' },
    { title: t('groups.list.crumb'), url: '/admin/catalog/groups' },
    { title: t('groups.new.crumb'), is_active: true },
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
        name: 'userDescription',
        type: 'textarea',
        title: t('fields.userDescription'),
      },
      {
        name: 'newapiGroup',
        type: 'text',
        title: t('fields.newapiGroup'),
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
    data: {
      userDescription: '',
      newapiGroup: '',
      allowCreateKey: true,
      sortOrder: 0,
      status: 'active',
    },
    submit: {
      button: {
        title: t('groups.new.buttons.submit'),
      },
      handler: async (data) => {
        'use server';

        await requirePermission({ code: PERMISSIONS.CATALOG_WRITE });

        const newGroup = {
          slug: (data.get('slug') as string).trim(),
          name: (data.get('name') as string).trim(),
          userDescription:
            (data.get('userDescription') as string | null)?.trim() || null,
          newapiGroup: (data.get('newapiGroup') as string | null)?.trim() || '',
          allowCreateKey: data.get('allowCreateKey') === 'true',
          sortOrder: Number(data.get('sortOrder') ?? 0),
          status: (data.get('status') as string) || 'active',
        } as NewCatalogGroup;

        const result = await createGroup(newGroup);

        if (!result) {
          throw new Error(createFailedMessage);
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
        <MainHeader title={t('groups.new.title')} />
        <FormCard form={form} className="md:max-w-xl" />
      </Main>
    </>
  );
}
