import { BalanceWarning } from '@/features/api-console/components/balance-warning';
import { StatCard } from '@/features/api-console/components/stat-card';
import {
  formatConsoleDateTime,
  formatConsoleNumber,
} from '@/features/api-console/lib/datetime';
import {
  formatBalanceUsdAmount,
  formatUsdAmount,
} from '@/features/api-console/lib/money';
import {
  getUsageLogRowKey,
  getUsageSyncDescription,
} from '@/features/api-console/lib/status';
import { checkoutEnabled } from '@/features/gateway/lib/config';
import { listPortalApiKeys } from '@/features/newapi-bridge/server/portal';
import { getWalletUsageView } from '@/features/wallet/server/usage-view';
import { Activity, BarChart3, KeyRound, Wallet } from 'lucide-react';
import { getTranslations, setRequestLocale } from 'next-intl/server';

import { Link } from '@/core/i18n/navigation';
import { APIPOOL_CONFIG } from '@/config/apipool';
import { Button } from '@/shared/components/ui/button';
import { getUserInfo } from '@/shared/models/user';

const EMPTY_USAGE = {
  summary: {
    balanceUsd: 0,
    requestCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    spendUsd: 0,
    byModel: [],
    status: 'empty' as const,
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
  const [t, common] = await Promise.all([
    getTranslations({ locale, namespace: 'dashboard.overview' }),
    getTranslations({ locale, namespace: 'dashboard.common' }),
  ]);
  const user = await getUserInfo();
  const canCheckout = checkoutEnabled();
  const [usage, keys] = user
    ? await Promise.all([
        getWalletUsageView(user.id, '7d').then((view) => ({
          summary: { ...view.summary, status: 'ready' as const },
          logs: view.logs,
        })),
        listPortalApiKeys(user.id),
      ])
    : [EMPTY_USAGE, []];
  const usageSyncDescription = getUsageSyncDescription(
    usage.summary,
    common.raw('usageSync')
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            {t('title')}
          </h1>
          <p className="text-muted-foreground mt-1 text-sm">
            {t('description')}
          </p>
        </div>
        <div className="flex gap-2">
          {canCheckout ? (
            <Button asChild variant="outline">
              <Link href="/dashboard/billing">{t('actions.addCredit')}</Link>
            </Button>
          ) : null}
          <Button asChild>
            <Link href="/dashboard/api-keys">
              <KeyRound className="size-4" />
              {t('actions.createKey')}
            </Link>
          </Button>
        </div>
      </div>

      <div className="bg-card flex flex-wrap items-center gap-3 rounded-xl border px-5 py-4 text-sm">
        <span className="text-muted-foreground text-xs tracking-wide uppercase">
          {t('baseUrl')}
        </span>
        <code className="bg-muted overflow-x-auto rounded-md border px-2.5 py-1 font-mono text-xs">
          {APIPOOL_CONFIG.apiBaseUrl}
        </code>
        <Link href="/docs" className="text-primary ml-auto text-sm font-medium">
          {t('actions.quickstart')}
        </Link>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label={t('stats.balance')}
          value={formatBalanceUsdAmount(usage.summary.balanceUsd)}
          help={t('stats.balanceHelp')}
          icon={<Wallet className="text-muted-foreground size-4" />}
        />
        <StatCard
          label={t('stats.requests')}
          value={formatConsoleNumber(usage.summary.requestCount, locale)}
          help={usageSyncDescription}
          icon={<Activity className="text-muted-foreground size-4" />}
        />
        <StatCard
          label={t('stats.tokens')}
          value={formatConsoleNumber(
            usage.summary.inputTokens + usage.summary.outputTokens,
            locale
          )}
          help={t('stats.tokensHelp', {
            input: formatConsoleNumber(usage.summary.inputTokens, locale),
            output: formatConsoleNumber(usage.summary.outputTokens, locale),
          })}
          icon={<BarChart3 className="text-muted-foreground size-4" />}
        />
        <StatCard
          label={t('stats.apiKeys')}
          value={keys.length}
          help={t('stats.apiKeysHelp')}
          icon={<KeyRound className="text-muted-foreground size-4" />}
        />
      </div>

      <BalanceWarning balanceUsd={usage.summary.balanceUsd} />

      <div className="bg-card overflow-hidden rounded-xl border">
        <div className="flex items-center justify-between border-b px-5 py-4">
          <h2 className="font-medium">{t('recentRequests.title')}</h2>
          <Link
            href="/dashboard/usage"
            className="text-primary text-sm font-medium"
          >
            {t('actions.viewUsage')}
          </Link>
        </div>
        {usage.logs.length === 0 ? (
          <div className="text-muted-foreground flex flex-col items-center gap-3 p-8 text-center text-sm">
            <span>{t('recentRequests.empty')}</span>
            <Button asChild variant="outline">
              <Link href="/dashboard/api-keys">
                <KeyRound className="size-4" />
                {t('actions.createKey')}
              </Link>
            </Button>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead>
                <tr className="bg-muted text-muted-foreground border-b text-xs uppercase">
                  <th className="px-4 py-2.5 text-left font-medium">
                    {t('recentRequests.columns.date')}
                  </th>
                  <th className="px-4 py-2.5 text-left font-medium">
                    {t('recentRequests.columns.model')}
                  </th>
                  <th className="px-4 py-2.5 text-right font-medium">
                    {t('recentRequests.columns.input')}
                  </th>
                  <th className="px-4 py-2.5 text-right font-medium">
                    {t('recentRequests.columns.output')}
                  </th>
                  <th className="px-4 py-2.5 text-right font-medium">
                    {t('recentRequests.columns.spend')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {usage.logs.slice(0, 8).map((log, index) => (
                  <tr
                    key={getUsageLogRowKey(log, index)}
                    className="border-b last:border-b-0"
                  >
                    <td className="text-muted-foreground px-4 py-2.5">
                      {formatConsoleDateTime(log.createdAt, locale)}
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
                    <td className="px-4 py-2.5 text-right font-mono">
                      {formatUsdAmount(log.chargedUsd)}
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
