import { getTranslations, setRequestLocale } from 'next-intl/server';

import { Link } from '@/core/i18n/navigation';
import { Header, Main } from '@/shared/blocks/dashboard';
import { Button } from '@/shared/components/ui/button';

export default async function NoPermissionPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations('admin.noPermission');

  return (
    <>
      {/* 保留后台顶栏：否则移动端连侧栏抽屉都打不开，是个死胡同。 */}
      <Header />
      <Main>
        <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 text-center">
          <div className="space-y-2">
            <h1 className="text-2xl font-semibold">{t('title')}</h1>
            <p className="text-muted-foreground mx-auto max-w-md text-sm">
              {t('description')}
            </p>
          </div>
          <Button asChild variant="outline">
            <Link href="/admin">{t('backToConsole')}</Link>
          </Button>
        </div>
      </Main>
    </>
  );
}
