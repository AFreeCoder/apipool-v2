import { notFound } from 'next/navigation';
import { getTranslations, setRequestLocale } from 'next-intl/server';

import {
  PERMISSIONS,
  requireAllPermissions,
  requirePermission,
} from '@/core/rbac';
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

/**
 * 从表单收集要写入的配置。
 *
 * 密钥字段（type='password'）总是渲染为空白（见下方 `value: isPassword ? ''`），
 * 所以「空」意味着「没改」，必须跳过——否则每次保存设置都会抹掉 stripe_secret_key
 * 之类的已存密钥。
 *
 * 其余字段会回填现有值，「空」意味着「用户清空了它」，必须写入空串，
 * 否则作废的配置项（如已停用的 promotion code）永远无法从 UI 删除。
 */
export function collectNonEmptyConfigs(
  data: FormData,
  settings: Pick<Setting, 'name' | 'type'>[]
) {
  const configs: Record<string, string> = {};
  const validators: Record<
    string,
    { label: string; pattern: RegExp; expected: string }
  > = {
    stripe_secret_key: {
      label: 'Stripe Secret Key',
      pattern: /^(sk|rk)_(test|live)_[A-Za-z0-9]+$/,
      expected: 'a Stripe secret or restricted key',
    },
    stripe_signing_secret: {
      label: 'Stripe Signing Secret',
      pattern: /^whsec_[A-Za-z0-9]+$/,
      expected: 'a Stripe webhook signing secret',
    },
  };

  for (const setting of settings) {
    const value = data.get(setting.name);
    if (typeof value !== 'string') {
      continue;
    }

    const trimmedValue = value.trim();
    if (!trimmedValue) {
      // 密钥字段空白 = 未修改；其余字段空白 = 主动清空
      if (setting.type === 'password') continue;
      configs[setting.name] = '';
      continue;
    }

    const validator = validators[setting.name];
    if (validator && !validator.pattern.test(trimmedValue)) {
      throw new Error(`${validator.label} must be ${validator.expected}`);
    }

    configs[setting.name] = validator ? trimmedValue : value;
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
    const passwordAttributes = isPassword
      ? {
          autoComplete: 'new-password',
          'data-lpignore': 'true',
          'data-1p-ignore': 'true',
        }
      : {};

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
      attributes: {
        ...setting.attributes,
        ...passwordAttributes,
      },
      group: setting.group,
      value: isPassword ? '' : (configs[setting.name] ?? ''),
    };
  });

  const crumbs: Crumb[] = [
    { title: t('edit.crumbs.admin'), url: '/admin' },
    { title: t('edit.crumbs.settings'), is_active: true },
  ];

  const form: Form = {
    fields,
    submit: {
      button: {
        title: t('edit.buttons.submit'),
      },
      handler: async (data) => {
        'use server';

        await requireAllPermissions({
          codes: [PERMISSIONS.SETTINGS_READ, PERMISSIONS.SETTINGS_WRITE],
        });

        const writableSettings = (await getSettings())
          .filter((setting) => setting.tab === tab)
          .map((setting) => ({ name: setting.name, type: setting.type }));
        const configs = collectNonEmptyConfigs(data, writableSettings);
        if (Object.keys(configs).length > 0) {
          await saveConfigs(configs);
        }

        return {
          status: 'success',
          message: 'settings updated',
          redirect_url: `/admin/settings/${tab}`,
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
