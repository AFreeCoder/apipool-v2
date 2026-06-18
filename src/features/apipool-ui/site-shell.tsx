import { ReactNode } from 'react';
import Image from 'next/image';
import { ArrowRight, Mail } from 'lucide-react';

import { Link } from '@/core/i18n/navigation';
import { APIPOOL_CONFIG } from '@/config/apipool';
import { SignUser } from '@/shared/blocks/sign/sign-user';
import { Button } from '@/shared/components/ui/button';
import { cn } from '@/shared/lib/utils';

const nav = [
  { href: '/', label: 'Home' },
  { href: '/models', label: 'Models & Pricing' },
  { href: '/docs', label: 'Docs' },
  { href: '/dashboard', label: 'Console' },
];

const mobileNav = nav;

export function SiteShell({ children }: { children: ReactNode }) {
  return (
    <div className="bg-background text-foreground min-h-screen">
      <header className="border-border bg-background/95 sticky top-0 z-40 border-b backdrop-blur-sm">
        <div className="mx-auto flex h-14 w-full max-w-7xl items-center gap-6 px-4 sm:h-16 sm:px-6 lg:px-8">
          <Link
            href="/"
            className="inline-flex shrink-0 items-center gap-2 text-base font-semibold"
          >
            <span className="relative size-6 overflow-hidden rounded-md">
              <Image
                src="/logo.png"
                alt={APIPOOL_CONFIG.brandName}
                width={24}
                height={24}
                className="object-contain"
                priority
              />
            </span>
            <span>{APIPOOL_CONFIG.brandName}</span>
          </Link>
          <nav className="hidden items-center gap-1 text-sm lg:flex">
            {nav.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="text-muted-foreground hover:text-foreground rounded-md px-3 py-2 transition-colors"
              >
                {item.label}
              </Link>
            ))}
          </nav>
          <div className="ml-auto flex items-center justify-end gap-2">
            <SignUser
              signButtonSize="sm"
              userNav={{ items: [], show_name: true, show_sign_out: true }}
            />
            <Button asChild size="sm" variant="outline">
              <Link href="/dashboard">
                Console
                <ArrowRight className="size-4" />
              </Link>
            </Button>
          </div>
        </div>
        <nav
          aria-label="main-navigation-mobile"
          className="border-border flex gap-1 overflow-x-auto border-t px-4 py-2 lg:hidden"
        >
          {mobileNav.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="text-muted-foreground hover:text-foreground shrink-0 rounded-md px-3 py-3 text-sm whitespace-nowrap"
            >
              {item.label}
            </Link>
          ))}
          <span className="w-2 shrink-0" />
        </nav>
      </header>
      <main>{children}</main>
      <footer className="border-border border-t">
        <div className="mx-auto grid max-w-7xl gap-10 px-4 py-12 text-sm sm:px-6 md:grid-cols-[1.6fr_0.7fr_0.7fr] lg:px-8">
          <div className="space-y-4">
            <div className="flex items-center gap-2 text-base font-semibold">
              <Image
                src="/logo.png"
                alt={APIPOOL_CONFIG.brandName}
                width={22}
                height={22}
                className="object-contain"
              />
              <span>{APIPOOL_CONFIG.brandName}</span>
            </div>
            <p className="text-muted-foreground max-w-sm leading-6">
              One API endpoint for frontier models. Transparent pricing, real
              usage data, no subscriptions.
            </p>
            <div className="text-muted-foreground flex items-center gap-3">
              <a
                href={`mailto:${APIPOOL_CONFIG.supportEmail}`}
                aria-label="Email support"
                className="hover:text-foreground inline-flex items-center gap-2 transition-colors"
              >
                <Mail className="size-4" />
                <span className="text-xs">{APIPOOL_CONFIG.supportEmail}</span>
              </a>
            </div>
          </div>
          <div className="space-y-3">
            <div className="font-medium">Product</div>
            <div className="text-muted-foreground grid gap-2">
              <Link
                href="/models"
                className="hover:text-foreground transition-colors"
              >
                Models & Pricing
              </Link>
              <Link
                href="/docs"
                className="hover:text-foreground transition-colors"
              >
                API Docs
              </Link>
              <Link
                href="/dashboard"
                className="hover:text-foreground transition-colors"
              >
                Console
              </Link>
            </div>
          </div>
          <div className="space-y-3">
            <div className="font-medium">Legal</div>
            <div className="text-muted-foreground grid gap-2">
              <Link
                href="/privacy-policy"
                className="hover:text-foreground transition-colors"
              >
                Privacy Policy
              </Link>
              <Link
                href="/terms-of-service"
                className="hover:text-foreground transition-colors"
              >
                Terms of Service
              </Link>
            </div>
          </div>
        </div>
        <div className="border-border text-muted-foreground mx-auto flex max-w-7xl flex-col gap-2 border-t px-4 py-6 text-xs sm:px-6 md:flex-row md:items-center md:justify-between lg:px-8">
          <span>© 2026 {APIPOOL_CONFIG.brandName}. All rights reserved.</span>
          <span className="font-mono text-xs tracking-widest uppercase">
            built for developers
          </span>
        </div>
      </footer>
    </div>
  );
}

export function CtaButton({
  href,
  children,
  className,
}: {
  href: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Button asChild className={cn('h-10 rounded-md px-5', className)}>
      <Link href={href}>
        {children}
        <ArrowRight className="size-4" />
      </Link>
    </Button>
  );
}
