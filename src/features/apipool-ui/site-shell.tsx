import { ReactNode } from 'react';
import Image from 'next/image';
import { ArrowRight, Mail } from 'lucide-react';
import { getLocale } from 'next-intl/server';

import { Link } from '@/core/i18n/navigation';
import { APIPOOL_CONFIG } from '@/config/apipool';
import { AppLocale, normalizeLocale } from '@/config/locale';
import { LocaleSelector } from '@/shared/blocks/common/locale-selector';
import { SignUser } from '@/shared/blocks/sign/sign-user';
import { Button } from '@/shared/components/ui/button';
import { cn } from '@/shared/lib/utils';

type ShellLocale = AppLocale;

const shellCopy: Record<ShellLocale, {
  nav: { href: string; label: string }[];
  console: string;
  footerDescription: string;
  emailLabel: string;
  product: string;
  models: string;
  docs: string;
  legal: string;
  privacy: string;
  terms: string;
  rights: string;
  built: string;
}> = {
  'zh-CN': {
    nav: [
      { href: '/', label: '首页' },
      { href: '/models', label: '模型与价格' },
      { href: '/docs', label: '文档' },
      { href: '/dashboard', label: '控制台' },
    ],
    console: '控制台',
    footerDescription:
      '一个面向主流模型的统一 API 端点，提供透明价格、真实用量数据与按量付费体验。',
    emailLabel: '邮件支持',
    product: '产品',
    models: '模型与价格',
    docs: 'API 文档',
    legal: '法律',
    privacy: '隐私政策',
    terms: '用户协议',
    rights: '保留所有权利。',
    built: '为开发者构建',
  },
  'zh-TW': {
    nav: [
      { href: '/', label: '首頁' },
      { href: '/models', label: '模型與價格' },
      { href: '/docs', label: '文件' },
      { href: '/dashboard', label: '控制台' },
    ],
    console: '控制台',
    footerDescription:
      '一個面向主流模型的統一 API 端點，提供透明價格、真實用量資料與按量付費體驗。',
    emailLabel: '郵件支援',
    product: '產品',
    models: '模型與價格',
    docs: 'API 文件',
    legal: '法律',
    privacy: '隱私政策',
    terms: '使用者協議',
    rights: '保留所有權利。',
    built: '為開發者構建',
  },
  en: {
    nav: [
      { href: '/', label: 'Home' },
      { href: '/models', label: 'Models & Pricing' },
      { href: '/docs', label: 'Docs' },
      { href: '/dashboard', label: 'Console' },
    ],
    console: 'Console',
    footerDescription:
      'One API endpoint for frontier models. Transparent pricing, real usage data, no subscriptions.',
    emailLabel: 'Email support',
    product: 'Product',
    models: 'Models & Pricing',
    docs: 'API Docs',
    legal: 'Legal',
    privacy: 'Privacy Policy',
    terms: 'Terms of Service',
    rights: 'All rights reserved.',
    built: 'built for developers',
  },
};

export async function SiteShell({ children }: { children: ReactNode }) {
  const locale = normalizeLocale(await getLocale());
  const copy = shellCopy[locale];

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
            {copy.nav.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="text-muted-foreground hover:text-foreground rounded-md px-3 py-2 transition-colors"
              >
                {item.label}
              </Link>
            ))}
          </nav>
          <div className="scrollbar-hide ml-auto flex items-center justify-end gap-2 overflow-x-auto whitespace-nowrap">
            <SignUser
              signButtonSize="sm"
              userNav={{ items: [], show_name: true, show_sign_out: true }}
            />
            <LocaleSelector type="button" />
            <Button asChild size="sm" variant="outline">
              <Link href="/dashboard">
                {copy.console}
                <ArrowRight className="size-4" />
              </Link>
            </Button>
          </div>
        </div>
        <nav
          aria-label="main-navigation-mobile"
          className="border-border flex gap-1 overflow-x-auto border-t px-4 py-2 lg:hidden"
        >
          {copy.nav.map((item) => (
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
              {copy.footerDescription}
            </p>
            <div className="text-muted-foreground flex items-center gap-3">
              <a
                href={`mailto:${APIPOOL_CONFIG.supportEmail}`}
                aria-label={copy.emailLabel}
                className="hover:text-foreground inline-flex items-center gap-2 transition-colors"
              >
                <Mail className="size-4" />
                <span className="text-xs">{APIPOOL_CONFIG.supportEmail}</span>
              </a>
            </div>
          </div>
          <div className="space-y-3">
            <div className="font-medium">{copy.product}</div>
            <div className="text-muted-foreground grid gap-2">
              <Link
                href="/models"
                className="hover:text-foreground transition-colors"
              >
                {copy.models}
              </Link>
              <Link
                href="/docs"
                className="hover:text-foreground transition-colors"
              >
                {copy.docs}
              </Link>
              <Link
                href="/dashboard"
                className="hover:text-foreground transition-colors"
              >
                {copy.console}
              </Link>
            </div>
          </div>
          <div className="space-y-3">
            <div className="font-medium">{copy.legal}</div>
            <div className="text-muted-foreground grid gap-2">
              <Link
                href="/privacy-policy"
                className="hover:text-foreground transition-colors"
              >
                {copy.privacy}
              </Link>
              <Link
                href="/terms-of-service"
                className="hover:text-foreground transition-colors"
              >
                {copy.terms}
              </Link>
            </div>
          </div>
        </div>
        <div className="border-border text-muted-foreground mx-auto flex max-w-7xl flex-col gap-2 border-t px-4 py-6 text-xs sm:px-6 md:flex-row md:items-center md:justify-between lg:px-8">
          <span>
            © 2026 {APIPOOL_CONFIG.brandName}. {copy.rights}
          </span>
          <span className="font-mono text-xs tracking-widest uppercase">
            {copy.built}
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
