import { getTranslations, setRequestLocale } from 'next-intl/server';

import { PERMISSIONS, requirePermission } from '@/core/rbac';
import { Empty } from '@/shared/blocks/common';
import { Header, Main, MainHeader } from '@/shared/blocks/dashboard';
import { FormCard } from '@/shared/blocks/form';
import { findUserById, updateUser, UpdateUser } from '@/shared/models/user';
import { Crumb } from '@/shared/types/blocks/common';
import { Form } from '@/shared/types/blocks/form';

export default async function UserEditPage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const { locale, id } = await params;
  setRequestLocale(locale);

  // Check if user has permission to edit posts
  await requirePermission({
    code: PERMISSIONS.USERS_WRITE,
    redirectUrl: '/admin/no-permission',
    locale,
  });

  const t = await getTranslations('admin.users');
  // Captured at render time: the inline server action can only close over
  // serializable values, not the translator itself.
  const savedMessage = t('messages.userSaved');
  const notFoundMessage = t('empty.not_found');
  const updateFailedMessage = t('messages.updateFailed');
  const user = await findUserById(id);
  if (!user) {
    return <Empty message={t('empty.not_found')} />;
  }

  const crumbs: Crumb[] = [
    { title: t('edit.crumbs.admin'), url: '/admin' },
    { title: t('edit.crumbs.users'), url: '/admin/users' },
    { title: t('edit.crumbs.edit'), is_active: true },
  ];

  const form: Form = {
    fields: [
      {
        name: 'email',
        type: 'text',
        title: t('fields.email'),
        validation: { required: true },
        attributes: { disabled: true },
      },
      {
        name: 'name',
        type: 'text',
        title: t('fields.name'),
        validation: { required: true },
      },
    ],
    data: user,
    submit: {
      button: {
        title: t('edit.buttons.submit'),
      },
      handler: async (data) => {
        'use server';

        await requirePermission({ code: PERMISSIONS.USERS_WRITE });

        const targetUser = await findUserById(id);
        if (!targetUser) {
          return { status: 'error' as const, message: notFoundMessage };
        }

        const name = data.get('name') as string;

        // MVP: the avatar field was removed from this form. The upload
        // endpoint is disabled (always 404), and a failed upload set the
        // form value to '', so submitting used to wipe the stored avatar.
        // Only `name` is editable here now, leaving `image` untouched.
        const newUser: UpdateUser = {
          name: name.trim(),
        };

        const result = await updateUser(targetUser.id as string, newUser);

        if (!result) {
          return { status: 'error' as const, message: updateFailedMessage };
        }

        return {
          status: 'success',
          message: savedMessage,
          redirect_url: '/admin/users',
        };
      },
    },
  };

  return (
    <>
      <Header crumbs={crumbs} />
      <Main>
        <MainHeader title={t('edit.title')} />
        <FormCard form={form} className="md:max-w-xl" />
      </Main>
    </>
  );
}
