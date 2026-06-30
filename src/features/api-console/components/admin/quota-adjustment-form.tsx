'use client';

import { useRef, useState } from 'react';
import { lookupPortalUserByEmail } from '@/features/api-console/server/quota-admin-actions';
import { Search, Send } from 'lucide-react';

import { Button } from '@/shared/components/ui/button';
import { Input } from '@/shared/components/ui/input';
import { Textarea } from '@/shared/components/ui/textarea';

function createRequestId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function QuotaAdjustmentForm({
  initialPortalUserId = '',
}: {
  initialPortalUserId?: string;
}) {
  const [email, setEmail] = useState('');
  const [portalUserId, setPortalUserId] = useState(initialPortalUserId);
  const [resolvedUser, setResolvedUser] = useState('');
  const [direction, setDirection] = useState<'increase' | 'decrease'>(
    'increase'
  );
  const [amountUsd, setAmountUsd] = useState('10');
  const [reason, setReason] = useState('Manual MVP quota adjustment');
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);
  const [lookupLoading, setLookupLoading] = useState(false);
  const submittingRef = useRef(false);
  const requestDraftRef = useRef<{
    signature: string;
    idempotencyKey: string;
  } | null>(null);

  function getIdempotencyKeyForDraft(signature: string) {
    if (requestDraftRef.current?.signature !== signature) {
      requestDraftRef.current = {
        signature,
        idempotencyKey: `portal-adjustment:${portalUserId}:${createRequestId()}`,
      };
    }
    return requestDraftRef.current.idempotencyKey;
  }

  async function lookup() {
    setLookupLoading(true);
    setMessage('');
    setResolvedUser('');
    try {
      const user = await lookupPortalUserByEmail(email);
      if (!user) {
        setMessage(`No user found for ${email}`);
        return;
      }
      setPortalUserId(user.id);
      setResolvedUser(`${user.name} (${user.email})`);
    } catch (error: any) {
      setMessage(error?.message || 'Lookup failed');
    } finally {
      setLookupLoading(false);
    }
  }

  async function submit() {
    if (loading || submittingRef.current) return;
    submittingRef.current = true;
    setLoading(true);
    setMessage('');
    let responseReceived = false;
    try {
      const magnitude = Math.abs(Number(amountUsd));
      const signedAmount = direction === 'decrease' ? -magnitude : magnitude;
      const draftSignature = JSON.stringify({
        portalUserId,
        amountUsd: signedAmount,
        reason,
      });
      const idempotencyKey = getIdempotencyKeyForDraft(draftSignature);
      const response = await fetch('/api/apipool/admin/adjust-quota', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          portalUserId,
          amountUsd: signedAmount,
          reason,
          idempotencyKey,
        }),
      });
      responseReceived = true;
      const payload = await response.json();
      if (payload.code !== 0) throw new Error(payload.message);
      setMessage(
        `Ledger entry ${payload.data.ledger.id} is ${payload.data.ledger.status}.`
      );
      requestDraftRef.current = null;
    } catch (error: any) {
      if (responseReceived) {
        requestDraftRef.current = null;
      }
      setMessage(error?.message || 'Adjustment failed');
    } finally {
      submittingRef.current = false;
      setLoading(false);
    }
  }

  return (
    <div className="bg-card max-w-2xl rounded-xl border p-5">
      <div className="grid gap-4">
        <label className="grid gap-2 text-sm">
          Find user by email
          <div className="flex gap-2">
            <Input
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="user@example.com"
            />
            <Button
              type="button"
              variant="outline"
              onClick={lookup}
              disabled={lookupLoading || !email.trim()}
            >
              <Search className="size-4" />
              {lookupLoading ? 'Finding...' : 'Find'}
            </Button>
          </div>
        </label>

        <label className="grid gap-2 text-sm">
          Portal user ID
          <Input
            value={portalUserId}
            onChange={(event) => {
              setPortalUserId(event.target.value);
              setResolvedUser('');
            }}
            placeholder="Looked up from email, or paste an ID"
          />
          {resolvedUser && (
            <span className="text-primary text-xs">✓ {resolvedUser}</span>
          )}
        </label>

        <div className="grid gap-2 text-sm sm:grid-cols-2">
          <label className="grid gap-2">
            Operation
            <select
              value={direction}
              onChange={(event) =>
                setDirection(event.target.value as 'increase' | 'decrease')
              }
              className="border-input bg-background h-9 rounded-md border px-3 text-sm"
            >
              <option value="increase">Increase (+)</option>
              <option value="decrease">Decrease (−)</option>
            </select>
          </label>
          <label className="grid gap-2">
            Amount USD
            <Input
              value={amountUsd}
              onChange={(event) => setAmountUsd(event.target.value)}
              inputMode="decimal"
              placeholder="positive number"
            />
          </label>
        </div>

        <label className="grid gap-2 text-sm">
          Reason
          <Textarea
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
        </label>

        <Button onClick={submit} disabled={loading || !portalUserId.trim()}>
          <Send className="size-4" />
          {loading
            ? 'Applying...'
            : direction === 'decrease'
              ? 'Apply decrease'
              : 'Apply increase'}
        </Button>
        {message && <p className="text-muted-foreground text-sm">{message}</p>}
      </div>
    </div>
  );
}
