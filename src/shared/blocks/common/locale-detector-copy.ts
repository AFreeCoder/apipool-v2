import enCommonMessages from '@/config/locale/messages/en/common.json';
import zhCommonMessages from '@/config/locale/messages/zh/common.json';

type LocaleDetectorMessages = {
  title: string;
  switch_to: string;
  close: string;
};

type LocaleDetectorCopy = {
  title: string;
  switchTo: string;
  close: string;
};

const localeDetectorMessages = {
  en: enCommonMessages.locale_detector,
  zh: zhCommonMessages.locale_detector,
} satisfies Record<string, LocaleDetectorMessages>;

function formatLocaleMessage(message: string, localeName: string) {
  return message.replaceAll('{locale}', localeName);
}

export function getLocaleDetectorCopy(
  locale: string,
  localeName: string
): LocaleDetectorCopy {
  const messages =
    localeDetectorMessages[locale as keyof typeof localeDetectorMessages] ??
    localeDetectorMessages.en;

  return {
    title: formatLocaleMessage(messages.title, localeName),
    switchTo: formatLocaleMessage(messages.switch_to, localeName),
    close: messages.close,
  };
}
