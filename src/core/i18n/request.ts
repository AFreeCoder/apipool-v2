import { getRequestConfig } from 'next-intl/server';

import {
  AppLocale,
  defaultLocale,
  localeMessagesPaths,
  localeMessagesRootPath,
  normalizeLocale,
} from '@/config/locale';

import { routing } from './config';

export async function loadMessages(
  path: string,
  locale: string = defaultLocale
) {
  const normalizedLocale = normalizeLocale(locale);
  const fallbackLocales = [
    normalizedLocale,
    ...(normalizedLocale.startsWith('zh') ? ['zh'] : []),
    defaultLocale,
  ].filter((item, index, items) => item && items.indexOf(item) === index);

  for (const fallbackLocale of fallbackLocales) {
    try {
      const messages = await import(
        `@/config/locale/messages/${fallbackLocale}/${path}.json`
      );
      return messages.default;
    } catch {
      continue;
    }
  }

  return {};
}

export default getRequestConfig(async ({ requestLocale }) => {
  const requestedLocale = await requestLocale;
  let locale: AppLocale = normalizeLocale(requestedLocale);
  if (!routing.locales.includes(locale)) {
    locale = routing.defaultLocale;
  }

  try {
    // load all local messages
    const allMessages = await Promise.all(
      localeMessagesPaths.map((path) => loadMessages(path, locale))
    );

    // merge all local messages
    const messages: any = {};

    localeMessagesPaths.forEach((path, index) => {
      const localMessages = allMessages[index];

      const keys = path.split('/');
      let current = messages;

      for (let i = 0; i < keys.length - 1; i++) {
        if (!current[keys[i]]) {
          current[keys[i]] = {};
        }
        current = current[keys[i]];
      }

      current[keys[keys.length - 1]] = localMessages;
    });

    return {
      locale,
      messages,
    };
  } catch (e) {
    return {
      locale: defaultLocale,
      messages: await loadMessages(localeMessagesRootPath, defaultLocale),
    };
  }
});
