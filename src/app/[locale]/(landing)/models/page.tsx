import {
  ModelFilters,
  type ModelFilterGroup,
} from '@/features/api-catalog/components/model-filters';
import {
  buildModelFilterHref,
  formatMicroUsdPerCall,
  formatMicroUsdPerMillion,
  parseModelFilters,
} from '@/features/api-catalog/lib/catalog';
import { formatDecimal } from '@/features/api-catalog/lib/pricing';
import type { ListingRow } from '@/features/api-catalog/lib/types';
import {
  getFilterDimensions,
  getPublicListings,
} from '@/features/api-catalog/server/queries';
import { getTranslations, setRequestLocale } from 'next-intl/server';

import { Link } from '@/core/i18n/navigation';
import { PRICE_DISCLAIMER_EN, PRICE_DISCLAIMER_ZH } from '@/config/apipool';
import { Badge } from '@/shared/components/ui/badge';
import { Button } from '@/shared/components/ui/button';
import { getMetadata } from '@/shared/lib/seo';

function formatContextWindow(tokens: number | null) {
  if (!tokens) return '—';
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(0)}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`;
  return String(tokens);
}

type CatalogDimension = 'groups' | 'categories' | 'capabilities' | 'statuses';

type CatalogDimensionMessages = Partial<
  Record<CatalogDimension, Record<string, string>>
>;

function localizeCatalogDimension(
  messages: CatalogDimensionMessages,
  dimension: CatalogDimension,
  slug: string,
  fallback: string
) {
  return messages[dimension]?.[slug] ?? fallback;
}

// /models 是唯一核心可索引的营销页。没有页面级 metadata 时 canonical 回退到
// 站点根，搜索引擎会把它归并到首页，社交分享也拿不到页面标题。
export const generateMetadata = getMetadata({
  metadataKey: 'pages.models.metadata',
  canonicalUrl: '/models',
});

export default async function ModelsPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations({ locale, namespace: 'pages.models' });
  const filters = parseModelFilters(await searchParams);
  const [listings, dimensions] = await Promise.all([
    getPublicListings(filters),
    getFilterDimensions(),
  ]);
  const dimensionMessages = t.raw('dimensions') as CatalogDimensionMessages;
  const localizeOption = (
    dimension: CatalogDimension,
    option: { slug: string; name: string }
  ) => ({
    ...option,
    name: localizeCatalogDimension(
      dimensionMessages,
      dimension,
      option.slug,
      option.name
    ),
  });
  const localizedListings = listings.map((listing) => ({
    ...listing,
    groupName: localizeCatalogDimension(
      dimensionMessages,
      'groups',
      listing.groupSlug,
      listing.groupName
    ),
    category: localizeCatalogDimension(
      dimensionMessages,
      'categories',
      listing.category,
      listing.category
    ),
    capabilities: listing.capabilities.map((capability) =>
      localizeCatalogDimension(
        dimensionMessages,
        'capabilities',
        capability,
        capability
      )
    ),
    statusName: localizeCatalogDimension(
      dimensionMessages,
      'statuses',
      listing.statusSlug,
      listing.statusName
    ),
  }));
  const filterGroups: ModelFilterGroup[] = (
    [
      {
        label: t('filters.provider'),
        key: 'vendor',
        options: dimensions.vendors,
      },
      {
        label: t('filters.group'),
        key: 'group',
        options: dimensions.groups.map((option) =>
          localizeOption('groups', option)
        ),
      },
      {
        label: t('filters.category'),
        key: 'category',
        options: dimensions.categories.map((option) =>
          localizeOption('categories', option)
        ),
      },
      {
        label: t('filters.capability'),
        key: 'capability',
        options: dimensions.capabilities.map((option) =>
          localizeOption('capabilities', option)
        ),
      },
      {
        label: t('filters.status'),
        key: 'status',
        options: dimensions.statuses.map((option) =>
          localizeOption('statuses', option)
        ),
      },
    ] as const
  ).map((group) => ({
    key: group.key,
    label: group.label,
    allHref: buildModelFilterHref(filters, { [group.key]: undefined }),
    activeName:
      group.options.find((option) => option.slug === filters[group.key])
        ?.name ?? null,
    options: group.options.map((option) => ({
      slug: option.slug,
      name: option.name,
      href: buildModelFilterHref(filters, { [group.key]: option.slug }),
      active: filters[group.key] === option.slug,
    })),
  }));

  return (
    <div className="bg-background">
      {/* 标题 + 筛选：全量筛选清单平铺（供应商/分组/分类/能力/状态），不放 hero */}
      <section className="border-border border-b">
        <div className="mx-auto max-w-7xl px-4 py-10 sm:px-6 lg:px-8">
          <div className="text-primary font-mono text-xs tracking-widest uppercase">
            {t('eyebrow')}
          </div>
          <h1 className="mt-3 text-3xl font-semibold tracking-tight sm:text-4xl">
            {t('title')}
          </h1>
          <p className="text-muted-foreground mt-3 max-w-2xl leading-7">
            {t('description')}
          </p>

          <div className="mt-6">
            <ModelFilters
              groups={filterGroups}
              allLabel={t('filters.all')}
              clearLabel={t('filters.clear')}
              clearHref="/models"
            />
          </div>
        </div>
      </section>

      <section className="space-y-10 py-10 sm:py-12">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          {listings.length === 0 ? (
            <div className="rounded-xl border p-10 text-center">
              <div className="font-medium">{t('empty.title')}</div>
              <Button asChild variant="outline" className="mt-4 rounded-md">
                <Link href="/models">{t('empty.clear')}</Link>
              </Button>
            </div>
          ) : (
            <ModelsTable
              listings={localizedListings}
              labels={t.raw('table')}
              formatDiscount={(discountBps) =>
                t('table.discount', {
                  fold: formatDecimal(discountBps / 1000),
                  percent: formatDecimal(discountBps / 100),
                  off: formatDecimal((10000 - discountBps) / 100),
                })
              }
            />
          )}
          <p className="text-muted-foreground mt-3 text-xs">
            {locale === 'zh' ? PRICE_DISCLAIMER_ZH : PRICE_DISCLAIMER_EN}
          </p>
        </div>
      </section>
    </div>
  );
}

function ModelsTable({
  listings,
  labels,
  formatDiscount,
}: {
  listings: ListingRow[];
  labels: Record<string, string>;
  // 折扣文案按 locale 渲染：中文是「9 折 (90%)」，英文是「10% off」。
  // 服务层只回传 discountBps，绝不产出预格式化的单语字符串。
  formatDiscount: (discountBps: number) => string;
}) {
  if (listings.length === 0) return null;

  return (
    <>
      <p className="text-muted-foreground mb-2 text-xs min-[960px]:hidden">
        {labels.mobileHint}
      </p>
      <div className="relative">
        <div className="overflow-x-auto rounded-xl border">
          <table className="w-full min-w-[920px] text-sm">
            <thead>
              <tr className="bg-muted text-muted-foreground border-b text-xs uppercase">
                <th className="px-4 py-3 text-left font-medium">
                  {labels.model}
                </th>
                <th className="px-4 py-3 text-left font-medium">
                  {labels.provider}
                </th>
                <th className="px-4 py-3 text-left font-medium">
                  {labels.group}
                </th>
                <th className="px-4 py-3 text-left font-medium">
                  {labels.category}
                </th>
                <th className="px-4 py-3 text-left font-medium">
                  {labels.capabilities}
                </th>
                <th className="px-4 py-3 text-right font-medium">
                  {labels.context}
                </th>
                <th className="px-4 py-3 text-right font-medium">
                  {labels.inputOrCall}
                </th>
                <th className="px-4 py-3 text-right font-medium">
                  {labels.output}
                </th>
                <th className="px-4 py-3 text-right font-medium">
                  {labels.status}
                </th>
              </tr>
            </thead>
            <tbody>
              {listings.map((listing) => {
                const showConfirmedPrice =
                  listing.pricePresentation?.showPrice === true;
                const showStrikethrough =
                  showConfirmedPrice &&
                  listing.pricePresentation?.showStrikethrough === true;
                const inputPrice =
                  showConfirmedPrice &&
                  listing.effectiveInputMicroUsd !== undefined
                    ? listing.effectiveInputMicroUsd
                    : undefined;
                const outputPrice =
                  showConfirmedPrice &&
                  listing.effectiveOutputMicroUsd !== undefined
                    ? listing.effectiveOutputMicroUsd
                    : undefined;

                return (
                  <tr
                    key={`${listing.modelId}:${listing.groupSlug}`}
                    className="hover:bg-muted/50 border-b transition-colors last:border-b-0"
                  >
                    <td className="px-4 py-3">
                      <div className="font-medium">{listing.displayName}</div>
                      <div className="text-muted-foreground font-mono text-xs">
                        {listing.modelId}
                      </div>
                      {listing.description && (
                        <div className="text-muted-foreground mt-1 text-xs">
                          {listing.description}
                        </div>
                      )}
                    </td>
                    <td className="text-muted-foreground px-4 py-3">
                      {listing.vendorName}
                    </td>
                    <td className="text-muted-foreground px-4 py-3">
                      {listing.groupName}
                    </td>
                    <td className="text-muted-foreground px-4 py-3">
                      {listing.category}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap gap-1">
                        {listing.capabilities.map((capability) => (
                          <span
                            key={capability}
                            className="bg-muted text-muted-foreground rounded-md px-1.5 py-0.5 text-xs"
                          >
                            {capability}
                          </span>
                        ))}
                      </div>
                    </td>
                    <td className="text-muted-foreground px-4 py-3 text-right font-mono">
                      {formatContextWindow(listing.contextWindow)}
                    </td>
                    <td className="px-4 py-3 text-right font-mono">
                      {listing.billingScheme === 'per_call' ? (
                        <div className="space-y-1 text-xs">
                          {(listing.tiers ?? []).map((tier) => (
                            <div key={tier.skuKey}>
                              <div className="text-muted-foreground break-all">
                                {tier.skuKey}
                              </div>
                              <div>
                                {formatMicroUsdPerCall(
                                  tier.priceMicroUsd,
                                  labels.perCall
                                )}
                              </div>
                            </div>
                          ))}
                        </div>
                      ) : inputPrice === undefined ? (
                        '—'
                      ) : (
                        formatMicroUsdPerMillion(inputPrice)
                      )}
                      {listing.billingScheme !== 'per_call' &&
                        showStrikethrough &&
                        listing.listInputMicroUsd !== undefined && (
                          <div className="text-muted-foreground text-xs line-through">
                            {formatMicroUsdPerMillion(
                              listing.listInputMicroUsd
                            )}
                          </div>
                        )}
                    </td>
                    <td className="px-4 py-3 text-right font-mono">
                      {outputPrice === undefined
                        ? '—'
                        : formatMicroUsdPerMillion(outputPrice)}
                      {showStrikethrough &&
                        listing.listOutputMicroUsd !== undefined && (
                          <div className="text-muted-foreground text-xs line-through">
                            {formatMicroUsdPerMillion(
                              listing.listOutputMicroUsd
                            )}
                          </div>
                        )}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Badge
                        variant={listing.isCallable ? 'default' : 'secondary'}
                        className={
                          listing.isCallable
                            ? 'bg-primary/10 text-primary border-transparent'
                            : ''
                        }
                      >
                        {listing.statusName}
                      </Badge>
                      {listing.pricePresentation?.discountBps ? (
                        <div className="text-muted-foreground mt-1 text-xs">
                          {formatDiscount(
                            listing.pricePresentation.discountBps
                          )}
                        </div>
                      ) : null}
                      {listing.pricePresentation?.note && (
                        <div className="text-muted-foreground mt-1 text-xs">
                          {listing.pricePresentation.note}
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <div className="from-background pointer-events-none absolute inset-y-0 right-0 w-12 rounded-r-xl bg-gradient-to-l to-transparent min-[960px]:hidden" />
      </div>
    </>
  );
}
