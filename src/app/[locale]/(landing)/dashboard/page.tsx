import { Activity, BarChart3, KeyRound, Wallet } from 'lucide-react';
import { setRequestLocale } from 'next-intl/server';

import { APIPOOL_CONFIG } from '@/config/apipool';
import {
  getPortalUsage,
  listPortalApiKeys,
  type PortalUsageView,
} from '@/features/newapi-bridge/server/portal';
import { StatCard } from '@/features/api-console/components/stat-card';
import { formatUsdAmount } from '@/features/api-console/lib/money';
import { getApipoolCopy } from '@/features/apipool-ui/copy';
import { Link } from '@/core/i18n/navigation';
import { getUserInfo } from '@/shared/models/user';
import { Button } from '@/shared/components/ui/button';

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
  const copy = getApipoolCopy(locale).dashboardPage;
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
          <h1 className="text-2xl font-semibold tracking-tight">
            {copy.title}
          </h1>
          <p className="text-muted-foreground mt-1 text-sm">
            {copy.description}
          </p>
        </div>
        <div className="flex gap-2">
          <Button asChild variant="outline" size="sm">
            <Link href="/dashboard/billing">{copy.addCredit}</Link>
          </Button>
          <Button asChild size="sm">
            <Link href="/dashboard/api-keys">
              <KeyRound className="size-4" />
              {copy.createKey}
            </Link>
          </Button>
        </div>
      </div>

      <div className="bg-background flex flex-wrap items-center gap-3 rounded-xl border px-5 py-4 text-sm">
        <span className="text-muted-foreground text-xs tracking-wide uppercase">
          {copy.baseUrl}
        </span>
        <code className="bg-muted overflow-x-auto rounded-md border px-2.5 py-1 font-mono text-xs">
          {APIPOOL_CONFIG.apiBaseUrl}
        </code>
        <Link href="/docs" className="text-primary ml-auto text-sm font-medium">
          {copy.quickstart}
        </Link>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label={copy.balance}
          value={formatUsdAmount(usage.summary.balanceUsd)}
          help={copy.billedPerToken}
          icon={<Wallet className="text-muted-foreground size-4" />}
        />
        <StatCard
          label={copy.requests7d}
          value={usage.summary.requestCount.toLocaleString()}
          help={`${copy.sync}: ${usage.summary.status}`}
          icon={<Activity className="text-muted-foreground size-4" />}
        />
        <StatCard
          label={copy.tokens7d}
          value={(
            usage.summary.inputTokens + usage.summary.outputTokens
          ).toLocaleString()}
          help={copy.inputOutput}
          icon={<BarChart3 className="text-muted-foreground size-4" />}
        />
        <StatCard
          label={copy.apiKeys}
          value={keys.length}
          help={copy.createdFromConsole}
          icon={<KeyRound className="text-muted-foreground size-4" />}
        />
      </div>

      <div className="bg-background overflow-hidden rounded-xl border">
        <div className="flex items-center justify-between border-b px-5 py-4">
          <h2 className="font-medium">{copy.recentRequests}</h2>
          <Link
            href="/dashboard/usage"
            className="text-primary text-sm font-medium"
          >
            {copy.viewUsage}
          </Link>
        </div>
        {usage.logs.length === 0 ? (
          <div className="text-muted-foreground p-8 text-center text-sm">
            {copy.emptyRecent}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-sm">
              <thead>
                <tr className="bg-muted text-muted-foreground border-b text-xs uppercase">
                  <th className="px-4 py-2.5 text-left font-medium">
                    {copy.table.date}
                  </th>
                  <th className="px-4 py-2.5 text-left font-medium">
                    {copy.table.model}
                  </th>
                  <th className="px-4 py-2.5 text-right font-medium">
                    {copy.table.tokens}
                  </th>
                  <th className="px-4 py-2.5 text-right font-medium">
                    {copy.table.spend}
                  </th>
                </tr>
              </thead>
              <tbody>
                {usage.logs.slice(0, 8).map((log) => (
                  <tr key={log.id} className="border-b last:border-b-0">
                    <td className="text-muted-foreground px-4 py-2.5">
                      {log.createdAt.toLocaleString(locale)}
                    </td>
                    <td className="px-4 py-2.5 font-mono text-xs">
                      {log.modelId}
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono">
                      {(log.inputTokens + log.outputTokens).toLocaleString()}
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
