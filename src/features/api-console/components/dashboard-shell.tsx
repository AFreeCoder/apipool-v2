import { ReactNode } from 'react';
import { BarChart3, CreditCard, KeyRound, LayoutDashboard } from 'lucide-react';

import { Link } from '@/core/i18n/navigation';

const items = [
  { href: '/dashboard', label: 'Overview', icon: LayoutDashboard },
  { href: '/dashboard/api-keys', label: 'API Keys', icon: KeyRound },
  { href: '/dashboard/usage', label: 'Usage', icon: BarChart3 },
  { href: '/dashboard/billing', label: 'Billing', icon: CreditCard },
];

export function DashboardShell({ children }: { children: ReactNode }) {
  return (
    <div className="border-t bg-muted/20">
      <div className="mx-auto grid min-h-[calc(100vh-4rem)] max-w-7xl gap-6 px-4 py-6 sm:px-6 lg:grid-cols-[220px_1fr] lg:px-8">
        <aside className="h-fit rounded-lg border bg-background p-2">
          <nav className="grid gap-1">
            {items.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="flex items-center gap-2 rounded-md px-3 py-2 text-sm text-muted-foreground transition hover:bg-muted hover:text-foreground"
              >
                <item.icon className="size-4" />
                {item.label}
              </Link>
            ))}
          </nav>
        </aside>
        <section>{children}</section>
      </div>
    </div>
  );
}
