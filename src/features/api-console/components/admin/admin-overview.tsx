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
  /** 非 0 时使用告警色。 */
  alertWhenNonZero?: boolean;
}

/**
 * 后台首页运维信号卡片。钱包卡片统一跳到 APIPool 调额入口。
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
      key: 'negativeWallets',
      value: signals.negativeWallets,
      icon: 'AlertTriangle',
      alertWhenNonZero: true,
      href: '/admin/apipool-adjustments',
    });
    cards.push({
      key: 'frozenWallets',
      value: signals.frozenWallets,
      icon: 'Lock',
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
              'bg-card flex h-full flex-col rounded-xl border p-5 shadow-sm transition-colors',
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
