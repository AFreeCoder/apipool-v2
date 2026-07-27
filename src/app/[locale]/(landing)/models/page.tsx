import { getTranslations, setRequestLocale } from 'next-intl/server';

import { PRICE_DISCLAIMER_EN, PRICE_DISCLAIMER_ZH } from '@/config/apipool';
import {
  ModelFilters,
  type ModelFilterGroup,
} from '@/features/api-catalog/components/model-filters';
import {
  ModelsCatalog,
  type CatalogRow,
} from '@/features/api-catalog/components/models-catalog';
import {
  buildModelFilterHref,
  formatMicroUsdPerCall,
  formatMicroUsdPerMillion,
  parseModelFilters,
} from '@/features/api-catalog/lib/catalog';
import { formatDecimal } from '@/features/api-catalog/lib/pricing';
import {
  getFilterDimensions,
  getPublicListings,
} from '@/features/api-catalog/server/queries';
import { getMetadata } from '@/shared/lib/seo';

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
  const rawFilters = parseModelFilters(await searchParams);
  const dimensions = await getFilterDimensions();
  // 分组按设计单选、默认「官方」：未指定分组时回退到 official（无则取首个分组），
  // 使表格恒展示单一分组，避免同模型多分组价格无法区分（价格随 Key 的分组生效）。
  const defaultGroupSlug = dimensions.groups.some((g) => g.slug === 'official')
    ? 'official'
    : dimensions.groups[0]?.slug;
  const filters = {
    ...rawFilters,
    group: rawFilters.group ?? defaultGroupSlug,
  };
  const listings = await getPublicListings(filters);
  const dimensionMessages = t.raw('dimensions') as CatalogDimensionMessages;
  const tableLabels = t.raw('table') as Record<string, string>;
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

  // 折扣文案按 locale 渲染（中文「9 折 (90%)」/ 英文「10% off」），服务层只回传
  // discountBps，绝不产出预格式化的单语字符串。
  const formatDiscount = (discountBps: number) =>
    t('table.discount', {
      fold: formatDecimal(discountBps / 1000),
      percent: formatDecimal(discountBps / 100),
      off: formatDecimal((10000 - discountBps) / 100),
    });

  // 服务端把每行的价格/划线/折扣/状态都预格式化成字符串，客户端只做搜索与渲染。
  const rows: CatalogRow[] = listings.map((listing) => {
    const showConfirmedPrice = listing.pricePresentation?.showPrice === true;
    const showStrikethrough =
      showConfirmedPrice &&
      listing.pricePresentation?.showStrikethrough === true;
    const inputPrice =
      showConfirmedPrice && listing.effectiveInputMicroUsd !== undefined
        ? listing.effectiveInputMicroUsd
        : undefined;
    const outputPrice =
      showConfirmedPrice && listing.effectiveOutputMicroUsd !== undefined
        ? listing.effectiveOutputMicroUsd
        : undefined;
    const pricingBasis = listing.pricingBasis ?? 'token';
    const nonToken = pricingBasis !== 'token';

    return {
      key: `${listing.modelId}:${listing.groupSlug}`,
      displayName: listing.displayName,
      modelId: listing.modelId,
      description: listing.description ?? null,
      vendorName: listing.vendorName,
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
      pricingBasis,
      tiers: (listing.tiers ?? []).map((tier) => ({
        skuKey: tier.skuKey,
        price: formatMicroUsdPerCall(
          tier.priceMicroUsd,
          pricingBasis === 'duration'
            ? tableLabels.perSecond
            : tableLabels.perCall
        ),
        originalPrice:
          showStrikethrough && tier.listPriceMicroUsd !== undefined
            ? formatMicroUsdPerCall(
                tier.listPriceMicroUsd,
                pricingBasis === 'duration'
                  ? tableLabels.perSecond
                  : tableLabels.perCall
              )
            : null,
      })),
      inputMain: nonToken
        ? ''
        : inputPrice === undefined
          ? '—'
          : formatMicroUsdPerMillion(inputPrice),
      inputOrig:
        !nonToken &&
        showStrikethrough &&
        listing.listInputMicroUsd !== undefined
          ? formatMicroUsdPerMillion(listing.listInputMicroUsd)
          : null,
      outputMain: nonToken
        ? ''
        : outputPrice === undefined
          ? '—'
          : formatMicroUsdPerMillion(outputPrice),
      outputOrig:
        !nonToken &&
        showStrikethrough &&
        listing.listOutputMicroUsd !== undefined
          ? formatMicroUsdPerMillion(listing.listOutputMicroUsd)
          : null,
      savings: listing.pricePresentation?.discountBps
        ? formatDiscount(listing.pricePresentation.discountBps)
        : null,
      note: listing.pricePresentation?.note ?? null,
      statusName: localizeCatalogDimension(
        dimensionMessages,
        'statuses',
        listing.statusSlug,
        listing.statusName
      ),
      statusSlug: listing.statusSlug,
      // 可用性以发布就绪结果 isCallable 为准：status=available 但未就绪
      // （缺分组映射/锁价/计费配置）的条目不应被展示成正常可用。
      isCallable: listing.isCallable,
      searchText: `${listing.displayName} ${listing.modelId}`.toLowerCase(),
    };
  });

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
    // 分组维度按设计单选、无「全部」；其余维度保留「全部」。
    hideAll: group.key === 'group',
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

  const catalogLabels = {
    model: tableLabels.model,
    provider: tableLabels.provider,
    inputOrCall: tableLabels.inputOrCall,
    output: tableLabels.output,
    savings: tableLabels.savings,
    search: t('filters.search'),
    reset: t('filters.reset'),
    count: t.raw('count') as string,
    emptyTitle: t('empty.title'),
    emptyClear: t('empty.clear'),
    notReady: t('notReady'),
  };

  return (
    <div className="bg-grid bg-muted/20 min-h-screen">
      {/* 标题 */}
      <section className="border-border border-b">
        <div className="mx-auto max-w-7xl px-4 py-14 sm:px-6 lg:px-8">
          <div className="text-primary font-mono text-xs tracking-[0.14em] uppercase">
            {t('eyebrow')}
          </div>
          <h1 className="mt-3 text-3xl font-semibold tracking-tight sm:text-4xl">
            {t('title')}
          </h1>
          <p className="text-muted-foreground mt-3 max-w-2xl leading-7 text-pretty">
            {t('description')}
          </p>
        </div>
      </section>

      {/* 筛选卡 + 价格表 */}
      <section className="mx-auto max-w-7xl px-4 py-10 sm:px-6 lg:px-8">
        <ModelsCatalog rows={rows} labels={catalogLabels} clearHref="/models">
          <ModelFilters
            groups={filterGroups}
            allLabel={t('filters.all')}
            clearLabel={t('filters.clear')}
            clearHref="/models"
          />
        </ModelsCatalog>
        <p className="text-muted-foreground mt-4 text-xs">
          {locale === 'zh' ? PRICE_DISCLAIMER_ZH : PRICE_DISCLAIMER_EN}
        </p>
      </section>
    </div>
  );
}
