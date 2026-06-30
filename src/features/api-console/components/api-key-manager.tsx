'use client';

import { useEffect, useState } from 'react';
import {
  canCleanupKeyStatus,
  canDeleteKeyStatus,
  canDisableKeyStatus,
  type KeyLifecycleStatus,
} from '@/features/api-console/lib/status';
import {
  AlertCircle,
  Ban,
  CheckCircle2,
  Copy,
  Info,
  KeyRound,
  Plus,
  Trash2,
} from 'lucide-react';
import { useTranslations } from 'next-intl';

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
  buildCreateKeyRequest,
  buildGroupSelectOptions,
  type ApiKeyGroup,
} from '../lib/key-request';

type ApiKeyRow = {
  id: string;
  displayName: string;
  keyMasked: string;
  status: KeyLifecycleStatus;
  allowedModels?: string[];
  groupSlug?: string | null;
  groupName?: string | null;
  createdAt: string | Date;
  deletedAt?: string | Date | null;
};

type NoticeTone = 'error' | 'info' | 'success';
type GroupMessages = Record<string, string>;
type KeyMutationAction = 'disable' | 'delete';

type NoticeState = {
  tone: NoticeTone;
  text: string;
};

const KEY_STATUS_FALLBACK_LABELS = {
  active: '启用',
  disabled: '已停用',
  deleted: '已删除',
  creating_remote: '创建中…',
  disable_pending: '停用中…',
  delete_pending: '删除中…',
  failed_retriable: '失败，可重试',
  failed_terminal: '失败',
  remote_created_binding_failed: '远端 Key 需清理',
} satisfies Record<KeyLifecycleStatus, string>;

function localizeApiKeyRowGroupName(
  messages: GroupMessages,
  key: Pick<ApiKeyRow, 'groupSlug' | 'groupName'>
) {
  return (key.groupSlug ? messages[key.groupSlug] : undefined) ?? key.groupName;
}

function localizeKeyStatus(
  status: KeyLifecycleStatus,
  translate: (key: string) => string
) {
  try {
    const label = translate(`status.${status}`);
    if (label && label !== `status.${status}` && label !== status) {
      return label;
    }
  } catch {
    // Fall back to safe product copy instead of exposing internal state names.
  }

  return KEY_STATUS_FALLBACK_LABELS[status];
}

function occupiesCustomerKeySlot(key: ApiKeyRow) {
  return !['deleted', 'failed_retriable', 'failed_terminal'].includes(
    key.status
  );
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
  label,
}: {
  status: KeyLifecycleStatus;
  label: string;
}) {
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
      {label}
    </span>
  );
}

function ApiKeyNotice({ notice }: { notice: NoticeState }) {
  const toneConfig = {
    error: {
      icon: AlertCircle,
      className:
        'border-destructive/30 bg-destructive/10 text-destructive shadow-xs',
      iconClassName: 'text-destructive',
    },
    info: {
      icon: Info,
      className: 'border-border bg-muted/50 text-muted-foreground',
      iconClassName: 'text-muted-foreground',
    },
    success: {
      icon: CheckCircle2,
      className: 'border-primary/20 bg-primary/10 text-primary',
      iconClassName: 'text-primary',
    },
  } satisfies Record<
    NoticeTone,
    {
      icon: typeof AlertCircle;
      className: string;
      iconClassName: string;
    }
  >;
  const config = toneConfig[notice.tone];
  const Icon = config.icon;

  return (
    <div
      role={notice.tone === 'error' ? 'alert' : 'status'}
      aria-live={notice.tone === 'error' ? 'assertive' : 'polite'}
      className={`mt-4 flex items-start gap-2 rounded-md border px-3 py-2 text-sm ${config.className}`}
    >
      <Icon className={`mt-0.5 size-4 shrink-0 ${config.iconClassName}`} />
      <p className="min-w-0 leading-5">{notice.text}</p>
    </div>
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
  const t = useTranslations('dashboard.apiKeys');
  const groupMessages = t.raw('groups') as GroupMessages;
  const [keys, setKeys] = useState<ApiKeyRow[]>(initialKeys);
  const [name, setName] = useState(t('defaultName'));
  const [selectedGroupSlug, setSelectedGroupSlug] = useState(
    groups[0]?.slug ?? ''
  );
  const [plainKey, setPlainKey] = useState('');
  const [plainKeysById, setPlainKeysById] = useState<Record<string, string>>(
    {}
  );
  const [notice, setNotice] = useState<NoticeState | null>(null);
  const [loading, setLoading] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [pendingKeyAction, setPendingKeyAction] = useState<{
    id: string;
    action: KeyMutationAction;
  } | null>(null);
  const isMutatingKey = pendingKeyAction !== null;
  const hasExistingCustomerKey = keys.some(occupiesCustomerKeySlot);
  const groupOptions = buildGroupSelectOptions(groups);
  const selectedGroupLabel =
    groupOptions.find((group) => group.value === selectedGroupSlug)?.label ??
    t('form.groupPlaceholder');
  const selectedGroupModels = selectedGroupSlug
    ? (callableByGroup[selectedGroupSlug] ?? [])
    : [];

  useEffect(() => {
    setMounted(true);
  }, []);

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
      setNotice({ tone: 'info', text: t('creationPaused') });
      return;
    }
    if (hasExistingCustomerKey) {
      setPlainKey('');
      setNotice({ tone: 'info', text: t('notices.oneKeyLimit') });
      return;
    }
    if (!selectedGroupSlug) {
      setPlainKey('');
      setNotice({ tone: 'error', text: t('notices.selectGroup') });
      return;
    }

    setLoading(true);
    setNotice(null);
    setPlainKey('');
    try {
      const response = await fetch('/api/apipool/keys', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(buildCreateKeyRequest(name, selectedGroupSlug)),
      });
      const payload = await response.json();
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
      setNotice({
        tone: 'success',
        text: t('notices.created'),
      });
    } catch (error: any) {
      setNotice({
        tone: 'error',
        text: error?.message || t('notices.createFailed'),
      });
      await refreshKeys();
    } finally {
      setLoading(false);
    }
  }

  async function disableKey(id: string) {
    setNotice(null);
    const target = keys.find((key) => key.id === id);
    if (!target || !canDisableKeyStatus(target.status)) {
      setNotice({
        tone: 'error',
        text: t('notices.disableUnavailable'),
      });
      return;
    }

    setPendingKeyAction({ id, action: 'disable' });
    try {
      const response = await fetch(`/api/apipool/keys/${id}/disable`, {
        method: 'POST',
      });
      const payload = await response.json();
      if (payload.code !== 0) {
        setNotice({ tone: 'error', text: payload.message });
        await refreshKeys();
        return;
      }
      setKeys((prev) => applyApiKeyMutationResult(prev, payload.data.key));
    } catch (error: any) {
      setNotice({
        tone: 'error',
        text: error?.message || t('notices.disableFailed'),
      });
      await refreshKeys();
    } finally {
      setPendingKeyAction(null);
    }
  }

  async function deleteKey(id: string) {
    setNotice(null);
    const target = keys.find((key) => key.id === id);
    if (
      !target ||
      (!canDeleteKeyStatus(target.status) &&
        !canCleanupKeyStatus(target.status))
    ) {
      setNotice({
        tone: 'error',
        text: t('notices.deleteUnavailable'),
      });
      return;
    }

    setPendingKeyAction({ id, action: 'delete' });
    try {
      const response = await fetch(`/api/apipool/keys/${id}`, {
        method: 'DELETE',
      });
      const payload = await response.json();
      if (payload.code !== 0) {
        setNotice({ tone: 'error', text: payload.message });
        await refreshKeys();
        return;
      }
      setKeys((prev) => applyApiKeyMutationResult(prev, payload.data.key));
      setPlainKeysById((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
    } catch (error: any) {
      setNotice({
        tone: 'error',
        text: error?.message || t('notices.deleteFailed'),
      });
      await refreshKeys();
    } finally {
      setPendingKeyAction(null);
    }
  }

  async function copyText(text: string) {
    const copied = await copyToClipboard(text);
    if (!copied) {
      setNotice({ tone: 'error', text: t('notices.copyFailed') });
    }
  }

  return (
    <div className="space-y-6">
      <div className="bg-card rounded-xl border p-5">
        <div className="mb-4 flex items-center gap-2 font-medium">
          <KeyRound className="size-4" />
          {t('form.title')}
        </div>
        <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(12rem,16rem)_auto]">
          <Input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder={t('form.namePlaceholder')}
          />
          {mounted ? (
            <Select
              value={selectedGroupSlug || undefined}
              onValueChange={setSelectedGroupSlug}
              disabled={loading || groupOptions.length === 0}
            >
              <SelectTrigger
                aria-label={t('form.groupLabel')}
                className="w-full"
              >
                <SelectValue placeholder={t('form.groupPlaceholder')} />
              </SelectTrigger>
              <SelectContent>
                {groupOptions.map((group) => (
                  <SelectItem key={group.value} value={group.value}>
                    {group.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <Button
              type="button"
              variant="outline"
              disabled
              aria-label={t('form.groupLabel')}
              className="w-full justify-start"
            >
              <span className="truncate">{selectedGroupLabel}</span>
            </Button>
          )}
          <Button
            onClick={createKey}
            disabled={
              loading ||
              isMutatingKey ||
              !creationEnabled ||
              !selectedGroupSlug ||
              hasExistingCustomerKey
            }
          >
            <Plus className="size-4" />
            {loading ? t('form.creating') : t('form.create')}
          </Button>
        </div>
        <div className="bg-muted/40 mt-4 rounded-md border p-3">
          <div className="text-sm font-medium">{t('form.callableModels')}</div>
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
            <p className="text-muted-foreground mt-2 text-xs">
              {t('form.noCallableModels')}
            </p>
          )}
        </div>
        <p className="text-muted-foreground mt-3 text-xs">
          {hasExistingCustomerKey ? t('form.oneKeyLimitHint') : t('form.hint')}
        </p>
        {!creationEnabled && (
          <p className="text-muted-foreground mt-2 text-xs">
            {t('creationPaused')}
          </p>
        )}
        {notice && <ApiKeyNotice notice={notice} />}
        {plainKey && (
          <div className="bg-muted mt-4 rounded-md border p-4">
            <div className="mb-2 text-sm font-medium">{t('fullKey.title')}</div>
            <div className="flex items-center gap-2">
              <code className="min-w-0 flex-1 overflow-x-auto text-sm">
                {plainKey}
              </code>
              <Button
                type="button"
                variant="outline"
                size="icon"
                onClick={() => copyText(plainKey)}
                title={t('fullKey.copy')}
                aria-label={t('fullKey.copy')}
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
            {t('table.title', { baseUrl: APIPOOL_PUBLIC_CONFIG.apiBaseUrl })}
          </h2>
        </div>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t('table.name')}</TableHead>
              <TableHead>{t('table.maskedKey')}</TableHead>
              <TableHead>{t('table.status')}</TableHead>
              <TableHead>{t('table.group')}</TableHead>
              <TableHead className="text-right">{t('table.actions')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {keys.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="h-24 text-center">
                  {t('table.empty')}
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
                const canCleanup = canCleanupKeyStatus(key.status);
                const canDelete =
                  (canDeleteKeyStatus(key.status) || canCleanup) &&
                  !isMutatingKey;

                return (
                  <TableRow key={key.id}>
                    <TableCell className="font-medium">
                      {key.displayName}
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {key.keyMasked}
                    </TableCell>
                    <TableCell>
                      <StatusBadge
                        status={key.status}
                        label={localizeKeyStatus(key.status, t)}
                      />
                    </TableCell>
                    <TableCell>
                      {localizeApiKeyRowGroupName(groupMessages, key) ?? '—'}
                    </TableCell>
                    <TableCell className="space-x-2 text-right">
                      <Button
                        variant="outline"
                        size="icon"
                        onClick={() =>
                          copyText(plainKeyForRow || key.keyMasked)
                        }
                        title={
                          plainKeyForRow
                            ? t('fullKey.copy')
                            : t('table.copyMasked')
                        }
                        aria-label={
                          plainKeyForRow
                            ? t('fullKey.copy')
                            : t('table.copyMasked')
                        }
                      >
                        <Copy className="size-4" />
                      </Button>
                      <Button
                        variant="outline"
                        size="icon"
                        onClick={() => disableKey(key.id)}
                        disabled={!canDisable}
                        title={
                          rowPendingAction === 'disable'
                            ? t('status.disable_pending')
                            : canDisable
                            ? t('table.disable')
                            : t('table.disableUnavailable')
                        }
                        aria-label={t('table.disable')}
                      >
                        <Ban className="size-4" />
                      </Button>
                      <Button
                        variant="outline"
                        size="icon"
                        onClick={() => deleteKey(key.id)}
                        disabled={!canDelete}
                        title={
                          rowPendingAction === 'delete'
                            ? t('status.delete_pending')
                            : canCleanup
                            ? t('table.cleanup')
                            : canDelete
                              ? t('table.delete')
                              : t('table.deleteUnavailable')
                        }
                        aria-label={
                          canCleanup ? t('table.cleanup') : t('table.delete')
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
