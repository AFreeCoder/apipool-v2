'use client';

import { useState } from 'react';
import { Copy, KeyRound, Plus, Trash2, Ban } from 'lucide-react';

import { APIPOOL_PUBLIC_CONFIG } from '@/config/apipool/public';
import {
  canDeleteKeyStatus,
  canDisableKeyStatus,
  type KeyLifecycleStatus,
} from '@/features/api-console/lib/status';
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

const KEY_CREATION_PAUSED_MESSAGE =
  'API key creation is temporarily paused. Existing keys remain manageable.';

export function ApiKeyManager({
  initialKeys,
  creationEnabled = true,
}: {
  initialKeys: ApiKeyRow[];
  creationEnabled?: boolean;
}) {
  const [keys, setKeys] = useState<ApiKeyRow[]>(initialKeys);
  const [name, setName] = useState('Default APIPool key');
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
      setMessage(KEY_CREATION_PAUSED_MESSAGE);
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
      setMessage('Key created. The full key is shown once below.');
    } catch (error: any) {
      setMessage(error?.message || 'Create key failed');
      await refreshKeys();
    } finally {
      setLoading(false);
    }
  }

  async function disableKey(id: string) {
    setMessage('');
    const target = keys.find((key) => key.id === id);
    if (!target || !canDisableKeyStatus(target.status)) {
      setMessage('This key cannot be disabled in its current state.');
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
      setMessage('This key cannot be deleted in its current state.');
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
          Create API Key
        </div>
        <div className="flex flex-col gap-3 sm:flex-row">
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Key name"
          />
          <Button onClick={createKey} disabled={loading || !creationEnabled}>
            <Plus className="size-4" />
            {loading ? 'Creating...' : 'Create key'}
          </Button>
        </div>
        <p className="mt-3 text-xs text-muted-foreground">
          New users start with zero quota. An operator must apply quota before
          the key can complete paid calls.
        </p>
        {!creationEnabled && (
          <p className="mt-2 text-xs text-muted-foreground">
            {KEY_CREATION_PAUSED_MESSAGE}
          </p>
        )}
        {message && <p className="mt-3 text-sm text-muted-foreground">{message}</p>}
        {plainKey && (
          <div className="mt-4 rounded-md border bg-muted p-4">
            <div className="mb-2 text-sm font-medium">
              Full key. This is shown once.
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
                title="Copy full key"
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
            Keys for {APIPOOL_PUBLIC_CONFIG.apiBaseUrl}
          </h2>
        </div>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Masked key</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Models</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {keys.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="h-24 text-center">
                  No API keys yet.
                </TableCell>
              </TableRow>
            ) : (
              keys.map((key) => {
                const canDisable = canDisableKeyStatus(key.status);
                const canDelete = canDeleteKeyStatus(key.status);

                return (
                  <TableRow key={key.id}>
                    <TableCell>{key.displayName}</TableCell>
                    <TableCell className="font-mono text-xs">
                      {key.keyMasked}
                    </TableCell>
                    <TableCell>{key.status}</TableCell>
                    <TableCell className="text-xs">
                      {(key.allowedModels || []).join(', ')}
                    </TableCell>
                    <TableCell className="space-x-2 text-right">
                      <Button
                        variant="outline"
                        size="icon"
                        onClick={() =>
                          navigator.clipboard.writeText(key.keyMasked)
                        }
                        title="Copy masked key"
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
                            ? 'Disable key'
                            : 'Key cannot be disabled in this state'
                        }
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
                            ? 'Delete key'
                            : 'Key cannot be deleted in this state'
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
