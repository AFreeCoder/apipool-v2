import { ReactNode } from 'react';
import { headers } from 'next/headers';

import { defaultLocale } from '@/config/locale';
import { redirect } from '@/core/i18n/navigation';
import { DashboardShell } from '@/features/api-console/components/dashboard-shell';
import { safeInternalPath } from '@/shared/lib/safe-path';
import { getUserInfo } from '@/shared/models/user';

// 中间件（proxy.ts）把当前路径写进 x-pathname。据此把用户送回他本来要去的
// 页面，而不是首页——首页 hero 与顶栏 Console 都指向 /dashboard，未登录用户
// 登录成功后落回首页，会让核心转化路径断在最后一步。
async function currentDashboardPath(locale: string) {
  const pathname = (await headers()).get('x-pathname') || '';
  const safe = safeInternalPath(pathname);

  const stripped =
    locale !== defaultLocale && safe.startsWith(`/${locale}/`)
      ? safe.slice(locale.length + 1)
      : safe;

  // 只回跳到控制台内部；其余一律收敛到 /dashboard
  return stripped.startsWith('/dashboard') ? stripped : '/dashboard';
}

export default async function DashboardLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const user = await getUserInfo();
  if (!user) {
    const callbackUrl = await currentDashboardPath(locale);
    redirect({
      href: `/sign-in?callbackUrl=${encodeURIComponent(callbackUrl)}`,
      locale,
    });
  }

  return <DashboardShell>{children}</DashboardShell>;
}
