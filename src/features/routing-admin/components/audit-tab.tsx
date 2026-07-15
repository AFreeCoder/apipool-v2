'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';

import { Button } from '@/shared/components/ui/button';
import { Input } from '@/shared/components/ui/input';

import { apiRequest, Notice, Panel, RecordTable } from './primitives';

export function AuditTab() {
  const t = useTranslations('admin.apipool');
  const [action, setAction] = useState('');
  const [rows, setRows] = useState<Array<Record<string, unknown>>>([]);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const query = action.trim() ? `?action=${encodeURIComponent(action.trim())}` : '';
      const data = await apiRequest<{ audits: Array<Record<string, unknown>> }>(
        `/api/apipool/admin/gateway/audit${query}`
      );
      setRows(data.audits);
      setNotice(null);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : t('common.failed'));
    }
  }, [action, t]);

  useEffect(() => { void load(); }, [load]);

  return (
    <Panel title={t('audit.title')} description={t('audit.help')}>
      <div className="space-y-4">
        <div className="grid gap-2 md:grid-cols-[1fr_auto]">
          <Input value={action} onChange={(event) => setAction(event.target.value)} placeholder={t('audit.action')} />
          <Button variant="outline" onClick={() => void load()}>{t('common.search')}</Button>
        </div>
        <Notice message={notice} />
        <RecordTable
          rows={rows}
          columns={[
            { key: 'createdAt', label: t('common.createdAt') },
            { key: 'action', label: t('audit.action') },
            { key: 'operatorUserId', label: t('audit.operator') },
            { key: 'targetType', label: t('audit.targetType') },
            { key: 'targetId', label: t('audit.targetId') },
            { key: 'reason', label: t('wallet.reason') },
          ]}
          emptyLabel={t('common.empty')}
        />
      </div>
    </Panel>
  );
}
