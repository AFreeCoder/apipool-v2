import { Link } from '@/core/i18n/navigation';

import { BalanceWarningView, isLowBalance } from './balance-warning-view';

export { isLowBalance };

export function BalanceWarning({
  balanceUsd,
  threshold = 0,
}: {
  balanceUsd: number | null | undefined;
  threshold?: number;
}) {
  return (
    <BalanceWarningView
      balanceUsd={balanceUsd}
      threshold={threshold}
      LinkComponent={Link}
    />
  );
}
