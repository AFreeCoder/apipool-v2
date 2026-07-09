import { StatCard } from '@/features/api-console/components/stat-card';
import { formatUsdAmount } from '@/features/api-console/lib/money';
import {
  getUsageLogRowKey,
  getUsageSyncDescription,
} from '@/features/api-console/lib/status';
import { getPortalUsage } from '@/features/newapi-bridge/server/portal';
import { getTranslations, setRequestLocale } from 'next-intl/server';

import {
  formatConsoleDateTime,
  formatConsoleNumber,
} from '@/features/api-console/lib/datetime';
import { getUserInfo } from '@/shared/models/user';

export default async function UsagePage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const [t, common] = await Promise.all([
    getTranslations({ locale, namespace: 'dashboard.usage' }),
    getTranslations({ locale, namespace: 'dashboard.common' }),
  ]);
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
  const usageSyncDescription = getUsageSyncDescription(
    usage.summary,
    common.raw('usageSync')
  );
  const usageHeaderDescription =
    usage.summary.status === 'ready' && usage.summary.syncedAt
      ? t('lastSynced', {
          date: formatConsoleDateTime(usage.summary.syncedAt, locale),
        })
      : usageSyncDescription;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{t('title')}</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          {usageHeaderDescription}
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label={t('stats.requests')}
          value={formatConsoleNumber(usage.summary.requestCount, locale)}
        />
        <StatCard
          label={t('stats.inputTokens')}
          value={formatConsoleNumber(usage.summary.inputTokens, locale)}
        />
        <StatCard
          label={t('stats.outputTokens')}
          value={formatConsoleNumber(usage.summary.outputTokens, locale)}
        />
        <StatCard
          label={t('stats.spend')}
          value={formatUsdAmount(usage.summary.spendUsd)}
        />
      </div>

      <div className="bg-card overflow-hidden rounded-xl border">
        <div className="border-b px-5 py-4 font-medium">
          {t('sections.modelDistribution.title')}
        </div>
        {usage.summary.byModel.length === 0 ? (
          <div className="text-muted-foreground p-8 text-center text-sm">
            {t('sections.modelDistribution.empty')}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-sm">
              <thead>
                <tr className="bg-muted text-muted-foreground border-b text-xs uppercase">
                  <th className="px-4 py-2.5 text-left font-medium">
                    {t('columns.model')}
                  </th>
                  <th className="px-4 py-2.5 text-right font-medium">
                    {t('columns.requests')}
                  </th>
                  <th className="px-4 py-2.5 text-right font-medium">
                    {t('columns.tokens')}
                  </th>
                  <th className="px-4 py-2.5 text-right font-medium">
                    {t('columns.spend')}
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
                      {formatConsoleNumber(model.requests, locale)}
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono">
                      {formatConsoleNumber(model.tokens, locale)}
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

      <div className="bg-card overflow-hidden rounded-xl border">
        <div className="border-b px-5 py-4 font-medium">
          {t('sections.requestLog.title')}
        </div>
        {usage.logs.length === 0 ? (
          <div className="text-muted-foreground p-8 text-center text-sm">
            {t('sections.requestLog.empty')}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead>
                <tr className="bg-muted text-muted-foreground border-b text-xs uppercase">
                  <th className="px-4 py-2.5 text-left font-medium">
                    {t('columns.date')}
                  </th>
                  <th className="px-4 py-2.5 text-left font-medium">
                    {t('columns.key')}
                  </th>
                  <th className="px-4 py-2.5 text-left font-medium">
                    {t('columns.model')}
                  </th>
                  <th className="px-4 py-2.5 text-right font-medium">
                    {t('columns.input')}
                  </th>
                  <th className="px-4 py-2.5 text-right font-medium">
                    {t('columns.output')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {usage.logs.map((log, index) => (
                  <tr
                    key={getUsageLogRowKey(log, index)}
                    className="border-b last:border-b-0"
                  >
                    <td className="text-muted-foreground px-4 py-2.5">
                      {formatConsoleDateTime(log.createdAt, locale)}
                    </td>
                    <td className="px-4 py-2.5 font-mono text-xs">
                      {log.keyMasked}
                    </td>
                    <td className="px-4 py-2.5 font-mono text-xs">
                      {log.modelId}
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono">
                      {formatConsoleNumber(log.inputTokens, locale)}
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono">
                      {formatConsoleNumber(log.outputTokens, locale)}
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
