'use client';

import { ReactNode } from 'react';

import { Link, usePathname } from '@/core/i18n/navigation';
import { cn } from '@/shared/lib/utils';

const items = [
  { href: '/dashboard', label: 'Overview' },
  { href: '/dashboard/api-keys', label: 'API Keys' },
  { href: '/dashboard/billing', label: 'Balance' },
  { href: '/dashboard/usage', label: 'Usage' },
];

function isActive(pathname: string, href: string) {
  // Overview is only active on the exact /dashboard route; nested routes own
  // the prefix so Overview does not stay highlighted everywhere.
  if (href === '/dashboard') return pathname === '/dashboard';
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function DashboardShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();

  return (
    <div className="bg-muted/30 border-t">
      <div className="bg-background border-b">
        <nav
          aria-label="console-navigation"
          className="mx-auto flex max-w-7xl items-center gap-1 overflow-x-auto px-4 sm:px-6 lg:px-8"
        >
          {items.map((item) => {
            const active = isActive(pathname, item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  '-mb-px shrink-0 border-b-2 px-3 py-3 text-sm whitespace-nowrap transition-colors',
                  active
                    ? 'border-primary text-foreground font-medium'
                    : 'text-muted-foreground hover:text-foreground border-transparent'
                )}
              >
                {item.label}
              </Link>
            );
          })}
        </nav>
      </div>
      <section className="mx-auto min-h-[calc(100vh-8rem)] max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
        {children}
      </section>
    </div>
  );
}
