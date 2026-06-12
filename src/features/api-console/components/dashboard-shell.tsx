import { ReactNode } from 'react';

import { Link } from '@/core/i18n/navigation';

const items = [
  { href: '/dashboard', label: 'Overview' },
  { href: '/dashboard/api-keys', label: 'API Keys' },
  { href: '/dashboard/billing', label: 'Balance' },
  { href: '/dashboard/usage', label: 'Usage' },
];

export function DashboardShell({ children }: { children: ReactNode }) {
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
