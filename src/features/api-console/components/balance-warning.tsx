export function isLowBalance(
  balanceUsd: number | null | undefined,
  threshold = 0
): boolean {
  return balanceUsd != null && balanceUsd <= threshold;
}

export function BalanceWarning({
  balanceUsd,
  threshold = 0,
}: {
  balanceUsd: number | null | undefined;
  threshold?: number;
}) {
  if (!isLowBalance(balanceUsd, threshold)) {
    return null;
  }

  return (
    <div
      role="status"
      className="bg-background flex flex-col gap-3 rounded-xl border border-amber-200 px-5 py-4 text-sm shadow-sm sm:flex-row sm:items-center sm:justify-between dark:border-amber-900/60"
    >
      <div className="font-medium">Low balance — please top up</div>
      <a
        href="/dashboard/billing"
        className="bg-primary text-primary-foreground hover:bg-primary/90 inline-flex h-8 items-center justify-center rounded-md px-3 text-sm font-medium transition-colors"
      >
        Add credit
      </a>
    </div>
  );
}
