import { BarChart3, CreditCard, KeyRound, Activity } from 'lucide-react';
import { setRequestLocale } from 'next-intl/server';

import { APIPOOL_CONFIG } from '@/config/apipool';
import {
  getPortalUsage,
  listPortalApiKeys,
  type PortalUsageView,
} from '@/features/newapi-bridge/server/portal';
import { StatCard } from '@/features/api-console/components/stat-card';
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
      <div className="rounded-lg border bg-background p-6">
        <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
          <div>
            <h1 className="text-2xl font-semibold">Dashboard</h1>
            <p className="mt-2 text-muted-foreground">
              Manage APIPool keys and monitor quota from the customer portal.
            </p>
          </div>
          <Button asChild>
            <Link href="/dashboard/api-keys">
              <KeyRound className="size-4" />
              API Keys
            </Link>
          </Button>
        </div>
        <div className="mt-5 rounded-md border bg-muted/50 p-4">
          <div className="text-xs font-medium uppercase text-muted-foreground">
            Base URL
          </div>
          <code className="mt-2 block overflow-x-auto text-sm">
            {APIPOOL_CONFIG.apiBaseUrl}
          </code>
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-4">
        <StatCard
          label="API Keys"
          value={keys.length}
          help="Keys created from this portal"
          icon={<KeyRound className="size-4 text-muted-foreground" />}
        />
        <StatCard
          label="Requests"
          value={usage.summary.requestCount}
          help={`Sync state: ${usage.summary.status}`}
          icon={<Activity className="size-4 text-muted-foreground" />}
        />
        <StatCard
          label="Tokens"
          value={(
            usage.summary.inputTokens + usage.summary.outputTokens
          ).toLocaleString()}
          help="Input and output tokens"
          icon={<BarChart3 className="size-4 text-muted-foreground" />}
        />
        <StatCard
          label="Balance"
          value={
            usage.summary.balanceUsd === undefined
              ? 'Not synced'
              : `$${usage.summary.balanceUsd}`
          }
          help="New users start with zero quota"
          icon={<CreditCard className="size-4 text-muted-foreground" />}
        />
      </div>

      <div className="rounded-lg border bg-background">
        <div className="border-b p-5">
          <h2 className="font-medium">Recent requests</h2>
        </div>
        <div className="divide-y">
          {usage.logs.length === 0 ? (
            <div className="p-8 text-center text-sm text-muted-foreground">
              No usage yet. Create a key, request quota, and make your first
              APIPool API call.
            </div>
          ) : (
            usage.logs.map((log) => (
              <div
                key={log.id}
                className="grid gap-2 p-4 text-sm md:grid-cols-5"
              >
                <span>{log.createdAt.toLocaleString()}</span>
                <span>{log.modelId}</span>
                <span>{log.status}</span>
                <span>
                  {(log.inputTokens + log.outputTokens).toLocaleString()} tokens
                </span>
                <span>{log.spendUsd === undefined ? '-' : `$${log.spendUsd}`}</span>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
