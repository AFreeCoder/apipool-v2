import { ReactNode } from 'react';
import Image from 'next/image';
import {
  ArrowRight,
  BookOpen,
  ChevronDown,
  Gauge,
  Github,
  KeyRound,
  Mail,
} from 'lucide-react';

import { Link } from '@/core/i18n/navigation';
import { APIPOOL_CONFIG } from '@/config/apipool';
import { Button } from '@/shared/components/ui/button';
import { cn } from '@/shared/lib/utils';

const nav = [
  { href: '/models', label: 'Model Market' },
  { href: '/docs', label: 'API Docs' },
  { href: '/pricing', label: 'Pricing' },
];

const mobileNav = [
  ...nav,
  { href: '/updates', label: 'API Updates' },
  { href: '/blog', label: 'Blog' },
  { href: '/dashboard', label: 'Dashboard' },
];

export function SiteShell({ children }: { children: ReactNode }) {
  return (
    <div className="bg-background text-foreground min-h-screen">
      <header className="border-border/80 bg-background/95 sticky top-0 z-40 border-b backdrop-blur-sm">
        <div className="mx-auto flex h-14 w-full max-w-7xl items-center gap-4 px-4 sm:h-16 sm:px-6 lg:px-8">
          <Link
            href="/"
            className="inline-flex shrink-0 items-center gap-2 text-lg font-bold"
          >
            <span className="relative size-7 overflow-hidden rounded-md">
              <Image
                src="/logo.png"
                alt={APIPOOL_CONFIG.brandName}
                width={28}
                height={28}
                className="object-contain"
                priority
              />
            </span>
            <span>{APIPOOL_CONFIG.brandName}</span>
          </Link>
          <nav className="hidden min-w-0 flex-1 items-center justify-center gap-1 text-sm lg:flex">
            {nav.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="text-muted-foreground hover:bg-muted hover:text-foreground rounded-md px-3 py-2 transition-colors"
              >
                {item.label}
              </Link>
            ))}
            <button
              type="button"
              className="text-muted-foreground hover:bg-muted hover:text-foreground inline-flex items-center gap-1 rounded-md px-3 py-2 transition-colors"
            >
              Resources
              <ChevronDown className="size-3" />
            </button>
          </nav>
          <div className="ml-auto flex min-w-32 items-center justify-end gap-2 sm:min-w-48 lg:min-w-[15rem]">
            <Button
              asChild
              variant="ghost"
              size="sm"
              className="hidden sm:inline-flex"
            >
              <Link href="/sign-in">Log in</Link>
            </Button>
            <Button
              asChild
              size="sm"
              className="bg-primary hover:bg-primary/90 px-3"
            >
              <Link href="/dashboard/api-keys">
                <KeyRound className="size-4" />
                Sign Up
              </Link>
            </Button>
          </div>
        </div>
        <nav
          aria-label="main-navigation-mobile"
          className="border-border/70 flex gap-1 overflow-x-auto border-t px-4 py-2 lg:hidden"
        >
          {mobileNav.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className="text-muted-foreground hover:text-foreground shrink-0 rounded-md px-3 py-1.5 text-sm whitespace-nowrap"
            >
              {item.label}
            </Link>
          ))}
          <span className="w-2 shrink-0" />
        </nav>
      </header>
      <main>{children}</main>
      <footer className="border-border/80 border-t">
        <div className="mx-auto grid max-w-7xl gap-10 px-4 py-12 text-sm sm:px-6 md:grid-cols-[1.4fr_0.8fr_0.8fr_0.8fr] lg:px-8">
          <div className="space-y-4">
            <div className="flex items-center gap-2 text-lg font-bold">
              <Image
                src="/logo.png"
                alt={APIPOOL_CONFIG.brandName}
                width={26}
                height={26}
                className="object-contain"
              />
              <span>{APIPOOL_CONFIG.brandName}</span>
            </div>
            <p className="text-muted-foreground max-w-sm leading-6">
              Official AI API hub with transparent pricing. Manage keys, quota,
              and usage in one place.
            </p>
            <code className="bg-muted block w-fit rounded-md border px-3 py-2 font-mono text-xs">
              {APIPOOL_CONFIG.apiBaseUrl}
            </code>
            <div className="text-muted-foreground flex items-center gap-3">
              <a
                href={`mailto:${APIPOOL_CONFIG.supportEmail}`}
                className="hover:text-foreground transition"
              >
                <Mail className="size-4" />
              </a>
              <a
                href="https://github.com"
                className="hover:text-foreground transition"
              >
                <Github className="size-4" />
              </a>
            </div>
          </div>
          <div className="space-y-3">
            <div className="font-medium">Product</div>
            <div className="text-muted-foreground grid gap-2">
              <Link href="/models">Model Market</Link>
              <Link href="/docs">API Docs</Link>
              <Link href="/pricing">Pricing</Link>
              <Link href="/dashboard">Dashboard</Link>
            </div>
          </div>
          <div className="space-y-3">
            <div className="font-medium">Workflow</div>
            <div className="text-muted-foreground grid gap-2">
              <span className="inline-flex items-center gap-2">
                <KeyRound className="size-4" />
                Create Key
              </span>
              <span className="inline-flex items-center gap-2">
                <Gauge className="size-4" />
                Check usage
              </span>
              <span className="inline-flex items-center gap-2">
                <BookOpen className="size-4" />
                Read docs
              </span>
            </div>
          </div>
          <div className="space-y-3">
            <div className="font-medium">Resources</div>
            <div className="text-muted-foreground grid gap-2">
              <Link href="/updates">API Updates</Link>
              <Link href="/blog">Blog</Link>
              <Link href="/privacy-policy">Privacy Policy</Link>
              <Link href="/terms-of-service">Terms of Service</Link>
            </div>
          </div>
        </div>
        <div className="border-border/70 text-muted-foreground mx-auto flex max-w-7xl flex-col gap-2 border-t px-4 py-6 text-xs sm:px-6 md:flex-row md:items-center md:justify-between lg:px-8">
          <span>© 2026 {APIPOOL_CONFIG.brandName}. All rights reserved.</span>
          <span className="font-semibold tracking-normal uppercase">
            {APIPOOL_CONFIG.brandName}
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
