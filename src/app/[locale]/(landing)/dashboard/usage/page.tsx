import { setRequestLocale } from 'next-intl/server';

import { getPortalUsage } from '@/features/newapi-bridge/server/portal';
import { StatCard } from '@/features/api-console/components/stat-card';
import { formatUsdAmount } from '@/features/api-console/lib/money';
import { getApipoolCopy } from '@/features/apipool-ui/copy';
import { getUserInfo } from '@/shared/models/user';

function formatLatencyMs(value?: number) {
  if (typeof value !== 'number') return '—';
  if (value >= 1000) return `${(value / 1000).toFixed(2)}s`;
  return `${value}ms`;
}

export default async function UsagePage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const copy = getApipoolCopy(locale).usagePage;
  const user = await getUserInfo();
  const usage = user
    ? await getPortalUsage(user as any, '7d')
    : {
        summary: {
          requestCount: 0,
          inputTokens: 0,
          outputTokens: 0,
          byModel: [],
          status: 'empty' as const,
        },
        logs: [],
      };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{copy.title}</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          {usage.summary.status === 'empty'
            ? copy.emptyStatus
            : `${copy.last7Days}${
                usage.summary.syncedAt
                  ? ` · ${copy.synced} ${new Date(
                      usage.summary.syncedAt
                    ).toLocaleString(locale)}`
                  : ''
              }`}
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        <StatCard
          label={copy.requests}
          value={usage.summary.requestCount.toLocaleString(locale)}
        />
        <StatCard
          label={copy.inputTokens}
          value={usage.summary.inputTokens.toLocaleString(locale)}
        />
        <StatCard
          label={copy.outputTokens}
          value={usage.summary.outputTokens.toLocaleString(locale)}
        />
        <StatCard
          label={copy.spend}
          value={formatUsdAmount(usage.summary.spendUsd)}
        />
        <StatCard
          label={copy.averageLatency}
          value={formatLatencyMs(usage.summary.averageLatencyMs)}
        />
        <StatCard
          label={copy.topModel}
          value={usage.summary.topModelId || copy.noTopModel}
        />
      </div>

      <div className="bg-background overflow-hidden rounded-xl border">
        <div className="border-b px-5 py-4 font-medium">
          {copy.modelDistribution}
        </div>
        {usage.summary.byModel.length === 0 ? (
          <div className="text-muted-foreground p-8 text-center text-sm">
            {copy.noModelDistribution}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-sm">
              <thead>
                <tr className="bg-muted text-muted-foreground border-b text-xs uppercase">
                  <th className="px-4 py-2.5 text-left font-medium">
                    {copy.table.model}
                  </th>
                  <th className="px-4 py-2.5 text-right font-medium">
                    {copy.table.requests}
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
                {usage.summary.byModel.map((model) => (
                  <tr key={model.modelId} className="border-b last:border-b-0">
                    <td className="px-4 py-2.5 font-mono text-xs">
                      {model.modelId}
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono">
                      {model.requests.toLocaleString(locale)}
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono">
                      {model.tokens.toLocaleString(locale)}
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono">
                      {formatUsdAmount(model.spendUsd)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="bg-background overflow-hidden rounded-xl border">
        <div className="border-b px-5 py-4 font-medium">
          {copy.requestLog}
        </div>
        {usage.logs.length === 0 ? (
          <div className="text-muted-foreground p-8 text-center text-sm">
            {copy.noRequestLogs}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[920px] text-sm">
              <thead>
                <tr className="bg-muted text-muted-foreground border-b text-xs uppercase">
                  <th className="px-4 py-2.5 text-left font-medium">
                    {copy.table.date}
                  </th>
                  <th className="px-4 py-2.5 text-left font-medium">
                    {copy.table.key}
                  </th>
                  <th className="px-4 py-2.5 text-left font-medium">
                    {copy.table.model}
                  </th>
                  <th className="px-4 py-2.5 text-left font-medium">
                    {copy.table.group}
                  </th>
                  <th className="px-4 py-2.5 text-left font-medium">
                    {copy.table.channel}
                  </th>
                  <th className="px-4 py-2.5 text-right font-medium">
                    {copy.table.in}
                  </th>
                  <th className="px-4 py-2.5 text-right font-medium">
                    {copy.table.out}
                  </th>
                  <th className="px-4 py-2.5 text-right font-medium">
                    {copy.table.latency}
                  </th>
                  <th className="px-4 py-2.5 text-right font-medium">
                    {copy.table.spend}
                  </th>
                </tr>
              </thead>
              <tbody>
                {usage.logs.map((log) => (
                  <tr key={log.id} className="border-b last:border-b-0">
                    <td className="text-muted-foreground px-4 py-2.5">
                      {log.createdAt.toLocaleString(locale)}
                    </td>
                    <td className="px-4 py-2.5 font-mono text-xs">
                      {log.keyMasked}
                    </td>
                    <td className="px-4 py-2.5 font-mono text-xs">
                      {log.modelId}
                    </td>
                    <td className="px-4 py-2.5 font-mono text-xs">
                      {log.group || usage.summary.group || '-'}
                    </td>
                    <td className="px-4 py-2.5 font-mono text-xs">
                      {log.channelName || '-'}
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono">
                      {log.inputTokens.toLocaleString(locale)}
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono">
                      {log.outputTokens.toLocaleString(locale)}
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono">
                      {formatLatencyMs(log.latencyMs)}
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
