'use client';

import { useEffect } from 'react';
import { useTranslations } from 'next-intl';

import { Link } from '@/core/i18n/navigation';
import { Button } from '@/shared/components/ui/button';

// 没有这个文件时，admin 页面的未捕获异常（DB 短暂不可用、New API 桥接
// 超时等）会落到 Next 默认英文错误页并丢掉后台壳层；这里保住侧栏，给
// 管理员一个重试/回用户列表的出口。
export default function AdminError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const t = useTranslations('pages.errors.error');

  useEffect(() => {
    console.error('admin route error', error);
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
          <Link href="/admin/users">{t('backHome')}</Link>
        </Button>
      </div>
    </div>
  );
}
