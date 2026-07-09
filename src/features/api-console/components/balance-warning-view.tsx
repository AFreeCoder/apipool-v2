import type { ComponentType, ReactNode } from 'react';

type BillingLinkProps = {
  href: string;
  className?: string;
  children: ReactNode;
};

export function isLowBalance(
  balanceUsd: number | null | undefined,
  threshold = 0
): boolean {
  return balanceUsd != null && balanceUsd <= threshold;
}

export function BalanceWarningView({
  balanceUsd,
  threshold = 0,
  LinkComponent,
  message,
  actionLabel,
}: {
  balanceUsd: number | null | undefined;
  threshold?: number;
  LinkComponent: ComponentType<BillingLinkProps>;
  message: string;
  actionLabel: string;
}) {
  if (!isLowBalance(balanceUsd, threshold)) {
    return null;
  }

  return (
    <div
      role="status"
      className="bg-background border-chart-3/40 flex flex-col gap-3 rounded-xl border px-5 py-4 text-sm sm:flex-row sm:items-center sm:justify-between"
    >
      <div className="font-medium">{message}</div>
      <LinkComponent
        href="/dashboard/billing"
        className="bg-primary text-primary-foreground hover:bg-primary/90 inline-flex h-8 items-center justify-center rounded-md px-3 text-sm font-medium transition-colors"
      >
        {actionLabel}
      </LinkComponent>
    </div>
  );
}
