import { notFound } from 'next/navigation';
import { hasLocale, NextIntlClientProvider } from 'next-intl';
import { getLocale, setRequestLocale } from 'next-intl/server';

import { routing } from '@/core/i18n/config';
import { ThemeProvider } from '@/core/theme/provider';
import { LocaleDetector } from '@/shared/blocks/common';

export default async function LocaleTemplate({
  children,
}: {
  children: React.ReactNode;
}) {
  const locale = await getLocale();
  if (!hasLocale(routing.locales, locale)) {
    notFound();
  }

  setRequestLocale(locale);

  return (
    <NextIntlClientProvider key={locale}>
      <ThemeProvider>
        <LocaleDetector />
        {children}
      </ThemeProvider>
    </NextIntlClientProvider>
  );
}
