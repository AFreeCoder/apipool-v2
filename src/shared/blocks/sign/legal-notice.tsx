'use client';

import { useTranslations } from 'next-intl';

import { APIPOOL_PUBLIC_CONFIG } from '@/config/apipool/public';
import { Link } from '@/core/i18n/navigation';

export function LegalNotice() {
  const t = useTranslations('common.sign');

  return (
    <div className="grid gap-3">
      <p className="text-center text-xs text-muted-foreground">
        {t.rich('agree_terms', {
          terms: (chunks) => (
            <Link
              href="/terms-of-service"
              target="_blank"
              className="underline underline-offset-2 hover:text-foreground"
            >
              {chunks}
            </Link>
          ),
          privacy: (chunks) => (
            <Link
              href="/privacy-policy"
              target="_blank"
              className="underline underline-offset-2 hover:text-foreground"
            >
              {chunks}
            </Link>
          ),
        })}
      </p>
      <div className="rounded-md border border-amber-600/30 bg-amber-500/10 px-3 py-2 text-xs leading-relaxed text-amber-700 dark:text-amber-400">
        <span className="font-medium">{t('region_notice_title')}: </span>
        {t('region_notice', {
          brand: APIPOOL_PUBLIC_CONFIG.brandName,
          email: APIPOOL_PUBLIC_CONFIG.supportEmail,
        })}
      </div>
    </div>
  );
}
