import { BalanceWarning } from '@/features/api-console/components/balance-warning';
import { StatCard } from '@/features/api-console/components/stat-card';
import { formatUsdAmount } from '@/features/api-console/lib/money';
import {
  getPortalUsage,
  listPortalApiKeys,
  type PortalUsageView,
} from '@/features/newapi-bridge/server/portal';
import { Activity, BarChart3, KeyRound, Wallet } from 'lucide-react';
import { setRequestLocale } from 'next-intl/server';

import { Link } from '@/core/i18n/navigation';
import { APIPOOL_CONFIG } from '@/config/apipool';
import { Button } from '@/shared/components/ui/button';
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

export default async function DashboardPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const user = await getUserInfo();
  const [usage, keys]: [
    PortalUsageView,
    Awaited<ReturnType<typeof listPortalApiKeys>>,
  ] = user
    ? await Promise.all([
        getPortalUsage(user as any, '7d'),
        listPortalApiKeys(user.id),
      ])
    : [EMPTY_USAGE, []];

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Overview</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Keys, balance, and usage for the APIPool API.
          </p>
        </div>
        <div className="flex gap-2">
          <Button asChild variant="outline">
            <Link href="/dashboard/billing">Add credit</Link>
          </Button>
          <Button asChild>
            <Link href="/dashboard/api-keys">
              <KeyRound className="size-4" />
              Create key
            </Link>
          </Button>
        </div>
      </div>

      <div className="bg-card flex flex-wrap items-center gap-3 rounded-xl border px-5 py-4 text-sm">
        <span className="text-muted-foreground text-xs tracking-wide uppercase">
          Base URL
        </span>
        <code className="bg-muted overflow-x-auto rounded-md border px-2.5 py-1 font-mono text-xs">
          {APIPOOL_CONFIG.apiBaseUrl}
        </code>
        <Link href="/docs" className="text-primary ml-auto text-sm font-medium">
          Quickstart →
        </Link>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Balance"
          value={formatUsdAmount(usage.summary.balanceUsd)}
          help="Billed per token"
          icon={<Wallet className="text-muted-foreground size-4" />}
        />
        <StatCard
          label="Requests · 7d"
          value={usage.summary.requestCount.toLocaleString()}
          help={`Sync: ${usage.summary.status}`}
          icon={<Activity className="text-muted-foreground size-4" />}
        />
        <StatCard
          label="Tokens · 7d"
          value={(
            usage.summary.inputTokens + usage.summary.outputTokens
          ).toLocaleString()}
          help={`${usage.summary.inputTokens.toLocaleString()} in · ${usage.summary.outputTokens.toLocaleString()} out`}
          icon={<BarChart3 className="text-muted-foreground size-4" />}
        />
        <StatCard
          label="API Keys"
          value={keys.length}
          help="Created from this console"
          icon={<KeyRound className="text-muted-foreground size-4" />}
        />
      </div>

      <BalanceWarning balanceUsd={usage.summary.balanceUsd} />

      <div className="bg-card overflow-hidden rounded-xl border">
        <div className="flex items-center justify-between border-b px-5 py-4">
          <h2 className="font-medium">Recent requests</h2>
          <Link
            href="/dashboard/usage"
            className="text-primary text-sm font-medium"
          >
            View usage →
          </Link>
        </div>
        {usage.logs.length === 0 ? (
          <div className="text-muted-foreground flex flex-col items-center gap-3 p-8 text-center text-sm">
            <span>
              No usage yet. Create a key, add credit, and make your first call.
            </span>
            <Button asChild variant="outline">
              <Link href="/dashboard/api-keys">
                <KeyRound className="size-4" />
                Create key
              </Link>
            </Button>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead>
                <tr className="bg-muted text-muted-foreground border-b text-xs uppercase">
                  <th className="px-4 py-2.5 text-left font-medium">Date</th>
                  <th className="px-4 py-2.5 text-left font-medium">Model</th>
                  <th className="px-4 py-2.5 text-right font-medium">Input</th>
                  <th className="px-4 py-2.5 text-right font-medium">Output</th>
                  <th className="px-4 py-2.5 text-right font-medium">Spend</th>
                </tr>
              </thead>
              <tbody>
                {usage.logs.slice(0, 8).map((log, index) => (
                  <tr
                    key={`${log.id}-${index}`}
                    className="border-b last:border-b-0"
                  >
                    <td className="text-muted-foreground px-4 py-2.5">
                      {log.createdAt.toLocaleString()}
                    </td>
                    <td className="px-4 py-2.5 font-mono text-xs">
                      {log.modelId}
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono">
                      {log.inputTokens.toLocaleString()}
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono">
                      {log.outputTokens.toLocaleString()}
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono">
                      {formatUsdAmount(log.spendUsd)}
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
