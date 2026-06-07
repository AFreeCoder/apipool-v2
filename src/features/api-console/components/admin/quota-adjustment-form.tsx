'use client';

import { useState } from 'react';
import { Send } from 'lucide-react';

import { Button } from '@/shared/components/ui/button';
import { Input } from '@/shared/components/ui/input';
import { Textarea } from '@/shared/components/ui/textarea';

export function QuotaAdjustmentForm({
  initialPortalUserId = '',
}: {
  initialPortalUserId?: string;
}) {
  const [portalUserId, setPortalUserId] = useState(initialPortalUserId);
  const [amountUsd, setAmountUsd] = useState('10');
  const [reason, setReason] = useState('Manual MVP quota adjustment');
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
      setMessage(`Ledger entry ${payload.data.ledger.id} is ${payload.data.ledger.status}.`);
    } catch (error: any) {
      setMessage(error?.message || 'Adjustment failed');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="max-w-2xl rounded-lg border bg-background p-5">
      <div className="grid gap-4">
        <label className="grid gap-2 text-sm">
          Portal user ID
          <Input
            value={portalUserId}
            onChange={(event) => setPortalUserId(event.target.value)}
            placeholder="user id"
          />
        </label>
        <label className="grid gap-2 text-sm">
          Amount USD
          <Input
            value={amountUsd}
            onChange={(event) => setAmountUsd(event.target.value)}
            inputMode="decimal"
          />
        </label>
        <label className="grid gap-2 text-sm">
          Reason
          <Textarea
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
        </label>
        <Button onClick={submit} disabled={loading}>
          <Send className="size-4" />
          {loading ? 'Applying...' : 'Apply quota'}
        </Button>
        {message && <p className="text-sm text-muted-foreground">{message}</p>}
      </div>
    </div>
  );
}
