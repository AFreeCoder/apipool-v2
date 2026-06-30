import { ReactNode } from 'react';
import { getTranslations, setRequestLocale } from 'next-intl/server';

import { requireAdminAccess } from '@/core/rbac/permission';
import { DashboardLayout } from '@/shared/blocks/dashboard/layout';
import { getAllConfigs } from '@/shared/models/config';
import { Sidebar as SidebarType } from '@/shared/types/blocks/dashboard';

/**
 * Admin layout to manage datas
 */
export default async function AdminLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);

  // Check if user has admin access permission
  await requireAdminAccess({
    redirectUrl: `/no-permission`,
    locale: locale || '',
  });

  const t = await getTranslations('admin');

  const sidebar: SidebarType = t.raw('sidebar');

  const configs = await getAllConfigs();
  const brand = sidebar.header?.brand;
  if (configs.app_name && brand) {
    brand.title = configs.app_name;
    if (brand.logo) {
      brand.logo.alt = configs.app_name;
    }
  }
  if (configs.app_description) {
    sidebar.header!.brand!.description = configs.app_description;
  }
  if (brand) {
    if (configs.app_logo) {
      brand.logo = {
        ...brand.logo,
        src: configs.app_logo,
        alt: brand.logo?.alt || brand.title || configs.app_name,
      };
    } else {
      delete brand.logo;
    }
  }
  if (configs.version) {
    sidebar.header!.version = configs.version;
  }

  return <DashboardLayout sidebar={sidebar}>{children}</DashboardLayout>;
}
