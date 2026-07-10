import { getTranslations, setRequestLocale } from 'next-intl/server';

import { PERMISSIONS, requireAllPermissions } from '@/core/rbac';
import { Empty } from '@/shared/blocks/common';
import { Header, Main, MainHeader } from '@/shared/blocks/dashboard';
import { FormCard } from '@/shared/blocks/form';
import { findUserById, getUserInfo } from '@/shared/models/user';
import {
  assignRolesToUser,
  getRoles,
  getUserRoles,
} from '@/shared/services/rbac';
import { Crumb } from '@/shared/types/blocks/common';
import { Form } from '@/shared/types/blocks/form';

export default async function UserEditRolesPage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const { locale, id } = await params;
  setRequestLocale(locale);

  // Check if user has permission to edit posts
  await requireAllPermissions({
    codes: [PERMISSIONS.USERS_WRITE, PERMISSIONS.ROLES_WRITE],
    redirectUrl: '/admin/no-permission',
    locale,
  });

  const t = await getTranslations('admin.users');
  const savedMessage = t('messages.rolesSaved');
  const notFoundMessage = t('empty.not_found');
  const invalidRolesMessage = t('messages.invalidRoles');
  const user = await findUserById(id);
  if (!user) {
    return <Empty message={t('empty.not_found')} />;
  }

  // Warn (do not block) when an admin edits their own roles: dropping their
  // own admin role locks them out of the admin area entirely.
  const currentUser = await getUserInfo();
  const isEditingSelf = currentUser?.id === user.id;

  const crumbs: Crumb[] = [
    { title: t('edit_roles.crumbs.admin'), url: '/admin' },
    { title: t('edit_roles.crumbs.users'), url: '/admin/users' },
    { title: t('edit_roles.crumbs.edit_roles'), is_active: true },
  ];

  const roles = await getRoles();
  const rolesOptions = roles.map((role) => ({
    title: role.title,
    description: role.description,
    value: role.id,
  }));

  const userRoles = await getUserRoles(user.id as string);
  const userRoleIds = userRoles.map((role) => role.id);

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
        name: 'roles',
        type: 'checkbox',
        title: t('fields.roles'),
        options: rolesOptions,
        // Deliberately not required: most portal users hold zero roles, and
        // demoting an admin means clearing their last one. The red star used
        // to claim otherwise while nothing enforced it.
      },
    ],
    data: {
      ...user,
      roles: userRoleIds,
    },
    submit: {
      button: {
        title: t('edit_roles.buttons.submit'),
      },
      handler: async (data) => {
        'use server';

        await requireAllPermissions({
          codes: [PERMISSIONS.USERS_WRITE, PERMISSIONS.ROLES_WRITE],
        });

        const targetUser = await findUserById(id);
        if (!targetUser) {
          return { status: 'error' as const, message: notFoundMessage };
        }

        let roles = data.get('roles') as unknown as string[];
        if (typeof roles === 'string') {
          try {
            roles = JSON.parse(roles);
          } catch {
            return { status: 'error' as const, message: invalidRolesMessage };
          }
        }

        if (
          !Array.isArray(roles) ||
          roles.some((roleId) => typeof roleId !== 'string')
        ) {
          return { status: 'error' as const, message: invalidRolesMessage };
        }

        const allowedRoleIds = new Set(
          (await getRoles()).map((role) => role.id)
        );
        if (roles.some((roleId) => !allowedRoleIds.has(roleId))) {
          return { status: 'error' as const, message: invalidRolesMessage };
        }

        await assignRolesToUser(targetUser.id as string, roles);

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
        <MainHeader title={t('edit_roles.title')} />
        {isEditingSelf && (
          <div className="mb-4 rounded-md border border-amber-500/50 bg-amber-500/10 px-4 py-3 text-sm text-amber-700 md:max-w-xl dark:text-amber-400">
            {t('edit_roles.self_edit_warning')}
          </div>
        )}
        <FormCard form={form} className="md:max-w-xl" />
      </Main>
    </>
  );
}
