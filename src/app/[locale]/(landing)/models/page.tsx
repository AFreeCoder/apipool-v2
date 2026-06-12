import {
  buildModelFilterHref,
  filterModels,
  MODEL_CAPABILITY_FILTERS,
  MODEL_PROVIDER_FILTERS,
  MODEL_STATUS_FILTERS,
  parseModelFilters,
  publicModels,
} from '@/features/api-catalog/lib/catalog';
import { setRequestLocale } from 'next-intl/server';

import { Link } from '@/core/i18n/navigation';
import {
  APIPOOL_CONFIG,
  PRICE_DISCLAIMER_EN,
  PRICE_DISCLAIMER_ZH,
} from '@/config/apipool';
import { Badge } from '@/shared/components/ui/badge';
import { Button } from '@/shared/components/ui/button';

function formatContextWindow(tokens: number) {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(0)}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`;
  return String(tokens);
}

const FILTER_OPTION_LABELS: Record<string, string> = {
  available: 'Available',
  coming_soon: 'Coming soon',
};

function formatFilterOption(option: string) {
  return (
    FILTER_OPTION_LABELS[option] ||
    option.charAt(0).toUpperCase() + option.slice(1)
  );
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
  const models = filterModels(publicModels, filters);
  const filterGroups = [
    { label: 'Provider', key: 'provider', options: MODEL_PROVIDER_FILTERS },
    {
      label: 'Capability',
      key: 'capability',
      options: MODEL_CAPABILITY_FILTERS,
    },
    { label: 'Status', key: 'status', options: MODEL_STATUS_FILTERS },
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
            All prices are per 1M tokens, billed by actual usage through{' '}
            <code className="bg-muted rounded border px-1.5 py-0.5 font-mono text-xs">
              {APIPOOL_CONFIG.apiBaseUrl}
            </code>
            .
          </p>

          <div className="mt-8 space-y-2">
            {filterGroups.map((group) => (
              <div key={group.key} className="flex flex-wrap items-center gap-1.5">
                <span className="text-muted-foreground w-20 shrink-0 text-xs tracking-wide uppercase">
                  {group.label}
                </span>
                {group.options.map((option) => {
                  const active = filters[group.key] === option;
                  return (
                    <Link
                      key={option}
                      href={buildModelFilterHref(filters, {
                        [group.key]: option,
                      })}
                      className={
                        active
                          ? 'bg-primary text-primary-foreground focus-visible:ring-ring rounded-md px-2.5 py-1 text-xs font-medium focus-visible:ring-2 focus-visible:outline-none'
                          : 'text-muted-foreground hover:text-foreground hover:bg-muted focus-visible:ring-ring rounded-md border px-2.5 py-1 text-xs transition-colors focus-visible:ring-2 focus-visible:outline-none'
                      }
                    >
                      {formatFilterOption(option)}
                    </Link>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="py-10 sm:py-12">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          {models.length === 0 ? (
            <div className="rounded-xl border p-10 text-center">
              <div className="font-medium">No models match these filters.</div>
              <Button asChild variant="outline" className="mt-4 rounded-md">
                <Link href="/models">Clear filters</Link>
              </Button>
            </div>
          ) : (
            <div className="overflow-x-auto rounded-xl border">
              <table className="w-full min-w-[760px] text-sm">
                <thead>
                  <tr className="bg-muted text-muted-foreground border-b text-xs uppercase">
                    <th className="px-4 py-3 text-left font-medium">Model</th>
                    <th className="px-4 py-3 text-left font-medium">
                      Provider
                    </th>
                    <th className="px-4 py-3 text-left font-medium">
                      Capabilities
                    </th>
                    <th className="px-4 py-3 text-right font-medium">
                      Context
                    </th>
                    <th className="px-4 py-3 text-right font-medium">
                      Input / 1M
                    </th>
                    <th className="px-4 py-3 text-right font-medium">
                      Output / 1M
                    </th>
                    <th className="px-4 py-3 text-right font-medium">
                      Status
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {models.map((model) => {
                    const official = model.pricing.officialInputPerMillionUsd;
                    return (
                      <tr
                        key={model.slug}
                        className="hover:bg-muted/50 border-b transition-colors last:border-b-0"
                      >
                        <td className="px-4 py-3">
                          <div className="font-medium">
                            {model.displayName}
                          </div>
                          <div className="text-muted-foreground font-mono text-xs">
                            {model.modelId}
                          </div>
                        </td>
                        <td className="text-muted-foreground px-4 py-3">
                          {model.provider}
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex flex-wrap gap-1">
                            {model.capabilities.map((capability) => (
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
                          {formatContextWindow(model.contextWindow)}
                        </td>
                        <td className="px-4 py-3 text-right font-mono">
                          ${model.pricing.inputPerMillionUsd.toFixed(2)}
                          {official !== undefined && (
                            <div className="text-muted-foreground text-xs line-through">
                              ${official.toFixed(2)}
                            </div>
                          )}
                        </td>
                        <td className="px-4 py-3 text-right font-mono">
                          ${model.pricing.outputPerMillionUsd.toFixed(2)}
                          {model.pricing.officialOutputPerMillionUsd !==
                            undefined && (
                            <div className="text-muted-foreground text-xs line-through">
                              $
                              {model.pricing.officialOutputPerMillionUsd.toFixed(
                                2
                              )}
                            </div>
                          )}
                        </td>
                        <td className="px-4 py-3 text-right">
                          <Badge
                            variant={
                              model.status === 'available'
                                ? 'default'
                                : 'secondary'
                            }
                            className={
                              model.status === 'available'
                                ? 'bg-primary/10 text-primary border-transparent'
                                : ''
                            }
                          >
                            {model.status === 'available'
                              ? 'Available'
                              : 'Coming soon'}
                          </Badge>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          <p className="text-muted-foreground mt-3 text-xs">
            {locale === 'zh' ? PRICE_DISCLAIMER_ZH : PRICE_DISCLAIMER_EN}
          </p>
        </div>
      </section>
    </div>
  );
}
