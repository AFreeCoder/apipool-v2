import { setRequestLocale } from 'next-intl/server';

import { getPortalUsage } from '@/features/newapi-bridge/server/portal';
import { StatCard } from '@/features/api-console/components/stat-card';
import { formatUsdAmount } from '@/features/api-console/lib/money';
import { getUserInfo } from '@/shared/models/user';

export default async function UsagePage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
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
        <h1 className="text-2xl font-semibold tracking-tight">Usage</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          {usage.summary.status === 'empty'
            ? 'No usage in the last 7 days yet.'
            : `Last 7 days${
                usage.summary.syncedAt
                  ? ` · synced ${new Date(usage.summary.syncedAt).toLocaleString()}`
                  : ''
              }`}
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Requests"
          value={usage.summary.requestCount.toLocaleString()}
        />
        <StatCard
          label="Input tokens"
          value={usage.summary.inputTokens.toLocaleString()}
        />
        <StatCard
          label="Output tokens"
          value={usage.summary.outputTokens.toLocaleString()}
        />
        <StatCard
          label="Spend"
          value={formatUsdAmount(usage.summary.spendUsd)}
        />
      </div>

      <div className="bg-background overflow-hidden rounded-xl border">
        <div className="border-b px-5 py-4 font-medium">
          Model distribution
        </div>
        {usage.summary.byModel.length === 0 ? (
          <div className="text-muted-foreground p-8 text-center text-sm">
            No model distribution synced yet.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-sm">
              <thead>
                <tr className="bg-muted text-muted-foreground border-b text-xs uppercase">
                  <th className="px-4 py-2.5 text-left font-medium">Model</th>
                  <th className="px-4 py-2.5 text-right font-medium">
                    Requests
                  </th>
                  <th className="px-4 py-2.5 text-right font-medium">
                    Tokens
                  </th>
                  <th className="px-4 py-2.5 text-right font-medium">Spend</th>
                </tr>
              </thead>
              <tbody>
                {usage.summary.byModel.map((model) => (
                  <tr key={model.modelId} className="border-b last:border-b-0">
                    <td className="px-4 py-2.5 font-mono text-xs">
                      {model.modelId}
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono">
                      {model.requests.toLocaleString()}
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono">
                      {model.tokens.toLocaleString()}
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
        <div className="border-b px-5 py-4 font-medium">Request log</div>
        {usage.logs.length === 0 ? (
          <div className="text-muted-foreground p-8 text-center text-sm">
            No request logs synced yet.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead>
                <tr className="bg-muted text-muted-foreground border-b text-xs uppercase">
                  <th className="px-4 py-2.5 text-left font-medium">Date</th>
                  <th className="px-4 py-2.5 text-left font-medium">Key</th>
                  <th className="px-4 py-2.5 text-left font-medium">Model</th>
                  <th className="px-4 py-2.5 text-right font-medium">In</th>
                  <th className="px-4 py-2.5 text-right font-medium">Out</th>
                </tr>
              </thead>
              <tbody>
                {usage.logs.map((log, index) => (
                  <tr
                    key={`${log.id}-${index}`}
                    className="border-b last:border-b-0"
                  >
                    <td className="text-muted-foreground px-4 py-2.5">
                      {log.createdAt.toLocaleString()}
                    </td>
                    <td className="px-4 py-2.5 font-mono text-xs">
                      {log.keyMasked}
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
