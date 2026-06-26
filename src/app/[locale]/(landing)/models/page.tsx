import {
  buildModelFilterHref,
  formatMicroUsdPerMillion,
  parseModelFilters,
} from '@/features/api-catalog/lib/catalog';
import type { ListingRow } from '@/features/api-catalog/lib/types';
import {
  getFilterDimensions,
  getPublicListings,
} from '@/features/api-catalog/server/queries';
import { setRequestLocale } from 'next-intl/server';

import { Link } from '@/core/i18n/navigation';
import { PRICE_DISCLAIMER_EN, PRICE_DISCLAIMER_ZH } from '@/config/apipool';
import { Badge } from '@/shared/components/ui/badge';
import { Button } from '@/shared/components/ui/button';

function formatContextWindow(tokens: number | null) {
  if (!tokens) return '—';
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(0)}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`;
  return String(tokens);
}

export default async function ModelsPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const filters = parseModelFilters(await searchParams);
  const [listings, dimensions] = await Promise.all([
    getPublicListings(filters),
    getFilterDimensions(),
  ]);
  const filterGroups = [
    { label: 'Provider', key: 'vendor', options: dimensions.vendors },
    { label: 'Group', key: 'group', options: dimensions.groups },
    {
      label: 'Capability',
      key: 'capability',
      options: dimensions.capabilities,
    },
    { label: 'Status', key: 'status', options: dimensions.statuses },
  ] as const;

  return (
    <div className="bg-background">
      {/* 标题 + 筛选：首屏即见表格，不放 hero */}
      <section className="border-border border-b">
        <div className="mx-auto max-w-7xl px-4 py-10 sm:px-6 lg:px-8">
          <div className="text-primary font-mono text-xs tracking-widest uppercase">
            {'// models & pricing'}
          </div>
          <h1 className="mt-3 text-3xl font-semibold tracking-tight sm:text-4xl">
            Models & pricing
          </h1>
          <p className="text-muted-foreground mt-3 max-w-2xl leading-7">
            All prices are per 1M tokens, billed by actual usage. One key works
            for every model below.
          </p>

          <div className="mt-8 space-y-2">
            {filterGroups.map((group) => (
              <div
                key={group.key}
                className="flex flex-wrap items-center gap-1.5"
              >
                <span className="text-muted-foreground w-20 shrink-0 text-xs tracking-wide uppercase">
                  {group.label}
                </span>
                <FilterLink
                  active={!filters[group.key]}
                  href={buildModelFilterHref(filters, {
                    [group.key]: undefined,
                  })}
                >
                  All
                </FilterLink>
                {group.options.map((option) => {
                  const active = filters[group.key] === option.slug;
                  return (
                    <FilterLink
                      key={option.slug}
                      active={active}
                      href={buildModelFilterHref(filters, {
                        [group.key]: option.slug,
                      })}
                    >
                      {option.name}
                    </FilterLink>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="space-y-10 py-10 sm:py-12">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          {listings.length === 0 ? (
            <div className="rounded-xl border p-10 text-center">
              <div className="font-medium">No models match these filters.</div>
              <Button asChild variant="outline" className="mt-4 rounded-md">
                <Link href="/models">Clear filters</Link>
              </Button>
            </div>
          ) : (
            <ModelsTable listings={listings} />
          )}
          <p className="text-muted-foreground mt-3 text-xs">
            {locale === 'zh' ? PRICE_DISCLAIMER_ZH : PRICE_DISCLAIMER_EN}
          </p>
        </div>
      </section>
    </div>
  );
}

function FilterLink({
  active,
  href,
  children,
}: {
  active: boolean;
  href: string;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className={
        active
          ? 'bg-primary text-primary-foreground focus-visible:ring-ring rounded-md px-2.5 py-1 text-xs font-medium focus-visible:ring-2 focus-visible:outline-none'
          : 'text-muted-foreground hover:text-foreground hover:bg-muted focus-visible:ring-ring rounded-md border px-2.5 py-1 text-xs transition-colors focus-visible:ring-2 focus-visible:outline-none'
      }
    >
      {children}
    </Link>
  );
}

function ModelsTable({ listings }: { listings: ListingRow[] }) {
  if (listings.length === 0) return null;

  return (
    <div className="overflow-x-auto rounded-xl border">
      <table className="w-full min-w-[920px] text-sm">
        <thead>
          <tr className="bg-muted text-muted-foreground border-b text-xs uppercase">
            <th className="px-4 py-3 text-left font-medium">Model</th>
            <th className="px-4 py-3 text-left font-medium">Provider</th>
            <th className="px-4 py-3 text-left font-medium">Group</th>
            <th className="px-4 py-3 text-left font-medium">Capabilities</th>
            <th className="px-4 py-3 text-right font-medium">Context</th>
            <th className="px-4 py-3 text-right font-medium">Input·1M</th>
            <th className="px-4 py-3 text-right font-medium">Output·1M</th>
            <th className="px-4 py-3 text-right font-medium">Status</th>
          </tr>
        </thead>
        <tbody>
          {listings.map((listing) => {
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
                  {formatMicroUsdPerMillion(listing.inputMicroUsd)}
                  {listing.listInputMicroUsd !== undefined && (
                    <div className="text-muted-foreground text-xs line-through">
                      {formatMicroUsdPerMillion(listing.listInputMicroUsd)}
                    </div>
                  )}
                </td>
                <td className="px-4 py-3 text-right font-mono">
                  {formatMicroUsdPerMillion(listing.outputMicroUsd)}
                  {listing.listOutputMicroUsd !== undefined && (
                    <div className="text-muted-foreground text-xs line-through">
                      {formatMicroUsdPerMillion(listing.listOutputMicroUsd)}
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
                  {listing.discountNote && (
                    <div className="text-muted-foreground mt-1 text-xs">
                      {listing.discountNote}
                    </div>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
