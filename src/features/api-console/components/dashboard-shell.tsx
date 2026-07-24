'use client';

import { ReactNode } from 'react';
import {
  BarChart3,
  FileText,
  KeyRound,
  LayoutGrid,
  SquareArrowOutUpRight,
  Wallet,
} from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Link, usePathname } from '@/core/i18n/navigation';
import { cn } from '@/shared/lib/utils';

const NAV_ITEMS = [
  { href: '/dashboard', key: 'overview', icon: LayoutGrid },
  { href: '/dashboard/api-keys', key: 'apiKeys', icon: KeyRound },
  { href: '/dashboard/billing', key: 'balance', icon: Wallet },
  { href: '/dashboard/usage', key: 'usage', icon: BarChart3 },
] as const;

function isActive(pathname: string, href: string) {
  // 概览仅在精确 /dashboard 命中；嵌套路由各自占用前缀，避免概览常驻高亮。
  if (href === '/dashboard') return pathname === '/dashboard';
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function DashboardShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const t = useTranslations('dashboard.common');

  return (
    <div className="bg-grid bg-muted/20 min-h-[calc(100vh-4rem)] border-t">
      <div className="mx-auto max-w-7xl gap-8 px-4 py-8 sm:px-6 lg:grid lg:grid-cols-[210px_minmax(0,1fr)] lg:px-8">
        <aside className="mb-6 lg:mb-0">
          <div className="lg:sticky lg:top-24">
            <div className="text-muted-foreground mb-2.5 hidden px-3 font-mono text-[11px] font-semibold tracking-[0.16em] uppercase lg:block">
              {t('nav.section')}
            </div>
            <nav
              aria-label={t('nav.ariaLabel')}
              className="flex gap-1.5 overflow-x-auto pb-1 lg:flex-col lg:overflow-visible lg:pb-0"
            >
              {NAV_ITEMS.map((item) => {
                const active = isActive(pathname, item.href);
                const Icon = item.icon;
                return (
                  <Link
                    key={item.href}
                    href={item.href}
                    aria-current={active ? 'page' : undefined}
                    className={cn(
                      'inline-flex shrink-0 items-center gap-2.5 rounded-lg border px-3 py-2.5 text-sm whitespace-nowrap transition-colors',
                      active
                        ? 'border-primary/25 bg-primary/10 text-primary font-medium'
                        : 'text-muted-foreground hover:bg-muted hover:text-foreground border-transparent'
                    )}
                  >
                    <Icon className="size-4 shrink-0" />
                    {t(`nav.${item.key}`)}
                  </Link>
                );
              })}
              <Link
                href="/docs"
                className="text-muted-foreground hover:border-primary/30 hover:text-primary mt-0 inline-flex shrink-0 items-center gap-2.5 rounded-lg border border-dashed px-3 py-2.5 text-sm whitespace-nowrap transition-colors lg:mt-2"
              >
                <FileText className="size-4 shrink-0" />
                {t('nav.docs')}
                <SquareArrowOutUpRight className="ml-auto hidden size-3.5 lg:block" />
              </Link>
            </nav>
          </div>
        </aside>
        <main className="min-w-0">{children}</main>
      </div>
    </div>
  );
}
