'use client';

import { useRef, useState } from 'react';
import { Search, Send } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Link } from '@/core/i18n/navigation';
import { lookupPortalUserByEmail } from '@/features/api-console/server/quota-admin-actions';
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
  initialResolvedUser = '',
}: {
  initialPortalUserId?: string;
  /** 从用户列表/详情页带 ?portalUserId= 直达时的身份回显：只有裸 UUID
      的话，管理员无法确认自己调的是谁。 */
  initialResolvedUser?: string;
}) {
  const t = useTranslations('admin.apipoolAdjustments.form');
  const [email, setEmail] = useState('');
  const [portalUserId, setPortalUserId] = useState(initialPortalUserId);
  const [resolvedUser, setResolvedUser] = useState(initialResolvedUser);
  const [direction, setDirection] = useState<'increase' | 'decrease'>(
    'increase'
  );
  const [amountUsd, setAmountUsd] = useState('10');
  const [reason, setReason] = useState(t('defaultReason'));
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
        setMessage(t('messages.noUserFound', { email }));
        return;
      }
      setPortalUserId(user.id);
      setResolvedUser(`${user.name} (${user.email})`);
    } catch (error: any) {
      setMessage(error?.message || t('messages.lookupFailed'));
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
      const ledger = payload.data.ledger;
      const parts = [
        t('messages.ledgerStatus', { id: ledger.id, status: ledger.status }),
      ];
      if (ledger.alreadyApplied) {
        parts.push(t('messages.alreadyApplied'));
      }
      setMessage(parts.join(' '));
      requestDraftRef.current = null;
    } catch (error: any) {
      if (responseReceived) {
        requestDraftRef.current = null;
      }
      setMessage(error?.message || t('messages.adjustmentFailed'));
    } finally {
      submittingRef.current = false;
      setLoading(false);
    }
  }

  return (
    <div className="bg-card max-w-2xl rounded-xl border p-5">
      <div className="grid gap-4">
        <label className="grid gap-2 text-sm">
          {t('fields.email')}
          <div className="flex gap-2">
            <Input
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder={t('placeholders.email')}
            />
            <Button
              type="button"
              variant="outline"
              onClick={lookup}
              disabled={lookupLoading || !email.trim()}
            >
              <Search className="size-4" />
              {lookupLoading ? t('buttons.finding') : t('buttons.find')}
            </Button>
          </div>
        </label>

        <label className="grid gap-2 text-sm">
          {t('fields.portalUserId')}
          <Input
            value={portalUserId}
            onChange={(event) => {
              setPortalUserId(event.target.value);
              setResolvedUser('');
            }}
            placeholder={t('placeholders.portalUserId')}
          />
          {resolvedUser && (
            <span className="text-primary text-xs">✓ {resolvedUser}</span>
          )}
        </label>

        <div className="grid gap-2 text-sm sm:grid-cols-2">
          <label className="grid gap-2">
            {t('fields.operation')}
            <select
              value={direction}
              onChange={(event) =>
                setDirection(event.target.value as 'increase' | 'decrease')
              }
              className="border-input bg-background h-9 rounded-md border px-3 text-sm"
            >
              <option value="increase">{t('operations.increase')}</option>
              <option value="decrease">{t('operations.decrease')}</option>
            </select>
          </label>
          <label className="grid gap-2">
            {t('fields.amountUsd')}
            <Input
              value={amountUsd}
              onChange={(event) => setAmountUsd(event.target.value)}
              inputMode="decimal"
              placeholder={t('placeholders.amountUsd')}
            />
          </label>
        </div>

        <label className="grid gap-2 text-sm">
          {t('fields.reason')}
          <Textarea
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
        </label>

        <Button onClick={submit} disabled={loading || !portalUserId.trim()}>
          <Send className="size-4" />
          {loading
            ? t('buttons.applying')
            : direction === 'decrease'
              ? t('buttons.applyDecrease')
              : t('buttons.applyIncrease')}
        </Button>
        {message && <p className="text-muted-foreground text-sm">{message}</p>}
        {portalUserId.trim() && (
          <Link
            href={`/admin/users/${portalUserId.trim()}/detail`}
            className="text-primary text-sm underline-offset-4 hover:underline"
          >
            {t('links.viewUser')}
          </Link>
        )}
      </div>
    </div>
  );
}
