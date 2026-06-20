import {
  buildModelFilterHref,
  filterModels,
  isDealModel,
  MODEL_CAPABILITY_FILTERS,
  MODEL_PROVIDER_FILTERS,
  MODEL_STATUS_FILTERS,
  parseModelFilters,
  publicModels,
} from '@/features/api-catalog/lib/catalog';
import { setRequestLocale } from 'next-intl/server';

import { Link } from '@/core/i18n/navigation';
import { getApipoolCopy, type ApipoolCopy } from '@/features/apipool-ui/copy';
import { Badge } from '@/shared/components/ui/badge';
import { Button } from '@/shared/components/ui/button';

function formatContextWindow(tokens: number) {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(0)}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`;
  return String(tokens);
}

function formatFilterOption(
  option: string,
  labels: ApipoolCopy['modelsPage']['options']
) {
  return (
    labels[option as keyof typeof labels] ||
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
  const copy = getApipoolCopy(locale).modelsPage;
  const filters = parseModelFilters(await searchParams);
  const models = filterModels(publicModels, filters);
  const standardModels = models.filter((model) => !isDealModel(model));
  const dealModels = models.filter(isDealModel);
  const filterGroups = [
    {
      label: copy.filters.provider,
      key: 'provider',
      options: MODEL_PROVIDER_FILTERS,
    },
    {
      label: copy.filters.capability,
      key: 'capability',
      options: MODEL_CAPABILITY_FILTERS,
    },
    { label: copy.filters.status, key: 'status', options: MODEL_STATUS_FILTERS },
  ] as const;

  return (
    <div className="bg-background">
      {/* 标题 + 筛选：首屏即见表格，不放 hero */}
      <section className="border-border border-b">
        <div className="mx-auto max-w-7xl px-4 py-10 sm:px-6 lg:px-8">
          <div className="text-primary font-mono text-xs tracking-widest uppercase">
            {copy.eyebrow}
          </div>
          <h1 className="mt-3 text-3xl font-semibold tracking-tight sm:text-4xl">
            {copy.title}
          </h1>
          <p className="text-muted-foreground mt-3 max-w-2xl leading-7">
            {copy.description}
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
                      {formatFilterOption(option, copy.options)}
                    </Link>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="space-y-10 py-10 sm:py-12">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          {standardModels.length === 0 && dealModels.length === 0 ? (
            <div className="rounded-xl border p-10 text-center">
              <div className="font-medium">{copy.noMatch}</div>
              <Button asChild variant="outline" className="mt-4 rounded-md">
                <Link href="/models">{copy.clearFilters}</Link>
              </Button>
            </div>
          ) : (
            <ModelsTable models={standardModels} copy={copy} />
          )}
          <p className="text-muted-foreground mt-3 text-xs">{copy.disclaimer}</p>
        </div>

        {dealModels.length > 0 && (
          <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
            <div className="mb-4 flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <h2 className="text-xl font-semibold tracking-tight">
                {copy.dealsTitle}
              </h2>
              <p className="text-muted-foreground text-sm">
                {copy.dealsDescription}
              </p>
            </div>
            <ModelsTable models={dealModels} deal copy={copy} />
          </div>
        )}
      </section>
    </div>
  );
}

function ModelsTable({
  models,
  copy,
  deal = false,
}: {
  models: ReturnType<typeof filterModels>;
  copy: ApipoolCopy['modelsPage'];
  deal?: boolean;
}) {
  if (models.length === 0) return null;

  return (
    <div className="overflow-x-auto rounded-xl border">
      <table className="w-full min-w-[760px] text-sm">
        <thead>
          <tr className="bg-muted text-muted-foreground border-b text-xs uppercase">
            <th className="px-4 py-3 text-left font-medium">
              {copy.table.model}
            </th>
            <th className="px-4 py-3 text-left font-medium">
              {copy.table.provider}
            </th>
            <th className="px-4 py-3 text-left font-medium">
              {copy.table.capabilities}
            </th>
            <th className="px-4 py-3 text-right font-medium">
              {copy.table.context}
            </th>
            <th className="px-4 py-3 text-right font-medium">
              {copy.table.input}
            </th>
            <th className="px-4 py-3 text-right font-medium">
              {copy.table.output}
            </th>
            <th className="px-4 py-3 text-right font-medium">
              {copy.table.status}
            </th>
          </tr>
        </thead>
        <tbody>
          {models.map((model) => {
            const officialInput = model.pricing.officialInputPerMillionUsd;
            const officialOutput = model.pricing.officialOutputPerMillionUsd;
            return (
              <tr
                key={model.slug}
                className="hover:bg-muted/50 border-b transition-colors last:border-b-0"
              >
                <td className="px-4 py-3">
                  <div className="flex items-center gap-2 font-medium">
                    {model.displayName}
                    {deal && (
                      <span className="bg-chart-3/15 text-chart-3 rounded-md px-1.5 py-0.5 text-xs font-medium">
                        {copy.dealBadge}
                      </span>
                    )}
                  </div>
                  <div className="text-muted-foreground font-mono text-xs">
                    {model.modelId}
                  </div>
                  {deal && model.dealNote && (
                    <div className="text-muted-foreground mt-1 text-xs">
                      {copy.dealsDescription}
                    </div>
                  )}
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
                        {formatFilterOption(capability, copy.options)}
                      </span>
                    ))}
                  </div>
                </td>
                <td className="text-muted-foreground px-4 py-3 text-right font-mono">
                  {formatContextWindow(model.contextWindow)}
                </td>
                <td className="px-4 py-3 text-right font-mono">
                  ${model.pricing.inputPerMillionUsd.toFixed(2)}
                  {officialInput !== undefined &&
                    officialInput > model.pricing.inputPerMillionUsd && (
                      <div className="text-muted-foreground text-xs line-through">
                        ${officialInput.toFixed(2)}
                      </div>
                    )}
                </td>
                <td className="px-4 py-3 text-right font-mono">
                  ${model.pricing.outputPerMillionUsd.toFixed(2)}
                  {officialOutput !== undefined &&
                    officialOutput > model.pricing.outputPerMillionUsd && (
                      <div className="text-muted-foreground text-xs line-through">
                        ${officialOutput.toFixed(2)}
                      </div>
                    )}
                </td>
                <td className="px-4 py-3 text-right">
                  <Badge
                    variant={
                      model.status === 'available' ? 'default' : 'secondary'
                    }
                    className={
                      model.status === 'available'
                        ? 'bg-primary/10 text-primary border-transparent'
                        : ''
                    }
                  >
                    {model.status === 'available'
                      ? copy.options.available
                      : copy.options.coming_soon}
                  </Badge>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
