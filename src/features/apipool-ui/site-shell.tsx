import { ReactNode } from 'react';
import { ArrowRight, Mail } from 'lucide-react';
import { getTranslations } from 'next-intl/server';

import { APIPOOL_CONFIG } from '@/config/apipool';
import { Link } from '@/core/i18n/navigation';
import { LocaleSelector, ThemeToggler } from '@/shared/blocks/common';
import { Button } from '@/shared/components/ui/button';
import { cn } from '@/shared/lib/utils';

import { HeaderAuthCluster } from './header-auth-cluster';
import { MobileNav } from './mobile-nav';

// 品牌标记：品牌绿圆角方块 + 白色等宽 “/”，带柔和绿光。
function BrandMark() {
  return (
    <span
      aria-hidden
      className="bg-primary text-primary-foreground shadow-primary/40 inline-flex size-7 shrink-0 items-center justify-center rounded-lg font-mono text-[15px] font-bold shadow-lg"
    >
      /
    </span>
  );
}

export async function SiteShell({ children }: { children: ReactNode }) {
  const t = await getTranslations('site');
  const nav = [
    { href: '/models', label: t('nav.models') },
    { href: '/docs', label: t('nav.docs') },
  ];

  return (
    <div className="bg-background text-foreground min-h-screen">
      <header className="border-border bg-background/95 sticky top-0 z-40 border-b backdrop-blur-sm">
        <div className="mx-auto flex h-14 w-full max-w-7xl items-center gap-2 px-4 sm:h-16 sm:gap-6 sm:px-6 lg:px-8">
          <MobileNav
            items={nav}
            openLabel={t('mobile.openMenu')}
            menuTitle={t('mobile.menu')}
            consoleItem={{ href: '/dashboard', label: t('nav.console') }}
            themeLabel={t('mobile.theme')}
            languageLabel={t('mobile.language')}
          />
          <Link
            href="/"
            className="inline-flex shrink-0 items-center gap-2 text-base font-semibold tracking-tight"
          >
            <BrandMark />
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
            {/* Language gets a standalone header icon (like APIMart);
                theme stays in the avatar menu / footer. On <lg the
                drawer keeps its own language entry. */}
            <LocaleSelector
              type="icon"
              label={t('mobile.language')}
              className="text-muted-foreground hover:text-foreground hidden size-9 p-2 lg:inline-flex"
            />
            <HeaderAuthCluster
              consoleLabel={t('nav.console')}
              getStartedLabel={t('nav.getStarted')}
              userNav={{
                items: [
                  {
                    title: t('userMenu.apiKeys'),
                    url: '/dashboard/api-keys',
                    icon: 'KeyRound',
                  },
                  {
                    title: t('userMenu.balance'),
                    url: '/dashboard/billing',
                    icon: 'Wallet',
                  },
                  {
                    title: t('userMenu.usage'),
                    url: '/dashboard/usage',
                    icon: 'Activity',
                  },
                ],
                show_name: true,
                show_preferences: true,
                show_sign_out: true,
              }}
            />
          </div>
        </div>
      </header>
      <main>{children}</main>
      <footer className="border-border border-t">
        <div className="mx-auto grid max-w-7xl gap-10 px-4 py-12 text-sm sm:px-6 md:grid-cols-[1.5fr_repeat(3,0.7fr)] lg:px-8">
          <div className="space-y-4">
            <div className="flex items-center gap-2 text-base font-semibold tracking-tight">
              <BrandMark />
              <span>{APIPOOL_CONFIG.brandName}</span>
            </div>
            <p className="text-muted-foreground max-w-sm leading-6">
              {t('footer.description')}
            </p>
            <div className="text-muted-foreground flex items-center gap-3">
              <a
                href={`mailto:${APIPOOL_CONFIG.supportEmail}`}
                aria-label={t('footer.emailSupport')}
                className="hover:text-foreground inline-flex items-center gap-2 transition-colors"
              >
                <Mail className="size-4" />
                <span className="text-xs">{APIPOOL_CONFIG.supportEmail}</span>
              </a>
            </div>
          </div>
          <div className="space-y-3">
            <div className="font-medium">{t('footer.product')}</div>
            <div className="text-muted-foreground grid gap-2">
              <Link
                href="/models"
                className="hover:text-foreground transition-colors"
              >
                {t('footer.models')}
              </Link>
              <Link
                href="/docs"
                className="hover:text-foreground transition-colors"
              >
                {t('footer.apiDocs')}
              </Link>
              <Link
                href="/dashboard"
                className="hover:text-foreground transition-colors"
              >
                {t('footer.console')}
              </Link>
            </div>
          </div>
          <div className="space-y-3">
            <div className="font-medium">{t('footer.legal')}</div>
            <div className="text-muted-foreground grid gap-2">
              <Link
                href="/privacy-policy"
                className="hover:text-foreground transition-colors"
              >
                {t('footer.privacy')}
              </Link>
              <Link
                href="/terms-of-service"
                className="hover:text-foreground transition-colors"
              >
                {t('footer.terms')}
              </Link>
            </div>
          </div>
          <div className="space-y-3">
            <div className="font-medium">{t('footer.company')}</div>
            <div className="text-muted-foreground grid gap-2">
              <a
                href={`mailto:${APIPOOL_CONFIG.supportEmail}`}
                className="hover:text-foreground transition-colors"
              >
                {t('footer.contact')}
              </a>
            </div>
          </div>
        </div>
        <div className="border-border text-muted-foreground mx-auto flex max-w-7xl flex-col gap-2 border-t px-4 py-6 text-xs sm:px-6 md:flex-row md:items-center md:justify-between lg:px-8">
          <span>
            {t('footer.copyright', { brand: APIPOOL_CONFIG.brandName })}
          </span>
          <div className="flex items-center gap-2">
            <LocaleSelector type="button" />
            <ThemeToggler type="toggle" className="h-8" />
          </div>
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
