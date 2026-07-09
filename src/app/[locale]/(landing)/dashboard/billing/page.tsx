import {
  TopUpPackages,
  type TopUpPackage,
} from '@/features/api-console/components/top-up-packages';
import { buildBillingUsageCharges } from '@/features/api-console/lib/billing';
import {
  formatBalanceUsdAmount,
  formatLedgerUsdAmount,
  formatUsdAmount,
} from '@/features/api-console/lib/money';
import {
  getPortalUsage,
  listBillingLedgerEntries,
  type PortalUsageView,
} from '@/features/newapi-bridge/server/portal';
import { getTranslations, setRequestLocale } from 'next-intl/server';

import enBillingMessages from '@/config/locale/messages/en/dashboard/billing.json';
import zhBillingMessages from '@/config/locale/messages/zh/dashboard/billing.json';
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

type BillingLocale = 'en' | 'zh';

const BILLING_STATUS_LABELS = {
  en: {
    paymentStatus: enBillingMessages.paymentStatus,
    creditStatus: enBillingMessages.creditStatus,
  },
  zh: {
    paymentStatus: zhBillingMessages.paymentStatus,
    creditStatus: zhBillingMessages.creditStatus,
  },
};

function normalizeBillingLocale(locale: string): BillingLocale {
  return locale === 'zh' ? 'zh' : 'en';
}

export function mapPayStatus(locale: string, orderStatus: string | null) {
  if (!orderStatus) return '—';
  const normalizedLocale = normalizeBillingLocale(locale);
  const label =
    BILLING_STATUS_LABELS[normalizedLocale].paymentStatus[
      orderStatus as keyof typeof enBillingMessages.paymentStatus
    ];
  if (label) return label;
  return '—';
}

export function mapApplyStatus(locale: string, ledgerStatus: string) {
  const normalizedLocale = normalizeBillingLocale(locale);
  return (
    BILLING_STATUS_LABELS[normalizedLocale].creditStatus[
      ledgerStatus as keyof typeof enBillingMessages.creditStatus
    ] ?? ledgerStatus
  );
}

export default async function BillingPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ checkout?: string }>;
}) {
  const { locale } = await params;
  // 支付取消/失败会带 ?checkout=canceled|failed 跳回这里；没有提示的话
  // 用户只会看到余额没变，不知道发生了什么。
  const { checkout } = await searchParams;
  const checkoutNotice =
    checkout === 'canceled' || checkout === 'failed' ? checkout : null;
  setRequestLocale(locale);
  const pageT = await getTranslations({
    locale,
    namespace: 'dashboard.billing',
  });
  const user = await getUserInfo();
  const [usage, ledger]: [
    PortalUsageView,
    Awaited<ReturnType<typeof listBillingLedgerEntries>>,
  ] = user
    ? await Promise.all([
        getPortalUsage(user as any, '7d'),
        listBillingLedgerEntries(user.id),
      ])
    : [EMPTY_USAGE, []];
  const charges = buildBillingUsageCharges(usage);

  const pricingT = await getTranslations({
    locale,
    namespace: 'pages.pricing',
  });
  const pricing = pricingT.raw('page.sections.pricing') as {
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
      {checkoutNotice ? (
        <div
          role="status"
          className="border-border bg-muted text-muted-foreground rounded-xl border px-4 py-3 text-sm"
        >
          {pageT(`checkoutNotice.${checkoutNotice}`)}
        </div>
      ) : null}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            {pageT('title')}
          </h1>
          <p className="text-muted-foreground mt-1 text-sm">
            {pageT('description')}
          </p>
        </div>
        <div className="bg-card rounded-xl border px-5 py-4">
          <div className="text-muted-foreground text-xs tracking-wide uppercase">
            {pageT('currentBalance')}
          </div>
          <div className="mt-1 font-mono text-2xl font-semibold">
            {formatBalanceUsdAmount(usage.summary.balanceUsd)}
          </div>
        </div>
      </div>

      <div>
        <h2 className="mb-4 font-medium">{pageT('addCredit')}</h2>
        <TopUpPackages
          packages={packages}
          locale={locale}
          labels={pageT.raw('topUp')}
        />
      </div>

      <div className="bg-card overflow-hidden rounded-xl border">
        <div className="border-b px-5 py-4 font-medium">
          {pageT('creditHistory.title')}
        </div>
        {ledger.length === 0 ? (
          <div className="text-muted-foreground p-8 text-center text-sm">
            {pageT('creditHistory.empty')}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-sm">
              <thead>
                <tr className="bg-muted text-muted-foreground border-b text-xs uppercase">
                  <th className="px-4 py-2.5 text-left font-medium">
                    {pageT('creditHistory.columns.orderTime')}
                  </th>
                  <th className="px-4 py-2.5 text-right font-medium">
                    {pageT('creditHistory.columns.amount')}
                  </th>
                  <th className="px-4 py-2.5 text-right font-medium">
                    {pageT('creditHistory.columns.paymentStatus')}
                  </th>
                  <th className="px-4 py-2.5 text-right font-medium">
                    {pageT('creditHistory.columns.creditStatus')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {ledger.map((entry, index) => (
                  <tr
                    key={`${entry.orderNo || 'manual'}-${entry.createdAt}-${index}`}
                    className="border-b last:border-b-0"
                  >
                    <td className="text-muted-foreground px-4 py-2.5">
                      {new Date(entry.createdAt).toLocaleString()}
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono">
                      {formatLedgerUsdAmount(entry.amountUsd)}
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      <span
                        className={
                          entry.orderStatus === 'paid'
                            ? 'bg-primary/10 text-primary rounded-md px-1.5 py-0.5 text-xs font-medium'
                            : 'bg-muted text-muted-foreground rounded-md px-1.5 py-0.5 text-xs'
                        }
                      >
                        {mapPayStatus(locale, entry.orderStatus)}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      <span
                        className={
                          entry.ledgerStatus === 'applied'
                            ? 'bg-primary/10 text-primary rounded-md px-1.5 py-0.5 text-xs font-medium'
                            : 'bg-muted text-muted-foreground rounded-md px-1.5 py-0.5 text-xs'
                        }
                      >
                        {mapApplyStatus(locale, entry.ledgerStatus)}
                      </span>
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
          {pageT('usageCharges.title')}
        </div>
        {charges.length === 0 ? (
          <div className="text-muted-foreground p-8 text-center text-sm">
            {pageT('usageCharges.empty')}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead>
                <tr className="bg-muted text-muted-foreground border-b text-xs uppercase">
                  <th className="px-4 py-2.5 text-left font-medium">
                    {pageT('usageCharges.columns.date')}
                  </th>
                  <th className="px-4 py-2.5 text-left font-medium">
                    {pageT('usageCharges.columns.key')}
                  </th>
                  <th className="px-4 py-2.5 text-left font-medium">
                    {pageT('usageCharges.columns.model')}
                  </th>
                  <th className="px-4 py-2.5 text-right font-medium">
                    {pageT('usageCharges.columns.tokens')}
                  </th>
                  <th className="px-4 py-2.5 text-right font-medium">
                    {pageT('usageCharges.columns.spend')}
                  </th>
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
                      {formatUsdAmount(charge.spendUsd)}
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
