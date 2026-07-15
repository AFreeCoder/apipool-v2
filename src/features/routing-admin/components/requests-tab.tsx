'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';

import { Button } from '@/shared/components/ui/button';
import { Input } from '@/shared/components/ui/input';

import { apiRequest, Notice, Panel, RecordTable } from './primitives';

export function RequestsTab() {
  const t = useTranslations('admin.apipool');
  const [portalId, setPortalId] = useState('');
  const [newapiId, setNewapiId] = useState('');
  const [requestRow, setRequestRow] = useState<Record<string, unknown> | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  async function search() {
    const query = portalId.trim()
      ? `id=${encodeURIComponent(portalId.trim())}`
      : `newapiRequestId=${encodeURIComponent(newapiId.trim())}`;
    try {
      const data = await apiRequest<{ request: Record<string, unknown> | null }>(
        `/api/apipool/admin/gateway/requests?${query}`
      );
      setRequestRow(data.request);
      setNotice(data.request ? null : t('requests.notFound'));
    } catch (error) {
      setNotice(error instanceof Error ? error.message : t('common.failed'));
    }
  }

  const details = requestRow
    ? Object.entries(requestRow).map(([key, value]) => ({ id: key, field: key, value }))
    : [];

  return (
    <Panel title={t('requests.title')} description={t('requests.help')}>
      <div className="space-y-4">
        <div className="grid gap-2 md:grid-cols-[1fr_1fr_auto]">
          <Input value={portalId} onChange={(event) => setPortalId(event.target.value)} placeholder={t('requests.portalId')} />
          <Input value={newapiId} onChange={(event) => setNewapiId(event.target.value)} placeholder={t('requests.newapiId')} />
          <Button onClick={() => void search()} disabled={!portalId.trim() && !newapiId.trim()}>{t('common.search')}</Button>
        </div>
        <Notice message={notice} />
        <RecordTable
          rows={details}
          columns={[{ key: 'field', label: t('requests.field') }, { key: 'value', label: t('requests.value') }]}
          emptyLabel={t('common.empty')}
        />
      </div>
    </Panel>
  );
}
