'use client';

import { useState } from 'react';
import {
  parseCustomTopUpAmountInput,
  TOP_UP_CUSTOM_MAX_USD,
  TOP_UP_CUSTOM_MIN_USD,
} from '@/features/api-console/lib/top-up-products';
import { Loader2 } from 'lucide-react';

import { Button } from '@/shared/components/ui/button';
import { Input } from '@/shared/components/ui/input';
import { cn } from '@/shared/lib/utils';

export type TopUpPackage = {
  productId: string;
  title: string;
  price: string;
  description: string;
  isFeatured?: boolean;
};

export function TopUpPackages({
  packages,
  locale,
  labels,
}: {
  packages: TopUpPackage[];
  locale: string;
  labels: {
    popular: string;
    add: string;
    checkoutError: string;
    customTitle: string;
    customDescription: string;
    customPlaceholder: string;
    customButton: string;
    customRange: string;
    customInvalid: string;
  };
}) {
  const [loadingId, setLoadingId] = useState('');
  const [error, setError] = useState('');
  const [customAmount, setCustomAmount] = useState('');

  async function startCheckout(body: Record<string, unknown>) {
    try {
      const response = await fetch('/api/payment/checkout', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const payload = await response.json();
      if (payload.code !== 0 || !payload.data?.checkoutUrl) {
        throw new Error(payload.message || labels.checkoutError);
      }
      window.location.href = payload.data.checkoutUrl;
    } catch (err: any) {
      setError(err?.message || labels.checkoutError);
      setLoadingId('');
    }
  }

  async function checkout(productId: string) {
    setLoadingId(productId);
    setError('');
    await startCheckout({
      product_id: productId,
      currency: 'USD',
      locale,
    });
  }

  async function checkoutCustom() {
    const amountUsd = parseCustomTopUpAmountInput(customAmount);
    if (!amountUsd) {
      setError(labels.customInvalid);
      return;
    }

    setLoadingId('custom');
    setError('');
    await startCheckout({
      custom_amount_usd: amountUsd,
      currency: 'USD',
      locale,
    });
  }

  return (
    <div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {packages.map((pkg) => (
          <div
            key={pkg.productId}
            className={cn(
              'bg-card flex flex-col rounded-xl border p-5',
              pkg.isFeatured && 'border-primary/40'
            )}
          >
            <div className="flex items-center justify-between">
              <div className="text-muted-foreground text-xs tracking-wide uppercase">
                {pkg.title}
              </div>
              {pkg.isFeatured && (
                <span className="bg-primary/10 text-primary rounded-md px-1.5 py-0.5 text-xs font-medium">
                  {labels.popular}
                </span>
              )}
            </div>
            <div className="mt-3 font-mono text-3xl font-semibold">
              {pkg.price}
            </div>
            <p className="text-muted-foreground mt-2 flex-1 text-sm">
              {pkg.description}
            </p>
            <Button
              className="mt-5"
              variant={pkg.isFeatured ? 'default' : 'outline'}
              disabled={loadingId !== ''}
              onClick={() => checkout(pkg.productId)}
            >
              {loadingId === pkg.productId && (
                <Loader2 className="size-4 animate-spin" />
              )}
              {labels.add.replace('{price}', pkg.price)}
            </Button>
          </div>
        ))}
      </div>
      <div className="bg-card mt-4 rounded-xl border p-5">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
          <div className="min-w-0 flex-1">
            <div className="text-muted-foreground text-xs tracking-wide uppercase">
              {labels.customTitle}
            </div>
            <p className="text-muted-foreground mt-2 text-sm">
              {labels.customDescription}
            </p>
            <div className="mt-4 flex max-w-md flex-col gap-2 sm:flex-row">
              <Input
                type="number"
                min={TOP_UP_CUSTOM_MIN_USD}
                max={TOP_UP_CUSTOM_MAX_USD}
                step={1}
                inputMode="numeric"
                value={customAmount}
                placeholder={labels.customPlaceholder}
                aria-invalid={Boolean(error)}
                aria-describedby="custom-top-up-range"
                disabled={loadingId !== ''}
                onChange={(event) => setCustomAmount(event.target.value)}
              />
              <Button
                className="sm:w-auto"
                disabled={loadingId !== ''}
                onClick={checkoutCustom}
              >
                {loadingId === 'custom' && (
                  <Loader2 className="size-4 animate-spin" />
                )}
                {labels.customButton}
              </Button>
            </div>
            <p
              id="custom-top-up-range"
              className="text-muted-foreground mt-2 text-xs"
            >
              {labels.customRange}
            </p>
          </div>
        </div>
      </div>
      {error && <p className="text-destructive mt-3 text-sm">{error}</p>}
    </div>
  );
}
