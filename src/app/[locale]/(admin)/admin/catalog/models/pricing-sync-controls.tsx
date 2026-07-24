'use client';

import { useState } from 'react';
import { RefreshCw, SearchCheck } from 'lucide-react';

import { Button } from '@/shared/components/ui/button';

type Labels = {
  title: string;
  description: string;
  sync: string;
  syncing: string;
  drift: string;
  loading: string;
  success: string;
  error: string;
};

export function CatalogPricingSyncControls({ labels }: { labels: Labels }) {
  const [loading, setLoading] = useState<'sync' | 'drift' | null>(null);
  const [message, setMessage] = useState('');

  async function callPricingEndpoint(
    type: 'sync' | 'drift',
    endpoint: string,
    method: 'GET' | 'POST'
  ) {
    setLoading(type);
    setMessage(labels.loading);
    try {
      const response = await fetch(endpoint, { method });
      const payload = await response.json();
      if (payload.code !== 0) throw new Error(payload.message);
      const status =
        payload.data?.status ||
        payload.data?.latestRun?.status ||
        labels.success;
      setMessage(`${labels.success}: ${status}`);
    } catch (error: any) {
      setMessage(`${labels.error}: ${error?.message || labels.error}`);
    } finally {
      setLoading(null);
    }
  }

  return (
    <div className="bg-card rounded-lg border p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-sm font-medium">{labels.title}</h2>
          <p className="text-muted-foreground mt-1 text-xs">
            {labels.description}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button
            type="button"
            size="sm"
            onClick={() =>
              callPricingEndpoint(
                'sync',
                '/api/apipool/admin/catalog/pricing/sync',
                'POST'
              )
            }
            disabled={loading !== null}
          >
            <RefreshCw className="size-4" />
            {loading === 'sync' ? labels.syncing : labels.sync}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() =>
              callPricingEndpoint(
                'drift',
                '/api/apipool/admin/catalog/pricing/drift',
                'GET'
              )
            }
            disabled={loading !== null}
          >
            <SearchCheck className="size-4" />
            {loading === 'drift' ? labels.loading : labels.drift}
          </Button>
        </div>
      </div>
      {message && (
        <p className="text-muted-foreground mt-3 text-xs" role="status">
          {message}
        </p>
      )}
    </div>
  );
}
