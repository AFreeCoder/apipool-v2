import { getTranslations } from 'next-intl/server';

import { Link } from '@/core/i18n/navigation';
import { SiteShell } from '@/features/apipool-ui/site-shell';
import { Button } from '@/shared/components/ui/button';

// 没有这个文件时，所有 404 都会冒泡到根 not-found.tsx——一个没有导航、
// 硬编码英文的裸页面。中文用户走错链接会看到断头页且回不了站。
export default async function LocaleNotFound() {
  const t = await getTranslations('pages.errors.notFound');

  return (
    <SiteShell>
      <div className="mx-auto flex w-full max-w-7xl flex-col items-center px-4 py-24 text-center sm:px-6 lg:px-8">
        <p className="text-muted-foreground font-mono text-sm">404</p>
        <h1 className="mt-3 text-2xl font-medium sm:text-3xl">{t('title')}</h1>
        <p className="text-muted-foreground mt-3 max-w-md text-sm">
          {t('description')}
        </p>
        <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
          <Button asChild>
            <Link href="/">{t('backHome')}</Link>
          </Button>
          <Button asChild variant="outline">
            <Link href="/models">{t('browseModels')}</Link>
          </Button>
        </div>
      </div>
    </SiteShell>
  );
}
