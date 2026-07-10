import { getTranslations, setRequestLocale } from 'next-intl/server';

import { Link } from '@/core/i18n/navigation';
import { Button } from '@/shared/components/ui/button';

export default async function NoPermissionPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('common.no_permission');

  return (
    <div className="flex h-screen flex-col items-center justify-center gap-4 px-4 text-center">
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold">{t('access_denied')}</h1>
        <p className="text-muted-foreground mx-auto max-w-md text-sm">
          {t('description')}
        </p>
      </div>
      <Button asChild variant="outline">
        <Link href="/">{t('back_home')}</Link>
      </Button>
    </div>
  );
}
