'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { localizePathForLocale } from '@/features/apipool-ui/lib/indexing';
import { X } from 'lucide-react';
import { useLocale } from 'next-intl';

import { usePathname } from '@/core/i18n/navigation';
import { envConfigs } from '@/config';
import { localeNames, locales } from '@/config/locale';
import { getLocaleDetectorCopy } from '@/shared/blocks/common/locale-detector-copy';
import { Button } from '@/shared/components/ui/button';
import { cacheGet, cacheSet } from '@/shared/lib/cache';
import { getTimestamp } from '@/shared/lib/time';

const DISMISSED_KEY = 'locale-suggestion-dismissed';
const DISMISSED_EXPIRY_DAYS = 1; // Expiry in days
const PREFERRED_LOCALE_KEY = 'locale';

/**
 * Suggests switching to the browser language. Rendered as a slim in-flow bar
 * above the header — never `position: fixed` — so it can't cover statically
 * positioned page chrome (the old fixed banner hid the auth pages' header).
 */
export function LocaleDetector() {
  if (envConfigs.locale_detect_enabled !== 'true') {
    return null;
  }

  const currentLocale = useLocale();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [showBanner, setShowBanner] = useState(false);
  const [browserLocale, setBrowserLocale] = useState<string | null>(null);
  const hasCheckedRef = useRef(false);

  const detectBrowserLocale = (): string | null => {
    if (typeof window === 'undefined') return null;

    const browserLang = navigator.language || (navigator as any).userLanguage;
    const langCode = browserLang.split('-')[0].toLowerCase();

    // Check if the detected language is in our supported locales
    if (locales.includes(langCode)) {
      return langCode;
    }

    return null;
  };

  const isDismissed = (): boolean => {
    const dismissedData = cacheGet(DISMISSED_KEY);
    if (!dismissedData) return false;

    return true;
  };

  const setDismissed = () => {
    const expiresAt = getTimestamp() + DISMISSED_EXPIRY_DAYS * 24 * 60 * 60;
    cacheSet(DISMISSED_KEY, 'true', expiresAt);
  };

  const switchToLocale = useCallback(
    (locale: string) => {
      const query = searchParams?.toString?.() ?? '';
      const href = query ? `${pathname}?${query}` : pathname;
      window.location.replace(localizePathForLocale(href, locale));
      cacheSet(PREFERRED_LOCALE_KEY, locale);
      setShowBanner(false);
    },
    [pathname, searchParams]
  );

  useEffect(() => {
    // Only run initial check once to avoid interference with manual locale switches
    if (hasCheckedRef.current) {
      return;
    }

    hasCheckedRef.current = true;

    // Get browser locale
    const detectedLocale = detectBrowserLocale();
    setBrowserLocale(detectedLocale);
    const explicitPathLocale = window.location.pathname
      .split('/')
      .filter(Boolean)[0];
    const effectiveCurrentLocale = locales.includes(explicitPathLocale)
      ? explicitPathLocale
      : currentLocale;

    // Check if user has dismissed the banner or already set a preference
    const dismissed = isDismissed();
    const preferredLocale = cacheGet(PREFERRED_LOCALE_KEY);

    // If user has previously clicked to switch locale, auto-switch to that preference
    if (
      preferredLocale &&
      preferredLocale !== effectiveCurrentLocale &&
      locales.includes(preferredLocale)
    ) {
      switchToLocale(preferredLocale);
      return;
    }

    // Show banner if:
    // 1. Browser locale is different from current locale
    // 2. User hasn't dismissed the banner (or dismissal has expired)
    // 3. Browser locale is supported
    // 4. User hasn't set a preference yet (no auto-switch, only show banner)
    if (
      detectedLocale &&
      detectedLocale !== effectiveCurrentLocale &&
      !dismissed &&
      !preferredLocale
    ) {
      setShowBanner(true);
    }
  }, [currentLocale, switchToLocale]);

  const handleSwitch = () => {
    if (browserLocale) {
      switchToLocale(browserLocale);
    }
  };

  const handleDismiss = () => {
    setDismissed();
    setShowBanner(false);
  };

  // The admin shell's fixed sidebar spans the full viewport height and
  // would cover the in-flow banner; the admin header already exposes an
  // explicit locale switcher, so skip the suggestion there.
  if (!showBanner || !browserLocale || pathname.startsWith('/admin')) {
    return null;
  }

  const targetLocaleName =
    localeNames[browserLocale as keyof typeof localeNames] || browserLocale;
  const bannerCopy = getLocaleDetectorCopy(browserLocale, targetLocaleName);

  return (
    <div className="border-border bg-muted text-muted-foreground border-b">
      <div className="mx-auto flex max-w-7xl items-center justify-between gap-4 px-4 py-2 sm:px-6 lg:px-8">
        <span className="text-xs sm:text-sm">{bannerCopy.title}</span>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            onClick={handleSwitch}
            variant="ghost"
            size="sm"
            className="text-primary h-7 px-2 text-xs font-medium"
          >
            {bannerCopy.switchTo}
          </Button>
          <button
            onClick={handleDismiss}
            className="hover:bg-border rounded p-1 transition-colors"
            aria-label={bannerCopy.close}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
}
