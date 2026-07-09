import { envConfigs } from '..';

export const localeNames: any = {
  en: 'English',
  zh: '中文',
};

export const locales = ['en', 'zh'];

export const defaultLocale = envConfigs.locale;

export const localePrefix = 'as-needed';

export const localeDetection = false;

export const localeMessagesRootPath = '@/config/locale/messages';

export const localeMessagesPaths = [
  'common',
  'site',
  'pages/home',
  'pages/models',
  'pages/pricing',
  'pages/errors',
  'dashboard/common',
  'dashboard/overview',
  'dashboard/billing',
  'dashboard/usage',
  'dashboard/apiKeys',
  'settings/sidebar',
  'settings/profile',
  'settings/security',
  'admin/common',
  'admin/sidebar',
  'admin/users',
  'admin/roles',
  'admin/permissions',
  'admin/apikeys',
  'admin/apipoolAdjustments',
  'admin/catalog',
  'admin/settings',
];
