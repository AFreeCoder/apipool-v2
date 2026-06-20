import { ReactNode } from 'react';

import { Link } from '@/core/i18n/navigation';
import { getApipoolCopy } from '@/features/apipool-ui/copy';

export function DashboardShell({
  children,
  locale,
}: {
  children: ReactNode;
  locale: string;
}) {
  const copy = getApipoolCopy(locale).consoleNav;
  const items = [
    { href: '/dashboard', label: copy.overview },
    { href: '/dashboard/api-keys', label: copy.apiKeys },
    { href: '/dashboard/billing', label: copy.balance },
    { href: '/dashboard/usage', label: copy.usage },
  ];

  return (
    <div className="bg-muted/30 border-t">
      <div className="bg-background border-b">
        <nav
          aria-label="console-navigation"
          className="mx-auto flex max-w-7xl items-center gap-1 overflow-x-auto px-4 sm:px-6 lg:px-8"
        >
          {items.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="text-muted-foreground hover:text-foreground -mb-px shrink-0 border-b-2 border-transparent px-3 py-3 text-sm whitespace-nowrap transition-colors"
            >
              {item.label}
            </Link>
          ))}
        </nav>
      </div>
      <section className="mx-auto min-h-[calc(100vh-8rem)] max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
        {children}
      </section>
    </div>
  );
}
