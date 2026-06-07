import {
  buildModelFilterHref,
  filterModels,
  formatModelPrice,
  MODEL_CAPABILITY_FILTERS,
  MODEL_PROVIDER_FILTERS,
  MODEL_STATUS_FILTERS,
  parseModelFilters,
  publicModels,
} from '@/features/api-catalog/lib/catalog';
import {
  ArrowRight,
  CircleDollarSign,
  Layers3,
  SlidersHorizontal,
} from 'lucide-react';
import { setRequestLocale } from 'next-intl/server';

import { Link } from '@/core/i18n/navigation';
import { Badge } from '@/shared/components/ui/badge';
import { Button } from '@/shared/components/ui/button';

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
    {
      label: 'Provider',
      key: 'provider',
      options: MODEL_PROVIDER_FILTERS,
    },
    {
      label: 'Capability',
      key: 'capability',
      options: MODEL_CAPABILITY_FILTERS,
    },
    {
      label: 'Status',
      key: 'status',
      options: MODEL_STATUS_FILTERS,
    },
  ] as const;

  return (
    <div className="bg-background">
      <section className="border-border/70 border-b py-12 sm:py-16">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="grid gap-8 lg:grid-cols-[1fr_0.7fr] lg:items-end">
            <div>
              <div className="bg-muted/50 text-muted-foreground inline-flex w-fit items-center gap-2 rounded-full border px-3 py-1 text-xs">
                <Layers3 className="text-primary size-3" />
                Model Market
              </div>
              <h1 className="mt-5 text-4xl leading-tight font-semibold tracking-normal sm:text-5xl">
                AI models through one APIPool API
              </h1>
              <p className="text-muted-foreground mt-4 max-w-2xl text-base leading-7 sm:text-lg">
                Compare launch-ready and candidate models by provider,
                capability, status, and reference pricing before routing real
                calls.
              </p>
            </div>
            <div className="grid grid-cols-3 gap-3 text-sm">
              {[
                ['6', 'Catalog models'],
                ['2', 'Providers'],
                ['1', 'Ready route'],
              ].map(([value, label]) => (
                <div key={label} className="bg-card rounded-xl border p-4">
                  <div className="text-2xl font-semibold">{value}</div>
                  <div className="text-muted-foreground mt-1 text-xs">
                    {label}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </section>

      <section className="border-border/70 border-b">
        <div className="mx-auto max-w-7xl px-4 py-6 sm:px-6 lg:px-8">
          <div className="mb-4 flex items-center gap-2 text-sm font-medium">
            <SlidersHorizontal className="size-4" />
            Filters
          </div>
          <div className="space-y-3">
            {filterGroups.map((group) => (
              <div
                key={group.key}
                className="flex flex-wrap items-center gap-2"
              >
                <span className="text-muted-foreground w-24 text-sm">
                  {group.label}
                </span>
                {group.options.map((option) => {
                  const active = filters[group.key] === option;

                  return (
                    <Button
                      key={option}
                      asChild
                      size="sm"
                      variant={active ? 'default' : 'outline'}
                      className="rounded-md"
                    >
                      <Link
                        href={buildModelFilterHref(filters, {
                          [group.key]: option,
                        })}
                      >
                        {option}
                      </Link>
                    </Button>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="py-12 sm:py-14">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          {models.length === 0 ? (
            <div className="bg-card rounded-xl border p-10 text-center">
              <div className="font-medium">No models match these filters.</div>
              <Button asChild variant="outline" className="mt-4 rounded-md">
                <Link href="/models">Clear filters</Link>
              </Button>
            </div>
          ) : (
            <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
              {models.map((model) => {
                const price = formatModelPrice(model);

                return (
                  <Link
                    key={model.slug}
                    href={`/models/${model.slug}`}
                    className="group bg-card hover:border-primary/40 flex min-h-72 flex-col rounded-xl border p-5 transition hover:shadow-md"
                  >
                    <div className="flex items-start justify-between gap-4">
                      <div>
                        <div className="text-muted-foreground text-sm">
                          {model.provider}
                        </div>
                        <h2 className="mt-2 text-xl leading-7 font-semibold">
                          {model.displayName}
                        </h2>
                        <div className="text-muted-foreground mt-2 font-mono text-xs">
                          {model.modelId}
                        </div>
                      </div>
                      <Badge
                        variant={
                          model.status === 'available' ? 'default' : 'secondary'
                        }
                      >
                        {model.status === 'available'
                          ? 'Available'
                          : 'Coming soon'}
                      </Badge>
                    </div>

                    <p className="text-muted-foreground mt-5 min-h-16 text-sm leading-6">
                      {model.shortDescription}
                    </p>

                    <div className="mt-5 flex flex-wrap gap-2">
                      {model.capabilities.map((capability) => (
                        <span
                          key={capability}
                          className="bg-muted/40 text-muted-foreground rounded-md border px-2 py-1 text-xs"
                        >
                          {capability}
                        </span>
                      ))}
                    </div>

                    <div className="mt-auto pt-6">
                      <div className="bg-muted/40 rounded-lg border p-4">
                        <div className="text-muted-foreground mb-3 flex items-center gap-2 text-xs font-medium">
                          <CircleDollarSign className="size-4" />
                          Reference pricing
                        </div>
                        <div className="grid gap-2 text-sm">
                          <div className="flex justify-between gap-4">
                            <span className="text-muted-foreground">Input</span>
                            <span>{price.input}</span>
                          </div>
                          <div className="flex justify-between gap-4">
                            <span className="text-muted-foreground">
                              Output
                            </span>
                            <span>{price.output}</span>
                          </div>
                        </div>
                      </div>
                      <div className="text-primary mt-4 inline-flex items-center gap-2 text-sm font-medium">
                        View details
                        <ArrowRight className="size-4 transition group-hover:translate-x-1" />
                      </div>
                    </div>
                  </Link>
                );
              })}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}
