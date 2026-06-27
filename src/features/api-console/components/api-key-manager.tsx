'use client';

import { useState } from 'react';
import {
  canCleanupKeyStatus,
  canDeleteKeyStatus,
  canDisableKeyStatus,
  type KeyLifecycleStatus,
} from '@/features/api-console/lib/status';
import { Ban, Copy, KeyRound, Plus, Trash2 } from 'lucide-react';

import { APIPOOL_PUBLIC_CONFIG } from '@/config/apipool/public';
import { Button } from '@/shared/components/ui/button';
import { Input } from '@/shared/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/shared/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/shared/components/ui/table';

import {
  applyApiKeyMutationResult,
  type ApiKeyGroup,
  buildCreateKeyRequest,
  buildGroupSelectOptions,
} from '../lib/key-request';

type ApiKeyRow = {
  id: string;
  displayName: string;
  keyMasked: string;
  status: KeyLifecycleStatus;
  allowedModels?: string[];
  groupName?: string | null;
  createdAt: string | Date;
  deletedAt?: string | Date | null;
};


const KEY_CREATION_PAUSED_MESSAGE =
  'API key creation is temporarily paused. Existing keys remain manageable.';

const STATUS_LABELS: Record<string, string> = {
  active: 'Active',
  disabled: 'Disabled',
  deleted: 'Deleted',
  creating_remote: 'Creating…',
  disable_pending: 'Disabling…',
  delete_pending: 'Deleting…',
};

function StatusBadge({ status }: { status: KeyLifecycleStatus }) {
  const className =
    status === 'active'
      ? 'bg-primary/10 text-primary'
      : status.startsWith('failed') ||
          status === 'remote_created_binding_failed'
        ? 'bg-destructive/10 text-destructive'
        : 'bg-muted text-muted-foreground';
  return (
    <span
      className={`rounded-md px-1.5 py-0.5 text-xs font-medium ${className}`}
    >
      {STATUS_LABELS[status] || status.replaceAll('_', ' ')}
    </span>
  );
}

export function ApiKeyManager({
  initialKeys,
  groups,
  callableByGroup,
  creationEnabled = true,
}: {
  initialKeys: ApiKeyRow[];
  groups: ApiKeyGroup[];
  callableByGroup: Record<string, string[]>;
  creationEnabled?: boolean;
}) {
  const [keys, setKeys] = useState<ApiKeyRow[]>(initialKeys);
  const [name, setName] = useState('Default APIPool key');
  const [selectedGroupSlug, setSelectedGroupSlug] = useState(
    groups[0]?.slug ?? ''
  );
  const [plainKey, setPlainKey] = useState('');
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);
  const groupOptions = buildGroupSelectOptions(groups);
  const selectedGroupModels = selectedGroupSlug
    ? (callableByGroup[selectedGroupSlug] ?? [])
    : [];

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
    if (!selectedGroupSlug) {
      setPlainKey('');
      setMessage('Select a group first.');
      return;
    }

    setLoading(true);
    setMessage('');
    setPlainKey('');
    try {
      const response = await fetch('/api/apipool/keys', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(buildCreateKeyRequest(name, selectedGroupSlug)),
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
    setKeys((prev) => applyApiKeyMutationResult(prev, payload.data.key));
  }

  async function deleteKey(id: string) {
    setMessage('');
    const target = keys.find((key) => key.id === id);
    if (
      !target ||
      (!canDeleteKeyStatus(target.status) &&
        !canCleanupKeyStatus(target.status))
    ) {
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
    setKeys((prev) => applyApiKeyMutationResult(prev, payload.data.key));
  }

  return (
    <div className="space-y-6">
      <div className="bg-card rounded-xl border p-5">
        <div className="mb-4 flex items-center gap-2 font-medium">
          <KeyRound className="size-4" />
          Create API Key
        </div>
        <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(12rem,16rem)_auto]">
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Key name"
          />
          <Select
            value={selectedGroupSlug || undefined}
            onValueChange={setSelectedGroupSlug}
            disabled={loading || groupOptions.length === 0}
          >
            <SelectTrigger aria-label="Group" className="w-full">
              <SelectValue placeholder="Select a group" />
            </SelectTrigger>
            <SelectContent>
              {groupOptions.map((group) => (
                <SelectItem key={group.value} value={group.value}>
                  {group.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            onClick={createKey}
            disabled={loading || !creationEnabled || !selectedGroupSlug}
          >
            <Plus className="size-4" />
            {loading ? 'Creating...' : 'Create key'}
          </Button>
        </div>
        <div className="bg-muted/40 mt-4 rounded-md border p-3">
          <div className="text-sm font-medium">Callable models</div>
          {selectedGroupModels.length > 0 ? (
            <div className="mt-2 flex flex-wrap gap-2">
              {selectedGroupModels.map((modelName) => (
                <span
                  key={modelName}
                  className="bg-background text-muted-foreground rounded-md px-2 py-1 text-xs"
                >
                  {modelName}
                </span>
              ))}
            </div>
          ) : (
            <p className="text-muted-foreground mt-2 text-xs">No callable models</p>
          )}
        </div>
        <p className="text-muted-foreground mt-3 text-xs">
          Add credit on the Balance tab before making paid calls. The full key
          is shown once after creation.
        </p>
        {!creationEnabled && (
          <p className="text-muted-foreground mt-2 text-xs">
            {KEY_CREATION_PAUSED_MESSAGE}
          </p>
        )}
        {message && (
          <p className="text-muted-foreground mt-3 text-sm">{message}</p>
        )}
        {plainKey && (
          <div className="bg-muted mt-4 rounded-md border p-4">
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

      <div className="bg-card rounded-xl border">
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
              <TableHead>Group</TableHead>
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
                const canCleanup = canCleanupKeyStatus(key.status);
                const canDelete = canDeleteKeyStatus(key.status) || canCleanup;

                return (
                  <TableRow key={key.id}>
                    <TableCell className="font-medium">
                      {key.displayName}
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {key.keyMasked}
                    </TableCell>
                    <TableCell>
                      <StatusBadge status={key.status} />
                    </TableCell>
                    <TableCell>{key.groupName ?? '—'}</TableCell>
                    <TableCell className="space-x-2 text-right">
                      <Button
                        variant="outline"
                        size="icon"
                        onClick={() =>
                          navigator.clipboard.writeText(key.keyMasked)
                        }
                        title="Copy masked key"
                        aria-label="Copy masked key"
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
                        aria-label="Disable key"
                      >
                        <Ban className="size-4" />
                      </Button>
                      <Button
                        variant="outline"
                        size="icon"
                        onClick={() => deleteKey(key.id)}
                        disabled={!canDelete}
                        title={
                          canCleanup
                            ? 'Clean up failed key'
                            : canDelete
                              ? 'Delete key'
                              : 'Key cannot be deleted in this state'
                        }
                        aria-label={
                          canCleanup ? 'Clean up failed key' : 'Delete key'
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
