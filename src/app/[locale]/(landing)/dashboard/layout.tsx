import { ReactNode } from 'react';

import { redirect } from '@/core/i18n/navigation';
import { DashboardShell } from '@/features/api-console/components/dashboard-shell';
import { getUserInfo } from '@/shared/models/user';

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
    redirect({ href: '/sign-in', locale });
  }

  return <DashboardShell>{children}</DashboardShell>;
}
