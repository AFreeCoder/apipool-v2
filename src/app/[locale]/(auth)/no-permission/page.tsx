import { getTranslations, setRequestLocale } from 'next-intl/server';

export default async function NoPermissionPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('common.no_permission');

  return (
    <div className="flex h-screen flex-col items-center justify-center">
      <h1 className="text-2xl font-normal">{t('access_denied')}</h1>
    </div>
  );
}
