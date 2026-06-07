import { setRequestLocale } from 'next-intl/server';

import { redirect } from '@/core/i18n/navigation';

export default async function ApiKeysRedirect({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  redirect({ href: '/admin/apipool-adjustments', locale });
}
