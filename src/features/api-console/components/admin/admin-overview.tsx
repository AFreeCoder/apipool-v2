import { getTranslations } from 'next-intl/server';

import { Link } from '@/core/i18n/navigation';
import { SmartIcon } from '@/shared/blocks/common/smart-icon';
import { cn } from '@/shared/lib/utils';

import { AdminOverviewSignals } from '../../server/admin-overview';

interface SignalCard {
  key: string;
  value: number;
  icon: string;
  href?: string;
  /** 非 0 时用 destructive 色（仅资金对账卡片开启）。 */
  alertWhenNonZero?: boolean;
}

/**
 * 后台首页运维信号卡片。展示逻辑放在服务端：资金卡片按 `canAdjustQuota`
 * 整卡渲染，读列表的跳转链接按各自读权限出现（无权则只显示数字不给死链）。
 */
export async function AdminOverview({
  signals,
  canAdjustQuota,
  canReadUsers,
  canReadCatalog,
}: {
  signals: AdminOverviewSignals;
  canAdjustQuota: boolean;
  canReadUsers: boolean;
  canReadCatalog: boolean;
}) {
  const t = await getTranslations('admin.overview');

  const cards: SignalCard[] = [];

  if (canAdjustQuota) {
    cards.push({
      key: 'reconciliation',
      value: signals.reconciliationRequired,
      icon: 'AlertTriangle',
      alertWhenNonZero: true,
      // 结清入口在用户详情页的账本行上（R-7），先把告警落到具体的人
      href: canReadUsers ? '/admin/users?ledger=unresolved' : undefined,
    });
    cards.push({
      key: 'pendingAdjustments',
      value: signals.pendingManualAdjustments,
      icon: 'Clock',
      href: '/admin/apipool-adjustments',
    });
  }

  cards.push({
    key: 'syncIssues',
    value: signals.bindingSyncIssues,
    icon: 'UserX',
    href: canReadUsers ? '/admin/users' : undefined,
  });

  cards.push({
    key: 'priceDrift',
    value: signals.priceDriftListings,
    icon: 'EyeOff',
    href: canReadCatalog ? '/admin/catalog/models' : undefined,
  });

  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      {cards.map((card) => {
        const isAlert = Boolean(card.alertWhenNonZero) && card.value > 0;
        const inner = (
          <div
            className={cn(
              'bg-card flex h-full flex-col rounded-xl border p-5 transition-colors',
              isAlert && 'border-destructive/50',
              card.href &&
                'group-hover:border-primary/60 group-focus-visible:border-primary/60'
            )}
          >
            <div className="mb-3 flex items-center justify-between gap-3">
              <div className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
                {t(`cards.${card.key}.title`)}
              </div>
              <SmartIcon
                name={card.icon}
                size={16}
                className={
                  isAlert ? 'text-destructive' : 'text-muted-foreground'
                }
              />
            </div>
            <div
              className={cn(
                'font-mono text-3xl font-semibold tracking-tight',
                isAlert && 'text-destructive'
              )}
            >
              {card.value}
            </div>
            <div className="text-muted-foreground mt-2 text-xs">
              {t(`cards.${card.key}.description`)}
            </div>
            {card.href && (
              <div className="text-primary mt-4 flex items-center gap-1 text-xs font-medium">
                {t('viewAction')}
                <SmartIcon name="ArrowRight" size={12} />
              </div>
            )}
          </div>
        );

        if (card.href) {
          return (
            <Link
              key={card.key}
              href={card.href}
              className="group block rounded-xl focus-visible:outline-none"
            >
              {inner}
            </Link>
          );
        }

        return <div key={card.key}>{inner}</div>;
      })}
    </div>
  );
}
