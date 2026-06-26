'use client';

import { useState } from 'react';
import { Send } from 'lucide-react';

import type { QuotaAdjustmentFormCopy } from '@/features/apipool-ui/copy';
import { Button } from '@/shared/components/ui/button';
import { Input } from '@/shared/components/ui/input';
import { Textarea } from '@/shared/components/ui/textarea';

export function QuotaAdjustmentForm({
  initialPortalUserId = '',
  copy,
}: {
  initialPortalUserId?: string;
  copy: QuotaAdjustmentFormCopy;
}) {
  const [portalUserId, setPortalUserId] = useState(initialPortalUserId);
  const [amountUsd, setAmountUsd] = useState('10');
  const [reason, setReason] = useState<string>(copy.defaultReason);
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);

  async function submit() {
    setLoading(true);
    setMessage('');
    try {
      const response = await fetch('/api/apipool/admin/adjust-quota', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          portalUserId,
          amountUsd: Number(amountUsd),
          reason,
        }),
      });
      const payload = await response.json();
      if (payload.code !== 0) throw new Error(payload.message);
      setMessage(
        `${copy.ledgerEntry} ${payload.data.ledger.id} ${copy.is} ${payload.data.ledger.status}${copy.suffix}`
      );
    } catch (error: any) {
      setMessage(error?.message || copy.adjustmentFailed);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="max-w-2xl rounded-lg border bg-background p-5">
      <div className="grid gap-4">
        <label className="grid gap-2 text-sm">
          {copy.portalUserId}
          <Input
            value={portalUserId}
            onChange={(event) => setPortalUserId(event.target.value)}
            placeholder={copy.userPlaceholder}
          />
        </label>
        <label className="grid gap-2 text-sm">
          {copy.amountUsd}
          <Input
            value={amountUsd}
            onChange={(event) => setAmountUsd(event.target.value)}
            inputMode="decimal"
          />
        </label>
        <label className="grid gap-2 text-sm">
          {copy.reason}
          <Textarea
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
        </label>
        <Button onClick={submit} disabled={loading}>
          <Send className="size-4" />
          {loading ? copy.applying : copy.apply}
        </Button>
        {message && <p className="text-sm text-muted-foreground">{message}</p>}
      </div>
    </div>
  );
}
