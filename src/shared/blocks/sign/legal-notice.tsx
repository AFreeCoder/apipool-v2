'use client';

import { useTranslations } from 'next-intl';

import { APIPOOL_PUBLIC_CONFIG } from '@/config/apipool/public';
import { Link } from '@/core/i18n/navigation';

export function LegalNotice() {
  const t = useTranslations('common.sign');

  return (
    <div className="grid gap-3">
      <p className="text-muted-foreground text-center text-xs">
        {t.rich('agree_terms', {
          terms: (chunks) => (
            <Link
              href="/terms-of-service"
              target="_blank"
              className="hover:text-foreground underline underline-offset-2"
            >
              {chunks}
            </Link>
          ),
          privacy: (chunks) => (
            <Link
              href="/privacy-policy"
              target="_blank"
              className="hover:text-foreground underline underline-offset-2"
            >
              {chunks}
            </Link>
          ),
        })}
      </p>
      <div className="bg-muted text-muted-foreground rounded-md border px-3 py-2 text-xs leading-relaxed">
        <span className="text-foreground font-medium">
          {t('region_notice_title')}:{' '}
        </span>
        {t('region_notice', {
          brand: APIPOOL_PUBLIC_CONFIG.brandName,
          email: APIPOOL_PUBLIC_CONFIG.supportEmail,
        })}
      </div>
    </div>
  );
}
