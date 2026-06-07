import {
  getPortalUsage,
  listLedgerEntries,
  type PortalUsageView,
} from '@/features/newapi-bridge/server/portal';
import { setRequestLocale } from 'next-intl/server';

import { buildBillingUsageCharges } from '@/features/api-console/lib/billing';
import { getUserInfo } from '@/shared/models/user';

const EMPTY_USAGE: PortalUsageView = {
  summary: {
    requestCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    byModel: [],
    status: 'empty',
  },
  logs: [],
};

export default async function BillingPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const user = await getUserInfo();
  const [usage, ledger]: [
    PortalUsageView,
    Awaited<ReturnType<typeof listLedgerEntries>>,
  ] = user
    ? await Promise.all([
        getPortalUsage(user as any, '7d'),
        listLedgerEntries(user.id),
      ])
    : [EMPTY_USAGE, []];
  const charges = buildBillingUsageCharges(usage);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Billing and quota</h1>
        <p className="text-muted-foreground mt-2">
          MVP billing is read-only. Operators apply quota manually and APIPool
          records the adjustment here.
        </p>
      </div>
      <div className="grid gap-4 md:grid-cols-3">
        <div className="bg-background rounded-lg border p-5">
          <div className="text-muted-foreground text-sm">Balance</div>
          <div className="mt-2 text-2xl font-semibold">
            {usage.summary.balanceUsd === undefined
              ? 'Not synced'
              : `$${usage.summary.balanceUsd}`}
          </div>
        </div>
        <div className="bg-background rounded-lg border p-5">
          <div className="text-muted-foreground text-sm">Quota remaining</div>
          <div className="mt-2 text-2xl font-semibold">
            {usage.summary.quotaRemaining === undefined
              ? 'Not synced'
              : usage.summary.quotaRemaining}
          </div>
        </div>
        <div className="bg-background rounded-lg border p-5">
          <div className="text-muted-foreground text-sm">Support</div>
          <div className="mt-2 text-sm">
            Contact support for manual quota adjustments.
          </div>
        </div>
      </div>
      <div className="bg-background rounded-lg border">
        <div className="border-b p-5 font-medium">Ledger v0</div>
        {ledger.length === 0 ? (
          <div className="text-muted-foreground p-8 text-center text-sm">
            No manual quota adjustments yet.
          </div>
        ) : (
          <div className="divide-y">
            {ledger.map((entry: any) => (
              <div
                key={entry.id}
                className="grid gap-2 p-4 text-sm md:grid-cols-5"
              >
                <span>{new Date(entry.createdAt).toLocaleString()}</span>
                <span>${entry.amountUsd}</span>
                <span>{entry.status}</span>
                <span>{entry.reason}</span>
                <span>
                  {entry.status === 'applied' ? 'Recorded' : entry.status}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="bg-background rounded-lg border">
        <div className="border-b p-5 font-medium">Usage charges</div>
        {charges.length === 0 ? (
          <div className="text-muted-foreground p-8 text-center text-sm">
            No usage charges with synced spend yet.
          </div>
        ) : (
          <div className="divide-y">
            {charges.map((charge) => (
              <div
                key={charge.id}
                className="grid gap-2 p-4 text-sm md:grid-cols-6"
              >
                <span>{new Date(charge.createdAt).toLocaleString()}</span>
                <span>{charge.keyMasked}</span>
                <span>{charge.modelId}</span>
                <span>{charge.status}</span>
                <span>{charge.tokenCount.toLocaleString()} tokens</span>
                <span>${charge.spendUsd}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
