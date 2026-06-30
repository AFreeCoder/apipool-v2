import { envConfigs } from '..';

export type AppLocale = 'zh-CN' | 'zh-TW' | 'en';

export const localeNames: Record<AppLocale, string> = {
  'zh-CN': '简体中文',
  'zh-TW': '繁體中文',
  en: 'English',
};

export const locales: AppLocale[] = ['zh-CN', 'zh-TW', 'en'];

export const legacyLocaleAliases: Record<string, AppLocale> = {
  zh: 'zh-CN',
};

export function normalizeLocale(locale?: string | null): AppLocale {
  return matchSupportedLocale(locale) ?? 'zh-CN';
}

export function matchSupportedLocale(locale?: string | null): AppLocale | null {
  if (!locale) {
    return null;
  }

  if (locales.includes(locale as AppLocale)) {
    return locale as AppLocale;
  }

  if (legacyLocaleAliases[locale]) {
    return legacyLocaleAliases[locale];
  }

  const normalized = locale.replace(/[^\w-]/g, '').toLowerCase();

  if (['zh-tw', 'zh-hk', 'zh-mo'].includes(normalized)) {
    return 'zh-TW';
  }

  if (normalized === 'zh' || normalized.startsWith('zh-')) {
    return 'zh-CN';
  }

  if (normalized === 'en' || normalized.startsWith('en-')) {
    return 'en';
  }

  return null;
}

export function localizePath(path: string, locale?: string | null): string {
  const normalizedLocale = normalizeLocale(locale);
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;

  for (const item of [...locales, ...Object.keys(legacyLocaleAliases)]) {
    if (normalizedPath === `/${item}`) {
      return `/${normalizedLocale}`;
    }

    if (normalizedPath.startsWith(`/${item}/`)) {
      return `/${normalizedLocale}${normalizedPath.slice(item.length + 1)}`;
    }
  }

  return `/${normalizedLocale}${normalizedPath === '/' ? '' : normalizedPath}`;
}

export const defaultLocale = normalizeLocale(envConfigs.locale);

export const localePrefix = 'always';

export const localeDetection = false;

export const localeMessagesRootPath = '@/config/locale/messages';

export const localeMessagesPaths = [
  'common',
  'site',
  'pages/home',
  'pages/models',
  'pages/pricing',
  'dashboard/common',
  'dashboard/overview',
  'dashboard/billing',
  'dashboard/usage',
  'dashboard/apiKeys',
  'settings/sidebar',
  'settings/profile',
  'settings/security',
  'admin/sidebar',
  'admin/users',
  'admin/roles',
  'admin/permissions',
  'admin/apikeys',
  'admin/catalog',
  'admin/settings',
];
