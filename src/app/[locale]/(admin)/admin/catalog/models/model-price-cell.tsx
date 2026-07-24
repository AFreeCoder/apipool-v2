'use client';

import { Info } from 'lucide-react';

import type {
  ModelAdminPrice,
  ModelAdminPriceMeter,
  ModelAdminPriceMeterKey,
} from '@/features/api-catalog/server/catalog-service';
import {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from '@/shared/components/ui/hover-card';

export type ModelPriceLabels = {
  detail: string;
  empty: string;
  perCall: string;
  inputShort: string;
  outputShort: string;
  sectionBase: string;
  sectionLong: string;
  threshold: string;
  meterLabels: Record<ModelAdminPriceMeterKey, string>;
};

function MeterRows({
  meters,
  meterLabels,
}: {
  meters: ModelAdminPriceMeter[];
  meterLabels: Record<ModelAdminPriceMeterKey, string>;
}) {
  return (
    <dl className="space-y-1">
      {meters.map((meter) => (
        <div
          key={meter.key}
          className="flex items-baseline justify-between gap-4 text-xs"
        >
          <dt className="text-muted-foreground">
            {meterLabels[meter.key] ?? meter.key}
          </dt>
          <dd className="font-mono tabular-nums">${meter.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function ModelPriceCell({
  price,
  labels,
}: {
  price: ModelAdminPrice;
  labels: ModelPriceLabels;
}) {
  if (!price.hasPrice) {
    return <span className="text-muted-foreground">{labels.empty}</span>;
  }

  const isPerCall = price.billingScheme === 'per_call';
  const hasLongSection =
    price.longMeters.length > 0 || price.longContextThresholdTokens !== null;

  const summary = isPerCall ? (
    <span className="font-mono text-xs tabular-nums">
      {labels.perCall}
      {price.fixedPrice ? ` $${price.fixedPrice}` : ''}
    </span>
  ) : (
    <span className="font-mono text-xs tabular-nums">
      {price.inputSummary ? `${labels.inputShort} $${price.inputSummary}` : ''}
      {price.inputSummary && price.outputSummary ? ' · ' : ''}
      {price.outputSummary
        ? `${labels.outputShort} $${price.outputSummary}`
        : ''}
    </span>
  );

  return (
    <div className="flex items-center gap-2">
      {summary}
      <HoverCard openDelay={80} closeDelay={120}>
        <HoverCardTrigger asChild>
          <button
            type="button"
            className="text-muted-foreground hover:text-foreground focus-visible:ring-ring inline-flex shrink-0 items-center gap-1 rounded text-xs underline decoration-dotted underline-offset-2 focus:outline-none focus-visible:ring-2"
          >
            <Info className="size-3.5" />
            {labels.detail}
          </button>
        </HoverCardTrigger>
        <HoverCardContent align="end" className="w-72">
          {price.baseMeters.length > 0 && (
            <section>
              <h4 className="text-muted-foreground mb-1.5 text-[11px] font-medium tracking-wide uppercase">
                {labels.sectionBase}
              </h4>
              <MeterRows
                meters={price.baseMeters}
                meterLabels={labels.meterLabels}
              />
            </section>
          )}
          {hasLongSection && (
            <section className={price.baseMeters.length > 0 ? 'mt-3' : ''}>
              <h4 className="text-muted-foreground mb-1.5 text-[11px] font-medium tracking-wide uppercase">
                {labels.sectionLong}
              </h4>
              {price.longContextThresholdTokens !== null && (
                <div className="flex items-baseline justify-between gap-4 text-xs">
                  <dt className="text-muted-foreground">{labels.threshold}</dt>
                  <dd className="font-mono tabular-nums">
                    {price.longContextThresholdTokens.toLocaleString('en-US')}
                  </dd>
                </div>
              )}
              {price.longMeters.length > 0 && (
                <div className="mt-1">
                  <MeterRows
                    meters={price.longMeters}
                    meterLabels={labels.meterLabels}
                  />
                </div>
              )}
            </section>
          )}
        </HoverCardContent>
      </HoverCard>
    </div>
  );
}
