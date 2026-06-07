import { setRequestLocale } from 'next-intl/server';

import { getPortalUsage } from '@/features/newapi-bridge/server/portal';
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
        <h1 className="text-2xl font-semibold">Usage</h1>
        <p className="mt-2 text-muted-foreground">
          APIPool API usage synced into the customer portal.
        </p>
      </div>
      <div className="rounded-lg border bg-background p-5">
        <div className="mb-4 text-sm text-muted-foreground">
          Sync state: {usage.summary.status}
          {usage.summary.syncedAt
            ? ` · Last sync ${new Date(usage.summary.syncedAt).toLocaleString()}`
            : ''}
        </div>
        <div className="grid gap-4 md:grid-cols-4">
          <div>
            <div className="text-sm text-muted-foreground">Requests</div>
            <div className="mt-1 text-2xl font-semibold">
              {usage.summary.requestCount}
            </div>
          </div>
          <div>
            <div className="text-sm text-muted-foreground">Input tokens</div>
            <div className="mt-1 text-2xl font-semibold">
              {usage.summary.inputTokens.toLocaleString()}
            </div>
          </div>
          <div>
            <div className="text-sm text-muted-foreground">Output tokens</div>
            <div className="mt-1 text-2xl font-semibold">
              {usage.summary.outputTokens.toLocaleString()}
            </div>
          </div>
          <div>
            <div className="text-sm text-muted-foreground">Spend</div>
            <div className="mt-1 text-2xl font-semibold">
              {usage.summary.spendUsd === undefined
                ? '-'
                : `$${usage.summary.spendUsd}`}
            </div>
          </div>
        </div>
      </div>
      <div className="rounded-lg border bg-background">
        <div className="border-b p-5 font-medium">Model distribution</div>
        {usage.summary.byModel.length === 0 ? (
          <div className="p-8 text-center text-sm text-muted-foreground">
            No model distribution is synced yet.
          </div>
        ) : (
          <div className="divide-y">
            {usage.summary.byModel.map((model) => (
              <div
                key={model.modelId}
                className="grid gap-2 p-4 text-sm md:grid-cols-4"
              >
                <span>{model.modelId}</span>
                <span>{model.requests.toLocaleString()} requests</span>
                <span>{model.tokens.toLocaleString()} tokens</span>
                <span>
                  {model.spendUsd === undefined ? '-' : `$${model.spendUsd}`}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="rounded-lg border bg-background">
        <div className="border-b p-5 font-medium">Request log</div>
        {usage.logs.length === 0 ? (
          <div className="p-8 text-center text-sm text-muted-foreground">
            No request logs are synced yet.
          </div>
        ) : (
          <div className="divide-y">
            {usage.logs.map((log) => (
              <div key={log.id} className="grid gap-2 p-4 text-sm md:grid-cols-5">
                <span>{log.createdAt.toLocaleString()}</span>
                <span>{log.keyMasked}</span>
                <span>{log.modelId}</span>
                <span>{log.status}</span>
                <span>
                  {(log.inputTokens + log.outputTokens).toLocaleString()} tokens
                </span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
