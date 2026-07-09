'use client';

import { useEffect } from 'react';
import { useTranslations } from 'next-intl';

import { Link } from '@/core/i18n/navigation';
import { Button } from '@/shared/components/ui/button';

// 没有这个文件时，任何未被 portal.ts 捕获的异常（如 catalog 查询失败）都会
// 落到 Next 默认的英文 "Application error" 页，中文用户读不懂也回不了站。
export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const t = useTranslations('pages.errors.error');

  useEffect(() => {
    console.error('dashboard route error', error);
  }, [error]);

  return (
    <div className="flex flex-col items-center px-4 py-20 text-center">
      <h1 className="text-xl font-medium sm:text-2xl">{t('title')}</h1>
      <p className="text-muted-foreground mt-3 max-w-md text-sm">
        {t('description')}
      </p>
      {error.digest ? (
        <p className="text-muted-foreground mt-2 font-mono text-xs">
          {error.digest}
        </p>
      ) : null}
      <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
        <Button onClick={reset}>{t('retry')}</Button>
        <Button asChild variant="outline">
          <Link href="/">{t('backHome')}</Link>
        </Button>
      </div>
    </div>
  );
}
