'use client';

import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';

import { Button } from '@/shared/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/shared/components/ui/dialog';
import { Input } from '@/shared/components/ui/input';
import { Label } from '@/shared/components/ui/label';
import { Textarea } from '@/shared/components/ui/textarea';

import { apiRequest, Notice, Panel, RecordTable } from './primitives';

type WalletData = {
  account: Record<string, unknown> | null;
  ledger: Array<Record<string, unknown>>;
};

function newOperationId() {
  return `op_${crypto.randomUUID().replaceAll('-', '')}`;
}

export function WalletTab() {
  const t = useTranslations('admin.apipool');
  const [userId, setUserId] = useState('');
  const [data, setData] = useState<WalletData | null>(null);
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [operationId, setOperationId] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmAction, setConfirmAction] = useState<'freeze' | 'unfreeze' | null>(null);
  const [confirmReason, setConfirmReason] = useState('');
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setOperationId(newOperationId());
  }, []);

  async function load() {
    if (!userId.trim()) return;
    setLoading(true);
    try {
      const next = await apiRequest<WalletData>(
        `/api/apipool/admin/gateway/wallet?userId=${encodeURIComponent(userId.trim())}`
      );
      setData(next);
      setNotice(null);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : t('common.failed'));
    } finally {
      setLoading(false);
    }
  }

  async function adjust() {
    setLoading(true);
    try {
      const result = await apiRequest<{ alreadyApplied: boolean }>(
        '/api/apipool/admin/gateway/wallet/adjust',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            userId: userId.trim(),
            signedAmountMicroUsd: Number(amount),
            reason: reason.trim(),
            operationId,
          }),
        }
      );
      setNotice(
        result.alreadyApplied
          ? t('wallet.adjustAlreadyApplied')
          : t('wallet.adjusted')
      );
      if (!result.alreadyApplied) {
        setOperationId(newOperationId());
        setAmount('');
        setReason('');
      }
      await load();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : t('common.failed'));
    } finally {
      setLoading(false);
    }
  }

  async function reverse(walletLedgerId: string) {
    setLoading(true);
    try {
      await apiRequest('/api/apipool/admin/gateway/wallet/adjust', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ reverseWalletLedgerId: walletLedgerId }),
      });
      setNotice(t('wallet.reversed'));
      await load();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : t('common.failed'));
    } finally {
      setLoading(false);
    }
  }

  async function changeFreeze() {
    if (!confirmAction || !confirmReason.trim()) return;
    setLoading(true);
    try {
      await apiRequest('/api/apipool/admin/gateway/wallet/freeze', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          userId: userId.trim(),
          action: confirmAction,
          reason: confirmReason.trim(),
        }),
      });
      setNotice(
        confirmAction === 'freeze'
          ? t('wallet.frozen')
          : t('wallet.unfrozen')
      );
      setConfirmAction(null);
      setConfirmReason('');
      await load();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : t('common.failed'));
    } finally {
      setLoading(false);
    }
  }

  const frozen = Boolean(data?.account?.frozenAt);

  return (
    <div className="space-y-4">
      <Panel title={t('wallet.lookup')} description={t('wallet.lookupHelp')}>
        <div className="space-y-4">
          <div className="grid gap-2 md:grid-cols-[1fr_auto]">
            <Input value={userId} onChange={(event) => setUserId(event.target.value)} placeholder={t('wallet.userId')} />
            <Button onClick={() => void load()} disabled={loading || !userId.trim()}>{t('common.search')}</Button>
          </div>
          <Notice message={notice} />
          {data?.account && (
            <div className="bg-muted/40 flex flex-wrap items-center justify-between gap-3 rounded-md border p-3 text-sm">
              <span>{t('wallet.balance')}: {String(data.account.balanceMicroUsd)} micro-USD</span>
              <span>{frozen ? t('wallet.statusFrozen') : t('wallet.statusActive')}</span>
              <Button variant={frozen ? 'outline' : 'destructive'} size="sm" onClick={() => setConfirmAction(frozen ? 'unfreeze' : 'freeze')}>
                {frozen ? t('wallet.unfreeze') : t('wallet.freeze')}
              </Button>
            </div>
          )}
        </div>
      </Panel>

      <Panel title={t('wallet.adjustTitle')} description={t('wallet.reasonRequired')}>
        <div className="grid gap-3 md:grid-cols-2">
          <div className="space-y-2"><Label>{t('wallet.amount')}</Label><Input type="number" value={amount} onChange={(event) => setAmount(event.target.value)} /></div>
          <div className="space-y-2"><Label>{t('wallet.operationId')}</Label><Input value={operationId} readOnly /></div>
          <div className="space-y-2 md:col-span-2"><Label>{t('wallet.reason')}</Label><Textarea value={reason} onChange={(event) => setReason(event.target.value)} /></div>
          <Button onClick={() => void adjust()} disabled={loading || !userId.trim() || !amount || !reason.trim()}>{t('wallet.adjust')}</Button>
        </div>
      </Panel>

      <Panel title={t('wallet.ledger')}>
        <RecordTable
          rows={data?.ledger ?? []}
          columns={[
            { key: 'id', label: 'ID' },
            { key: 'entryType', label: t('wallet.entryType') },
            { key: 'signedAmountMicroUsd', label: t('wallet.amount') },
            { key: 'balanceAfterMicroUsd', label: t('wallet.balanceAfter') },
            { key: 'reason', label: t('wallet.reason') },
            { key: 'createdAt', label: t('common.createdAt') },
          ]}
          emptyLabel={t('common.empty')}
          actions={(row) =>
            row.entryType === 'request_charge' ? (
              <Button variant="outline" size="sm" onClick={() => void reverse(String(row.id))} disabled={loading}>{t('wallet.reverse')}</Button>
            ) : null
          }
        />
      </Panel>

      <Dialog open={confirmAction !== null} onOpenChange={(open) => !open && setConfirmAction(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{confirmAction === 'freeze' ? t('wallet.confirmFreeze') : t('wallet.confirmUnfreeze')}</DialogTitle>
            <DialogDescription>{t('wallet.confirmHelp')}</DialogDescription>
          </DialogHeader>
          <div className="space-y-2"><Label>{t('wallet.reason')}</Label><Textarea value={confirmReason} onChange={(event) => setConfirmReason(event.target.value)} /></div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmAction(null)}>{t('common.cancel')}</Button>
            <Button variant={confirmAction === 'freeze' ? 'destructive' : 'default'} onClick={() => void changeFreeze()} disabled={!confirmReason.trim() || loading}>{t('common.confirm')}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
