import type { ReactNode } from 'react';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';

import { PERMISSIONS, requirePermission } from '@/core/rbac';
import {
  formatBalanceUsdAmount,
  formatLedgerUsdAmount,
  formatUsdAmount,
} from '@/features/api-console/lib/money';
import {
  confirmNewapiUserConflictAction,
  disableNewapiUserBindingAction,
  restoreNewapiUserBindingAction,
  retryNewapiUserBindingAction,
} from '@/features/newapi-bridge/server/admin-user-binding-actions';
import {
  getPortalUserBinding,
  listPortalApiKeys,
  toAdminBindingDto,
} from '@/features/newapi-bridge/server/portal';
import {
  getWalletBillingView,
  getWalletUsageView,
} from '@/features/wallet/server/usage-view';
import { ConfirmActionButton } from '@/shared/blocks/common/confirm-action-button';
import { Header, Main, MainHeader } from '@/shared/blocks/dashboard';
import { Table } from '@/shared/blocks/table';
import { TableCard } from '@/shared/blocks/table/table-card';
import { Badge } from '@/shared/components/ui/badge';
import { Button } from '@/shared/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/shared/components/ui/card';
import { findUserById, getUserInfo } from '@/shared/models/user';
import { hasPermission } from '@/shared/services/rbac';
import { Crumb } from '@/shared/types/blocks/common';

type LoadResult<T> = {
  data: T;
  failed: boolean;
};

type WalletUsageView = Awaited<ReturnType<typeof getWalletUsageView>>;
type WalletBillingView = Awaited<ReturnType<typeof getWalletBillingView>>;

function emptyUsageView(): WalletUsageView {
  return {
    summary: {
      balanceUsd: 0,
      requestCount: 0,
      inputTokens: 0,
      outputTokens: 0,
      spendUsd: 0,
      byModel: [],
      status: 'ok',
      syncedAt: new Date(0).toISOString(),
    },
    logs: [],
  };
}

function emptyBillingView(): WalletBillingView {
  return {
    balance: { balanceUsd: 0, frozen: false },
    ledger: [],
  };
}

async function loadOrFallback<T>(
  loader: () => Promise<T>,
  fallback: T
): Promise<LoadResult<T>> {
  try {
    return { data: await loader(), failed: false };
  } catch {
    return { data: fallback, failed: true };
  }
}

function localeTag(locale: string) {
  return locale === 'zh' ? 'zh-CN' : locale;
}

function formatCount(
  value: number | null | undefined,
  locale: string,
  fallback: string
) {
  if (value === undefined || value === null) return fallback;
  return new Intl.NumberFormat(localeTag(locale)).format(value);
}

function formatOptionalUsd(value: number | null | undefined, fallback: string) {
  if (value === undefined || value === null) return fallback;
  return formatUsdAmount(value);
}

function formatOptionalBalanceUsd(
  value: number | null | undefined,
  fallback: string
) {
  if (value === undefined || value === null) return fallback;
  return formatBalanceUsdAmount(value);
}

function formatOptionalLedgerUsd(
  value: number | null | undefined,
  fallback: string
) {
  if (value === undefined || value === null) return fallback;
  return formatLedgerUsdAmount(value);
}

function formatDateTime(
  value: Date | number | string | null | undefined,
  locale: string,
  fallback: string
) {
  if (!value) return fallback;
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return fallback;

  return new Intl.DateTimeFormat(localeTag(locale), {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

function translateStatus(
  t: (key: string) => string,
  prefix: string,
  value: string | null | undefined,
  fallback: string
) {
  if (!value) return fallback;
  try {
    return t(`${prefix}.${value}`);
  } catch {
    return value;
  }
}

function statusVariant(status: string | null | undefined) {
  if (
    status === 'failed' ||
    status === 'failed_terminal' ||
    status === 'reconciliation_required' ||
    status === 'username_sync_failed' ||
    status === 'conflict_requires_review'
  ) {
    return 'destructive' as const;
  }
  if (status === 'active' || status === 'applied' || status === 'ready') {
    return 'default' as const;
  }
  return 'secondary' as const;
}

function Metric({
  label,
  value,
  description,
}: {
  label: string;
  value: string;
  description?: string;
}) {
  return (
    <div className="min-w-0 rounded-lg border p-4">
      <dt className="text-muted-foreground text-sm">{label}</dt>
      <dd className="mt-2 text-2xl font-semibold break-words">{value}</dd>
      {description ? (
        <p className="text-muted-foreground mt-2 text-xs">{description}</p>
      ) : null}
    </div>
  );
}

function DataNotice({ children }: { children: ReactNode }) {
  return (
    <div className="border-destructive/30 bg-destructive/5 text-destructive rounded-lg border px-4 py-3 text-sm">
      {children}
    </div>
  );
}

export default async function AdminUserDetailPage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const { locale, id } = await params;

  await requirePermission({
    code: PERMISSIONS.USERS_READ,
    redirectUrl: '/admin/no-permission',
    locale,
  });
  const currentUser = await getUserInfo();
  const [canAdjustApipoolQuota, canWriteUsers] = currentUser
    ? await Promise.all([
        hasPermission(currentUser.id, PERMISSIONS.APIPOOL_QUOTA_ADJUST),
        hasPermission(currentUser.id, PERMISSIONS.USERS_WRITE),
      ])
    : [false, false];

  const t = await getTranslations('admin.users');
  const targetUser = await findUserById(id);
  if (!targetUser) {
    notFound();
  }

  const [bindingResult, usageResult, keysResult, billingResult] =
    await Promise.all([
      loadOrFallback(async () => {
        const binding = await getPortalUserBinding(targetUser.id);
        return binding ? toAdminBindingDto(binding) : null;
      }, null),
      loadOrFallback(
        () => getWalletUsageView(targetUser.id, '7d'),
        emptyUsageView()
      ),
      loadOrFallback(() => listPortalApiKeys(targetUser.id), []),
      loadOrFallback(
        () => getWalletBillingView(targetUser.id),
        emptyBillingView()
      ),
    ]);

  const emptyValue = t('detail.empty.value');

  const crumbs: Crumb[] = [
    { title: t('detail.crumbs.admin'), url: '/admin' },
    { title: t('detail.crumbs.users'), url: '/admin/users' },
    { title: t('detail.crumbs.detail'), is_active: true },
  ];

  const usageLogColumns = [
    {
      name: 'createdAt',
      title: t('detail.usage.logs.columns.created_at'),
      callback: (item: any) =>
        formatDateTime(item.createdAt, locale, emptyValue),
    },
    {
      name: 'modelId',
      title: t('detail.usage.logs.columns.model'),
      placeholder: emptyValue,
    },
    {
      name: 'status',
      title: t('detail.usage.logs.columns.status'),
      callback: (item: any) => (
        <Badge variant={statusVariant(item.status)}>
          {translateStatus(t, 'detail.status.request', item.status, emptyValue)}
        </Badge>
      ),
    },
    {
      name: 'inputTokens',
      title: t('detail.usage.logs.columns.input_tokens'),
      callback: (item: any) =>
        formatCount(item.inputTokens, locale, emptyValue),
    },
    {
      name: 'outputTokens',
      title: t('detail.usage.logs.columns.output_tokens'),
      callback: (item: any) =>
        formatCount(item.outputTokens, locale, emptyValue),
    },
    {
      name: 'chargedUsd',
      title: t('detail.usage.logs.columns.spend'),
      callback: (item: any) => formatOptionalUsd(item.chargedUsd, emptyValue),
    },
  ];

  const keyColumns = [
    {
      name: 'displayName',
      title: t('detail.keys.columns.name'),
      placeholder: emptyValue,
    },
    {
      name: 'keyMasked',
      title: t('detail.keys.columns.key'),
      type: 'copy' as const,
      placeholder: emptyValue,
    },
    {
      name: 'groupName',
      title: t('detail.keys.columns.group'),
      placeholder: emptyValue,
    },
    {
      name: 'status',
      title: t('detail.keys.columns.status'),
      callback: (item: any) => (
        <Badge variant={statusVariant(item.status)}>
          {translateStatus(t, 'detail.status.key', item.status, emptyValue)}
        </Badge>
      ),
    },
    {
      name: 'createdAt',
      title: t('detail.keys.columns.created_at'),
      type: 'time' as const,
      placeholder: emptyValue,
    },
    {
      name: 'lastUsedAt',
      title: t('detail.keys.columns.last_used_at'),
      type: 'time' as const,
      placeholder: emptyValue,
    },
  ];

  const ledgerColumns = [
    {
      name: 'createdAt',
      title: t('detail.ledger.columns.created_at'),
      type: 'time' as const,
      placeholder: emptyValue,
    },
    {
      name: 'entryType',
      title: t('detail.ledger.columns.source'),
      callback: (item: any) =>
        translateStatus(
          t,
          'detail.status.ledger_source',
          item.entryType,
          item.entryType
        ),
    },
    {
      name: 'orderNo',
      title: t('detail.ledger.columns.order_no'),
      callback: (item: any) =>
        item.orderNo ? (
          <span className="font-mono text-xs">{item.orderNo}</span>
        ) : (
          emptyValue
        ),
    },
    {
      name: 'signedAmountUsd',
      title: t('detail.ledger.columns.amount'),
      callback: (item: any) =>
        formatOptionalLedgerUsd(item.signedAmountUsd, emptyValue),
    },
    {
      name: 'balanceAfterUsd',
      title: t('detail.ledger.columns.balance_after'),
      callback: (item: any) =>
        formatOptionalLedgerUsd(item.balanceAfterUsd, emptyValue),
    },
    {
      name: 'reason',
      title: t('detail.ledger.columns.reason'),
      placeholder: emptyValue,
    },
  ];

  return (
    <>
      <Header crumbs={crumbs} />
      <Main>
        <MainHeader
          title={t('detail.title')}
          description={targetUser.email}
          actions={
            canAdjustApipoolQuota
              ? [
                  {
                    title: t('detail.buttons.adjust_quota'),
                    icon: 'Gauge',
                    url: `/admin/apipool-adjustments?portalUserId=${targetUser.id}`,
                    variant: 'outline',
                  },
                ]
              : []
          }
        />

        <div className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>{t('detail.binding.title')}</CardTitle>
              <CardDescription>
                {t('detail.binding.description')}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {bindingResult.failed ? (
                <DataNotice>{t('detail.errors.binding')}</DataNotice>
              ) : null}
              <dl className="grid gap-4 md:grid-cols-3">
                <Metric
                  label={t('detail.binding.fields.status')}
                  value={translateStatus(
                    t,
                    'detail.status.binding',
                    bindingResult.data?.status,
                    emptyValue
                  )}
                />
                <Metric
                  label={t('detail.binding.fields.target_username')}
                  value={bindingResult.data?.targetNewapiUsername || emptyValue}
                />
                <Metric
                  label={t('detail.binding.fields.confirmed_username')}
                  value={bindingResult.data?.newapiUsername || emptyValue}
                />
                <Metric
                  label={t('detail.binding.fields.error_code')}
                  value={bindingResult.data?.lastSyncErrorCode || emptyValue}
                />
                <Metric
                  label={t('detail.binding.fields.last_attempted')}
                  value={formatDateTime(
                    bindingResult.data?.lastSyncAttemptedAt,
                    locale,
                    t('detail.empty.never_synced')
                  )}
                />
                <Metric
                  label={t('detail.binding.fields.last_synced')}
                  value={formatDateTime(
                    bindingResult.data?.lastSyncedAt,
                    locale,
                    t('detail.empty.never_synced')
                  )}
                />
              </dl>
              {bindingResult.data?.lastSyncError ? (
                <DataNotice>{bindingResult.data.lastSyncError}</DataNotice>
              ) : null}
              {/* The page only requires USERS_READ, but every action below is
                  a USERS_WRITE server action. Rendering them for a read-only
                  admin means the click is the first sign of the missing
                  permission — and the thrown error is masked in production. */}
              {canWriteUsers ? (
                <div className="flex flex-wrap gap-2">
                  {bindingResult.data?.status === 'disabled' ? (
                    // While disabled, retry/disable are both no-ops that only
                    // error out; restore is the sole meaningful action.
                    <ConfirmActionButton
                      variant="default"
                      label={t('detail.binding.actions.restore')}
                      title={t('detail.binding.restore_confirm.title')}
                      description={t(
                        'detail.binding.restore_confirm.description'
                      )}
                      confirmLabel={t('detail.binding.restore_confirm.confirm')}
                      cancelLabel={t('detail.binding.restore_confirm.cancel')}
                      errorMessage={t('detail.binding.restore_confirm.error')}
                      action={async () => {
                        'use server';
                        await restoreNewapiUserBindingAction({
                          portalUserId: targetUser.id,
                        });
                      }}
                    />
                  ) : (
                    <>
                      <form
                        action={async () => {
                          'use server';
                          await retryNewapiUserBindingAction({
                            portalUserId: targetUser.id,
                          });
                        }}
                      >
                        <Button type="submit" variant="outline" size="sm">
                          {t('detail.binding.actions.retry')}
                        </Button>
                      </form>
                      {bindingResult.data?.status ===
                        'conflict_requires_review' &&
                      bindingResult.data.conflictNewapiUserId ? (
                        <form
                          action={async () => {
                            'use server';
                            await confirmNewapiUserConflictAction({
                              portalUserId: targetUser.id,
                              newapiUserId:
                                bindingResult.data!.conflictNewapiUserId!,
                            });
                          }}
                        >
                          <Button type="submit" variant="outline" size="sm">
                            {t('detail.binding.actions.confirm_conflict')}
                          </Button>
                        </form>
                      ) : null}
                      <ConfirmActionButton
                        label={t('detail.binding.actions.disable')}
                        title={t('detail.binding.disable_confirm.title')}
                        description={t(
                          'detail.binding.disable_confirm.description'
                        )}
                        confirmLabel={t(
                          'detail.binding.disable_confirm.confirm'
                        )}
                        cancelLabel={t('detail.binding.disable_confirm.cancel')}
                        errorMessage={t('detail.binding.disable_confirm.error')}
                        action={async () => {
                          'use server';
                          await disableNewapiUserBindingAction({
                            portalUserId: targetUser.id,
                            reason: 'admin detail action',
                          });
                        }}
                      />
                    </>
                  )}
                </div>
              ) : null}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>{t('detail.balance.title')}</CardTitle>
              <CardDescription>
                {t('detail.balance.description')}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {billingResult.failed ? (
                <DataNotice>{t('detail.errors.usage')}</DataNotice>
              ) : null}
              <dl className="grid gap-4 md:grid-cols-2">
                <Metric
                  label={t('detail.balance.fields.balance')}
                  value={formatOptionalBalanceUsd(
                    billingResult.data.balance.balanceUsd,
                    t('detail.empty.not_initialized')
                  )}
                />
                <Metric
                  label={t('detail.balance.fields.wallet_status')}
                  value={
                    billingResult.data.balance.frozen
                      ? t('detail.status.wallet.frozen')
                      : t('detail.status.wallet.active')
                  }
                />
              </dl>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>{t('detail.usage.title')}</CardTitle>
              <CardDescription>{t('detail.usage.description')}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              {usageResult.failed ? (
                <DataNotice>{t('detail.errors.usage')}</DataNotice>
              ) : null}
              <dl className="grid gap-4 md:grid-cols-4">
                <Metric
                  label={t('detail.usage.fields.requests')}
                  value={formatCount(
                    usageResult.data.summary.requestCount,
                    locale,
                    emptyValue
                  )}
                />
                <Metric
                  label={t('detail.usage.fields.input_tokens')}
                  value={formatCount(
                    usageResult.data.summary.inputTokens,
                    locale,
                    emptyValue
                  )}
                />
                <Metric
                  label={t('detail.usage.fields.output_tokens')}
                  value={formatCount(
                    usageResult.data.summary.outputTokens,
                    locale,
                    emptyValue
                  )}
                />
                <Metric
                  label={t('detail.usage.fields.spend')}
                  value={formatOptionalUsd(
                    usageResult.data.summary.spendUsd,
                    emptyValue
                  )}
                />
              </dl>
              <div className="overflow-x-auto">
                <Table
                  columns={usageLogColumns}
                  data={usageResult.data.logs}
                  emptyMessage={t('detail.empty.usage_logs')}
                />
              </div>
            </CardContent>
          </Card>

          {keysResult.failed ? (
            <DataNotice>{t('detail.errors.keys')}</DataNotice>
          ) : null}
          <TableCard
            title={t('detail.keys.title')}
            description={t('detail.keys.description')}
            table={{
              columns: keyColumns,
              data: keysResult.data,
              emptyMessage: t('detail.empty.keys'),
            }}
          />

          {billingResult.failed ? (
            <DataNotice>{t('detail.errors.ledger')}</DataNotice>
          ) : null}
          <TableCard
            title={t('detail.ledger.title')}
            description={t('detail.ledger.description')}
            table={{
              columns: ledgerColumns,
              data: billingResult.data.ledger,
              emptyMessage: t('detail.empty.ledger'),
            }}
          />
        </div>
      </Main>
    </>
  );
}
