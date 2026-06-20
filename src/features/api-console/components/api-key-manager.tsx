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
  const [name, setName] = useState(copy.defaultName);
  const [plainKey, setPlainKey] = useState('');
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);

  async function refreshKeys() {
    const response = await fetch('/api/apipool/keys');
    const payload = await response.json();
    if (payload.code === 0) {
      setKeys(payload.data.keys || []);
    }
  }

  async function createKey() {
    if (!creationEnabled) {
      setPlainKey('');
      setMessage(copy.keyCreationPaused);
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
          allowedModels: [APIPOOL_PUBLIC_CONFIG.defaultLaunchModel],
        }),
      });
      const payload = await response.json();
      if (payload.code !== 0) throw new Error(payload.message);
      setPlainKey(payload.data.plainKey || '');
      setKeys((prev) => [payload.data.key, ...prev]);
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
    const target = keys.find((key) => key.id === id);
    if (!target || !canDisableKeyStatus(target.status)) {
      setMessage(copy.disableNotAllowed);
      return;
    }

    const response = await fetch(`/api/apipool/keys/${id}/disable`, {
      method: 'POST',
    });
    const payload = await response.json();
    if (payload.code !== 0) {
      setMessage(payload.message);
      await refreshKeys();
      return;
    }
    setKeys((prev) =>
      prev.map((key) => (key.id === id ? payload.data.key : key))
    );
  }

  async function deleteKey(id: string) {
    setMessage('');
    const target = keys.find((key) => key.id === id);
    if (!target || !canDeleteKeyStatus(target.status)) {
      setMessage(copy.deleteNotAllowed);
      return;
    }

    const response = await fetch(`/api/apipool/keys/${id}`, {
      method: 'DELETE',
    });
    const payload = await response.json();
    if (payload.code !== 0) {
      setMessage(payload.message);
      await refreshKeys();
      return;
    }
    setKeys((prev) =>
      prev.map((key) => (key.id === id ? payload.data.key : key))
    );
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
          <Button onClick={createKey} disabled={loading || !creationEnabled}>
            <Plus className="size-4" />
            {loading ? copy.creating : copy.createKey}
          </Button>
        </div>
        <p className="mt-3 text-xs text-muted-foreground">
          {copy.creationTip}
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
                onClick={() => navigator.clipboard.writeText(plainKey)}
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
                const canDisable = canDisableKeyStatus(key.status);
                const canDelete = canDeleteKeyStatus(key.status);

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
                        variant="outline"
                        size="icon"
                        onClick={() =>
                          navigator.clipboard.writeText(key.keyMasked)
                        }
                        title={copy.copyMaskedKey}
                        aria-label={copy.copyMaskedKey}
                      >
                        <Copy className="size-4" />
                      </Button>
                      <Button
                        variant="outline"
                        size="icon"
                        onClick={() => disableKey(key.id)}
                        disabled={!canDisable}
                        title={
                          canDisable
                            ? copy.disableKey
                            : copy.disableUnavailable
                        }
                        aria-label={copy.disableKey}
                      >
                        <Ban className="size-4" />
                      </Button>
                      <Button
                        variant="outline"
                        size="icon"
                        onClick={() => deleteKey(key.id)}
                        disabled={!canDelete}
                        title={
                          canDelete
                            ? copy.deleteKey
                            : copy.deleteUnavailable
                        }
                        aria-label={copy.deleteKey}
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
