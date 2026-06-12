import {
  getPortalUsage,
  listLedgerEntries,
  type PortalUsageView,
} from '@/features/newapi-bridge/server/portal';
import { getTranslations, setRequestLocale } from 'next-intl/server';

import { buildBillingUsageCharges } from '@/features/api-console/lib/billing';
import {
  TopUpPackages,
  type TopUpPackage,
} from '@/features/api-console/components/top-up-packages';
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

const LEDGER_SOURCE_LABELS: Record<string, string> = {
  recharge: 'Top-up',
  manual_adjustment: 'Adjustment',
};

function formatUsd(value: number | undefined) {
  if (value === undefined) return '—';
  return `$${value.toFixed(2)}`;
}

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

  const t = await getTranslations({ locale, namespace: 'pages.pricing' });
  const pricing = t.raw('page.sections.pricing') as {
    items: Array<{
      product_id: string;
      title: string;
      price: string;
      description: string;
      is_featured?: boolean;
    }>;
  };
  const packages: TopUpPackage[] = (pricing?.items || []).map((item) => ({
    productId: item.product_id,
    title: item.title,
    price: item.price,
    description: item.description,
    isFeatured: item.is_featured,
  }));

  return (
    <div className="space-y-8">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Balance</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Usage is billed per token. Balance never expires.
          </p>
        </div>
        <div className="bg-background rounded-xl border px-5 py-4">
          <div className="text-muted-foreground text-xs tracking-wide uppercase">
            Current balance
          </div>
          <div className="mt-1 font-mono text-3xl font-semibold">
            {usage.summary.balanceUsd === undefined
              ? '—'
              : `$${usage.summary.balanceUsd.toFixed(2)}`}
          </div>
        </div>
      </div>

      <div>
        <h2 className="mb-4 font-medium">Add credit</h2>
        <TopUpPackages packages={packages} locale={locale} />
      </div>

      <div className="bg-background overflow-hidden rounded-xl border">
        <div className="border-b px-5 py-4 font-medium">Credit history</div>
        {ledger.length === 0 ? (
          <div className="text-muted-foreground p-8 text-center text-sm">
            No credit activity yet. Add credit above to get started.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-sm">
              <thead>
                <tr className="bg-muted text-muted-foreground border-b text-xs uppercase">
                  <th className="px-4 py-2.5 text-left font-medium">Date</th>
                  <th className="px-4 py-2.5 text-left font-medium">Type</th>
                  <th className="px-4 py-2.5 text-right font-medium">
                    Amount
                  </th>
                  <th className="px-4 py-2.5 text-right font-medium">
                    Status
                  </th>
                </tr>
              </thead>
              <tbody>
                {ledger.map((entry: any) => (
                  <tr key={entry.id} className="border-b last:border-b-0">
                    <td className="text-muted-foreground px-4 py-2.5">
                      {new Date(entry.createdAt).toLocaleString()}
                    </td>
                    <td className="px-4 py-2.5">
                      {LEDGER_SOURCE_LABELS[entry.source] || entry.source}
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono">
                      {formatUsd(entry.amountUsd)}
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      <span
                        className={
                          entry.status === 'applied'
                            ? 'bg-primary/10 text-primary rounded-md px-1.5 py-0.5 text-xs font-medium'
                            : 'bg-muted text-muted-foreground rounded-md px-1.5 py-0.5 text-xs'
                        }
                      >
                        {entry.status === 'applied'
                          ? 'Completed'
                          : entry.status === 'pending'
                            ? 'Processing'
                            : entry.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="bg-background overflow-hidden rounded-xl border">
        <div className="border-b px-5 py-4 font-medium">Usage charges</div>
        {charges.length === 0 ? (
          <div className="text-muted-foreground p-8 text-center text-sm">
            No usage charges with synced spend yet.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead>
                <tr className="bg-muted text-muted-foreground border-b text-xs uppercase">
                  <th className="px-4 py-2.5 text-left font-medium">Date</th>
                  <th className="px-4 py-2.5 text-left font-medium">Key</th>
                  <th className="px-4 py-2.5 text-left font-medium">Model</th>
                  <th className="px-4 py-2.5 text-right font-medium">
                    Tokens
                  </th>
                  <th className="px-4 py-2.5 text-right font-medium">Spend</th>
                </tr>
              </thead>
              <tbody>
                {charges.map((charge) => (
                  <tr key={charge.id} className="border-b last:border-b-0">
                    <td className="text-muted-foreground px-4 py-2.5">
                      {new Date(charge.createdAt).toLocaleString()}
                    </td>
                    <td className="px-4 py-2.5 font-mono text-xs">
                      {charge.keyMasked}
                    </td>
                    <td className="px-4 py-2.5 font-mono text-xs">
                      {charge.modelId}
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono">
                      {charge.tokenCount.toLocaleString()}
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono">
                      ${charge.spendUsd}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
