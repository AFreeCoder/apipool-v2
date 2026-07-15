'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';

import { Button } from '@/shared/components/ui/button';
import { Input } from '@/shared/components/ui/input';

import { apiRequest, Notice, Panel, RecordTable } from './primitives';

type ReconciliationData = {
  mismatches: Array<Record<string, unknown>>;
  waived: Array<Record<string, unknown>>;
  stuck: Array<Record<string, unknown>>;
  invariant: { broken: string[] };
};

export function ReconciliationTab() {
  const t = useTranslations('admin.apipool');
  const [data, setData] = useState<ReconciliationData | null>(null);
  const [note, setNote] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(
        await apiRequest<ReconciliationData>(
          '/api/apipool/admin/gateway/reconciliation'
        )
      );
      setNotice(null);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : t('common.failed'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  async function resolve(
    row: Record<string, unknown>,
    resolution: 'explained' | 'manual_closed' | 'orphan_acknowledged'
  ) {
    if (!note.trim()) {
      setNotice(t('reconciliation.noteRequired'));
      return;
    }
    setLoading(true);
    try {
      await apiRequest('/api/apipool/admin/gateway/reconciliation/resolve', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...(resolution === 'orphan_acknowledged'
            ? { orphanId: row.id }
            : { ledgerId: row.id }),
          resolution,
          note: note.trim(),
        }),
      });
      setNotice(t('reconciliation.resolved'));
      setNote('');
      await load();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : t('common.failed'));
    } finally {
      setLoading(false);
    }
  }

  const columns = [
    { key: 'id', label: 'ID' },
    { key: 'userId', label: t('reconciliation.user') },
    { key: 'portalModelId', label: t('routing.model') },
    { key: 'reconcileStatus', label: t('reconciliation.status') },
    { key: 'reconcileNote', label: t('reconciliation.note') },
  ];

  return (
    <div className="space-y-4">
      <div className="grid gap-2 md:grid-cols-[1fr_auto]">
        <Input value={note} onChange={(event) => setNote(event.target.value)} placeholder={t('reconciliation.notePlaceholder')} />
        <Button variant="outline" onClick={() => void load()} disabled={loading}>{t('common.refresh')}</Button>
      </div>
      <Notice message={notice} />
      <Panel title={t('reconciliation.mismatches')}>
        <RecordTable rows={data?.mismatches ?? []} columns={columns} emptyLabel={t('common.empty')} actions={(row) => <Button size="sm" variant="outline" onClick={() => void resolve(row, 'explained')} disabled={loading}>{t('reconciliation.explain')}</Button>} />
      </Panel>
      <Panel title={t('reconciliation.waived')} description={t('reconciliation.waivedHelp')}>
        <RecordTable
          rows={data?.waived ?? []}
          columns={[{ key: 'id', label: 'ID' }, { key: 'source', label: t('reconciliation.source') }, { key: 'userId', label: t('reconciliation.user') }, { key: 'tokenName', label: t('reconciliation.tokenName') }, { key: 'reconcileStatus', label: t('reconciliation.status') }]}
          emptyLabel={t('common.empty')}
          actions={(row) => row.source === 'orphan' ? <Button size="sm" variant="outline" onClick={() => void resolve(row, 'orphan_acknowledged')} disabled={loading}>{t('reconciliation.acknowledge')}</Button> : null}
        />
      </Panel>
      <Panel title={t('reconciliation.stuck')}>
        <RecordTable rows={data?.stuck ?? []} columns={columns} emptyLabel={t('common.empty')} actions={(row) => <Button size="sm" variant="destructive" onClick={() => void resolve(row, 'manual_closed')} disabled={loading}>{t('reconciliation.manualClose')}</Button>} />
      </Panel>
      <Panel title={t('reconciliation.invariant')}>
        <div className={data?.invariant.broken.length ? 'text-destructive text-sm' : 'text-muted-foreground text-sm'}>
          {data?.invariant.broken.length ? data.invariant.broken.join(', ') : t('reconciliation.invariantOk')}
        </div>
      </Panel>
    </div>
  );
}
