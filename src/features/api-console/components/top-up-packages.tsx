'use client';

import { useState } from 'react';
import { Loader2 } from 'lucide-react';

import { Button } from '@/shared/components/ui/button';
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
}: {
  packages: TopUpPackage[];
  locale: string;
}) {
  const [loadingId, setLoadingId] = useState('');
  const [error, setError] = useState('');

  async function checkout(productId: string) {
    setLoadingId(productId);
    setError('');
    try {
      const response = await fetch('/api/payment/checkout', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          product_id: productId,
          currency: 'USD',
          locale,
        }),
      });
      const payload = await response.json();
      if (payload.code !== 0 || !payload.data?.checkoutUrl) {
        throw new Error(payload.message || 'Checkout could not start');
      }
      window.location.href = payload.data.checkoutUrl;
    } catch (err: any) {
      setError(err?.message || 'Checkout could not start');
      setLoadingId('');
    }
  }

  return (
    <div>
      <div className="grid gap-4 sm:grid-cols-3">
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
                  Popular
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
              Add {pkg.price}
            </Button>
          </div>
        ))}
      </div>
      {error && <p className="text-destructive mt-3 text-sm">{error}</p>}
    </div>
  );
}
