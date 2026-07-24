import { getTranslations } from 'next-intl/server';

import { Link } from '@/core/i18n/navigation';
import { checkoutEnabled } from '@/features/gateway/lib/config';

import { BalanceWarningView, isLowBalance } from './balance-warning-view';

export { isLowBalance };

export async function BalanceWarning({
  balanceUsd,
  threshold = 0,
}: {
  balanceUsd: number | null | undefined;
  threshold?: number;
}) {
  if (!checkoutEnabled()) return null;

  const t = await getTranslations('dashboard.common');

  return (
    <BalanceWarningView
      balanceUsd={balanceUsd}
      threshold={threshold}
      LinkComponent={Link}
      message={t('balanceWarning.message')}
      actionLabel={t('balanceWarning.action')}
    />
  );
}
