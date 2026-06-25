import { getTranslations, setRequestLocale } from 'next-intl/server';
import { notFound } from 'next/navigation';

import { PERMISSIONS, requirePermission } from '@/core/rbac';
import { Header, Main, MainHeader } from '@/shared/blocks/dashboard';
import { FormCard } from '@/shared/blocks/form';
import { getAllConfigs, saveConfigs } from '@/shared/models/config';
import {
  getSettings,
  getSettingTabs,
  Setting,
} from '@/shared/services/settings';
import { Crumb } from '@/shared/types/blocks/common';
import { Form, FormField } from '@/shared/types/blocks/form';

const supportedFormFieldTypes = new Set<FormField['type']>([
  'text',
  'textarea',
  'number',
  'email',
  'password',
  'select',
  'url',
  'editor',
  'code_editor',
  'richtext_editor',
  'markdown_editor',
  'switch',
  'checkbox',
  'upload_image',
]);

function toFormFieldType(type: string): FormField['type'] {
  return supportedFormFieldTypes.has(type as FormField['type'])
    ? (type as FormField['type'])
    : 'text';
}

export function collectNonEmptyConfigs(
  data: FormData,
  settings: Pick<Setting, 'name'>[]
) {
  const configs: Record<string, string> = {};

  for (const setting of settings) {
    const value = data.get(setting.name);
    if (typeof value !== 'string' || value.trim() === '') {
      continue;
    }
    configs[setting.name] = value;
  }

  return configs;
}

export default async function SettingsPage({
  params,
}: {
  params: Promise<{ locale: string; tab: string }>;
}) {
  const { locale, tab } = await params;
  setRequestLocale(locale);

  await requirePermission({
    code: PERMISSIONS.SETTINGS_READ,
    redirectUrl: '/admin/no-permission',
    locale,
  });

  const t = await getTranslations('admin.settings');
  const tabs = await getSettingTabs(tab);
  const activeTab = tabs.find((item) => item.name === tab);
  if (!activeTab) {
    notFound();
  }

  const [allSettings, configs] = await Promise.all([
    getSettings(),
    getAllConfigs(),
  ]);
  const currentSettings = allSettings.filter((setting) => setting.tab === tab);
  const passwordConfiguredPlaceholder = t(
    'edit.placeholders.configured_password'
  );

  const fields: FormField[] = currentSettings.map((setting) => {
    const isPassword = setting.type === 'password';
    const hasConfiguredValue = Boolean(configs[setting.name]);

    return {
      name: setting.name,
      type: toFormFieldType(setting.type),
      title: setting.title,
      placeholder:
        isPassword && hasConfiguredValue
          ? passwordConfiguredPlaceholder
          : setting.placeholder,
      options: setting.options,
      tip: setting.tip,
      attributes: setting.attributes,
      group: setting.group,
      value: isPassword ? '' : configs[setting.name] ?? '',
    };
  });

  const crumbs: Crumb[] = [
    { title: t('edit.crumbs.admin'), url: '/admin' },
    { title: t('edit.crumbs.settings'), is_active: true },
  ];

  const form: Form = {
    fields,
    passby: {
      tab,
      settings: currentSettings.map((setting) => ({ name: setting.name })),
    },
    submit: {
      button: {
        title: t('edit.buttons.submit'),
      },
      handler: async (data, passby) => {
        'use server';

        const configs = collectNonEmptyConfigs(data, passby.settings);
        if (Object.keys(configs).length > 0) {
          await saveConfigs(configs);
        }

        return {
          status: 'success',
          message: 'settings updated',
          redirect_url: `/admin/settings/${passby.tab}`,
        };
      },
    },
  };

  return (
    <>
      <Header crumbs={crumbs} />
      <Main>
        <MainHeader title={t('edit.title')} tabs={tabs} />
        <FormCard title={activeTab.title} form={form} className="md:max-w-xl" />
      </Main>
    </>
  );
}
