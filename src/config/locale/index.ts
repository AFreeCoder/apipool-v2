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
  'settings/sidebar',
  'settings/profile',
  'settings/security',
  'admin/sidebar',
  'admin/users',
  'admin/roles',
  'admin/permissions',
  'admin/apikeys',
];
