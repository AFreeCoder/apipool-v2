'use client';

import { useState } from 'react';
import { Copy, KeyRound, Plus, Trash2, Ban } from 'lucide-react';

import { APIPOOL_PUBLIC_CONFIG } from '@/config/apipool/public';
import {
  canDeleteKeyStatus,
  canDisableKeyStatus,
  type KeyLifecycleStatus,
} from '@/features/api-console/lib/status';
import type { ApiKeyManagerCopy } from '@/features/apipool-ui/copy';
import { Button } from '@/shared/components/ui/button';
import { Input } from '@/shared/components/ui/input';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/shared/components/ui/table';

type ApiKeyRow = {
  id: string;
  displayName: string;
  keyMasked: string;
  status: KeyLifecycleStatus;
  allowedModels: string[];
  createdAt: string | Date;
};

type KeyMutationAction = 'disable' | 'delete';

function occupiesCustomerKeySlot(key: ApiKeyRow) {
  return !['deleted', 'failed_retriable', 'failed_terminal'].includes(
    key.status
  );
}

async function readPortalPayload(response: Response) {
  const payload = await response.json().catch(() => null);

  if (!payload) {
    throw new Error(
      response.ok
        ? 'Invalid API response'
        : `API request failed (${response.status})`
    );
  }

  return payload;
}

async function copyToClipboard(text: string) {
  if (!text) return false;

  let copiedWithClipboard = false;
  if (navigator.clipboard?.writeText && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      copiedWithClipboard = true;
    } catch {
      copiedWithClipboard = false;
    }
  }
  if (copiedWithClipboard) return true;

  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.left = '-9999px';
  textarea.style.top = '0';
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();

  let copiedWithFallback = false;
  try {
    copiedWithFallback = document.execCommand('copy');
  } catch {
    copiedWithFallback = false;
  } finally {
    document.body.removeChild(textarea);
  }
  return copiedWithFallback;
}

function StatusBadge({
  status,
  copy,
}: {
  status: KeyLifecycleStatus;
  copy: ApiKeyManagerCopy;
}) {
  const className =
    status === 'active'
      ? 'bg-primary/10 text-primary'
      : status.startsWith('failed') || status === 'remote_created_binding_failed'
        ? 'bg-destructive/10 text-destructive'
        : 'bg-muted text-muted-foreground';
  return (
    <span
      className={`rounded-md px-1.5 py-0.5 text-xs font-medium ${className}`}
    >
      {(copy.statusLabels as Record<string, string>)[status] ||
        status.replaceAll('_', ' ')}
    </span>
  );
}

export function ApiKeyManager({
  initialKeys,
  creationEnabled = true,
  copy,
}: {
  initialKeys: ApiKeyRow[];
  creationEnabled?: boolean;
  copy: ApiKeyManagerCopy;
}) {
  const [keys, setKeys] = useState<ApiKeyRow[]>(initialKeys);
  const [name, setName] = useState<string>(copy.defaultName);
  const [plainKey, setPlainKey] = useState('');
  const [plainKeysById, setPlainKeysById] = useState<Record<string, string>>(
    {}
  );
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);
  const [pendingKeyAction, setPendingKeyAction] = useState<{
    id: string;
    action: KeyMutationAction;
  } | null>(null);
  const isMutatingKey = pendingKeyAction !== null;
  const hasExistingCustomerKey = keys.some(occupiesCustomerKeySlot);

  async function refreshKeys() {
    try {
      const response = await fetch('/api/apipool/keys');
      const payload = await readPortalPayload(response);
      if (payload.code === 0) {
        setKeys(payload.data.keys || []);
      }
    } catch {
      return;
    }
  }

  async function createKey() {
    if (!creationEnabled) {
      setPlainKey('');
      setMessage(copy.keyCreationPaused);
      return;
    }
    if (hasExistingCustomerKey) {
      setPlainKey('');
      setMessage(copy.oneKeyLimit);
      return;
    }

    setLoading(true);
    setMessage('');
    setPlainKey('');
    try {
      const response = await fetch('/api/apipool/keys', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name,
        }),
      });
      const payload = await readPortalPayload(response);
      if (payload.code !== 0) throw new Error(payload.message);
      const createdKey = payload.data.key;
      const createdPlainKey = payload.data.plainKey || '';
      setPlainKey(createdPlainKey);
      if (createdKey?.id && createdPlainKey) {
        setPlainKeysById((prev) => ({
          ...prev,
          [createdKey.id]: createdPlainKey,
        }));
      }
      setKeys((prev) => [createdKey, ...prev]);
      setMessage(copy.keyCreated);
    } catch (error: any) {
      setMessage(error?.message || copy.createFailed);
      await refreshKeys();
    } finally {
      setLoading(false);
    }
  }

  async function disableKey(id: string) {
    setMessage('');
    setPlainKey('');
    const target = keys.find((key) => key.id === id);
    if (!target || !canDisableKeyStatus(target.status)) {
      setMessage(copy.disableNotAllowed);
      return;
    }

    setPendingKeyAction({ id, action: 'disable' });
    setKeys((prev) =>
      prev.map((key) =>
        key.id === id ? { ...key, status: 'disable_pending' } : key
      )
    );

    try {
      const response = await fetch(`/api/apipool/keys/${id}/disable`, {
        method: 'POST',
      });
      const payload = await readPortalPayload(response);
      if (payload.code !== 0) throw new Error(payload.message);
      setKeys((prev) =>
        prev.map((key) => (key.id === id ? payload.data.key : key))
      );
    } catch (error: any) {
      setMessage(error?.message || 'Disable API key failed');
      await refreshKeys();
    } finally {
      setPendingKeyAction(null);
    }
  }

  async function deleteKey(id: string) {
    setMessage('');
    setPlainKey('');
    const target = keys.find((key) => key.id === id);
    if (!target || !canDeleteKeyStatus(target.status)) {
      setMessage(copy.deleteNotAllowed);
      return;
    }

    setPendingKeyAction({ id, action: 'delete' });
    setKeys((prev) =>
      prev.map((key) =>
        key.id === id ? { ...key, status: 'delete_pending' } : key
      )
    );

    try {
      const response = await fetch(`/api/apipool/keys/${id}`, {
        method: 'DELETE',
      });
      const payload = await readPortalPayload(response);
      if (payload.code !== 0) throw new Error(payload.message);
      setKeys((prev) => prev.filter((key) => key.id !== id));
      setPlainKeysById((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
    } catch (error: any) {
      setMessage(error?.message || 'Delete API key failed');
      await refreshKeys();
    } finally {
      setPendingKeyAction(null);
    }
  }

  async function copyText(text: string) {
    const copied = await copyToClipboard(text);
    if (!copied) setMessage(copy.copyFailed);
  }

  return (
    <div className="space-y-6">
      <div className="rounded-lg border bg-background p-5">
        <div className="mb-4 flex items-center gap-2 font-medium">
          <KeyRound className="size-4" />
          {copy.createTitle}
        </div>
        <div className="flex flex-col gap-3 sm:flex-row">
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder={copy.keyNamePlaceholder}
          />
          <Button
            type="button"
            onClick={createKey}
            disabled={
              loading ||
              isMutatingKey ||
              !creationEnabled ||
              hasExistingCustomerKey
            }
          >
            <Plus className="size-4" />
            {loading ? copy.creating : copy.createKey}
          </Button>
        </div>
        <p className="mt-3 text-xs text-muted-foreground">
          {hasExistingCustomerKey ? copy.oneKeyLimitTip : copy.creationTip}
        </p>
        {!creationEnabled && (
          <p className="mt-2 text-xs text-muted-foreground">
            {copy.keyCreationPaused}
          </p>
        )}
        {message && <p className="mt-3 text-sm text-muted-foreground">{message}</p>}
        {plainKey && (
          <div className="mt-4 rounded-md border bg-muted p-4">
            <div className="mb-2 text-sm font-medium">
              {copy.fullKeyTitle}
            </div>
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 overflow-x-auto text-sm">
                {plainKey}
              </code>
              <Button
                type="button"
                variant="outline"
                size="icon"
                onClick={() => copyText(plainKey)}
                title={copy.copyFullKey}
                aria-label={copy.copyFullKey}
              >
                <Copy className="size-4" />
              </Button>
            </div>
          </div>
        )}
      </div>

      <div className="rounded-lg border bg-background">
        <div className="border-b p-5">
          <h2 className="font-medium">
            {copy.keysTitlePrefix}
            {APIPOOL_PUBLIC_CONFIG.apiBaseUrl}
          </h2>
        </div>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{copy.table.name}</TableHead>
              <TableHead>{copy.table.maskedKey}</TableHead>
              <TableHead>{copy.table.status}</TableHead>
              <TableHead>{copy.table.models}</TableHead>
              <TableHead className="text-right">{copy.table.actions}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {keys.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="h-24 text-center">
                  {copy.noKeys}
                </TableCell>
              </TableRow>
            ) : (
              keys.map((key) => {
                const plainKeyForRow = plainKeysById[key.id];
                const rowPendingAction =
                  pendingKeyAction?.id === key.id
                    ? pendingKeyAction.action
                    : null;
                const canDisable =
                  canDisableKeyStatus(key.status) && !isMutatingKey;
                const canDelete =
                  canDeleteKeyStatus(key.status) && !isMutatingKey;

                return (
                  <TableRow key={key.id}>
                    <TableCell className="font-medium">
                      {key.displayName}
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {key.keyMasked}
                    </TableCell>
                    <TableCell>
                      <StatusBadge status={key.status} copy={copy} />
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {(key.allowedModels || []).join(', ')}
                    </TableCell>
                    <TableCell className="space-x-2 text-right">
                      <Button
                        type="button"
                        variant="outline"
                        size="icon"
                        onClick={() =>
                          copyText(plainKeyForRow || key.keyMasked)
                        }
                        title={
                          plainKeyForRow
                            ? copy.copyFullKey
                            : copy.copyMaskedKey
                        }
                        aria-label={
                          plainKeyForRow
                            ? copy.copyFullKey
                            : copy.copyMaskedKey
                        }
                      >
                        <Copy className="size-4" />
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="icon"
                        onClick={() => disableKey(key.id)}
                        disabled={!canDisable}
                        title={
                          rowPendingAction === 'disable'
                            ? (copy.statusLabels.disable_pending as string)
                            : canDisable
                              ? copy.disableKey
                              : copy.disableUnavailable
                        }
                        aria-label={
                          rowPendingAction === 'disable'
                            ? (copy.statusLabels.disable_pending as string)
                            : copy.disableKey
                        }
                      >
                        <Ban className="size-4" />
                      </Button>
                      <Button
                        type="button"
                        variant="outline"
                        size="icon"
                        onClick={() => deleteKey(key.id)}
                        disabled={!canDelete}
                        title={
                          rowPendingAction === 'delete'
                            ? (copy.statusLabels.delete_pending as string)
                            : canDelete
                              ? copy.deleteKey
                              : copy.deleteUnavailable
                        }
                        aria-label={
                          rowPendingAction === 'delete'
                            ? (copy.statusLabels.delete_pending as string)
                            : copy.deleteKey
                        }
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
