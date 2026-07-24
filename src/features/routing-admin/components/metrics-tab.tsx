'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';

import { StatCard } from '@/features/api-console/components/stat-card';
import { Button } from '@/shared/components/ui/button';

import { apiRequest, Notice } from './primitives';

type Metrics = {
  requests24h: {
    settled: number;
    failedUnbilled: number;
    successRate: number | null;
  };
  pendingBackfill: number;
  waived: number;
  wallets: {
    negativeUsers: number;
    overdraftExposureMicroUsd: number;
    frozenUsers: number;
  };
  credentials: { pending: number; invalid: number };
};

export function MetricsTab() {
  const t = useTranslations('admin.apipool');
  const [metrics, setMetrics] = useState<Metrics | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setMetrics(
        await apiRequest<Metrics>('/api/apipool/admin/gateway/metrics')
      );
      setNotice(null);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : t('common.failed'));
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <Button variant="outline" size="sm" onClick={() => void load()}>
          {t('common.refresh')}
        </Button>
      </div>
      <Notice message={notice} />
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label={t('metrics.successRate')}
          value={
            metrics?.requests24h.successRate == null
              ? '—'
              : `${(metrics.requests24h.successRate * 100).toFixed(2)}%`
          }
          help={t('metrics.successHelp', {
            settled: metrics?.requests24h.settled ?? 0,
            failed: metrics?.requests24h.failedUnbilled ?? 0,
          })}
        />
        <StatCard
          label={t('metrics.pending')}
          value={metrics?.pendingBackfill ?? '—'}
        />
        <StatCard
          label={t('metrics.overdraft')}
          value={metrics?.wallets.overdraftExposureMicroUsd ?? '—'}
          help={t('metrics.negativeUsers', {
            count: metrics?.wallets.negativeUsers ?? 0,
          })}
        />
        <StatCard
          label={t('metrics.frozen')}
          value={metrics?.wallets.frozenUsers ?? '—'}
        />
        <StatCard label={t('metrics.waived')} value={metrics?.waived ?? '—'} />
        <StatCard
          label={t('metrics.credentialPending')}
          value={metrics?.credentials.pending ?? '—'}
        />
        <StatCard
          label={t('metrics.credentialInvalid')}
          value={metrics?.credentials.invalid ?? '—'}
        />
      </div>
    </div>
  );
}
