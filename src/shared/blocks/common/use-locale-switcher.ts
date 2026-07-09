'use client';

import { useSearchParams } from 'next/navigation';
import { useLocale } from 'next-intl';

import { usePathname } from '@/core/i18n/navigation';
import { localizePathForLocale } from '@/features/apipool-ui/lib/indexing';
import { cacheSet } from '@/shared/lib/cache';

/**
 * Shared locale-switching behavior for every language control (header
 * selector, avatar menu, mobile drawer). Persists the preference so the
 * locale detector stops suggesting a switch afterwards.
 */
export function useLocaleSwitcher() {
  const currentLocale = useLocale();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const switchLocale = (value: string) => {
    if (value === currentLocale) {
      return;
    }
    cacheSet('locale', value);
    const query = searchParams?.toString?.() ?? '';
    const href = query ? `${pathname}?${query}` : pathname;
    window.location.assign(localizePathForLocale(href, value));
  };

  return { currentLocale, switchLocale };
}
