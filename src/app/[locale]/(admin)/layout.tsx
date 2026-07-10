import { ReactNode } from 'react';
import { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';

import { requireAdminAccess } from '@/core/rbac/permission';
import { DashboardLayout } from '@/shared/blocks/dashboard/layout';
import { getAllConfigs } from '@/shared/models/config';
import { Sidebar as SidebarType } from '@/shared/types/blocks/dashboard';

/**
 * Give every admin tab a distinguishable title (`Admin · {app_name}`) so
 * operators working across several tabs can tell them apart.
 */
export async function generateMetadata(): Promise<Metadata> {
  const configs = await getAllConfigs();
  const appName = configs.app_name || 'APIPool';

  return {
    title: `Admin · ${appName}`,
  };
}

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

  // next-intl 的消息对象是模块级缓存、跨请求共享——直接改 t.raw('sidebar')
  // 会污染其他请求。先深拷贝再改。
  const sidebar: SidebarType = structuredClone(t.raw('sidebar')) as SidebarType;

  const configs = await getAllConfigs();
  const brand = sidebar.header?.brand;
  if (configs.app_name && brand) {
    brand.title = configs.app_name;
    if (brand.logo) {
      brand.logo.alt = configs.app_name;
    }
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
