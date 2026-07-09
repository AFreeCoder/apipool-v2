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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/shared/components/ui/dialog';
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

type NoticeState = {
  tone: NoticeTone;
  text: string;
};

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
  creationEnabled = true,
}: {
  initialKeys: ApiKeyRow[];
  groups: ApiKeyGroup[];
  creationEnabled?: boolean;
}) {
  const t = useTranslations('dashboard.apiKeys');
  const [keys, setKeys] = useState<ApiKeyRow[]>(initialKeys);
  const [name, setName] = useState(t('defaultName'));
  const [selectedGroupSlug, setSelectedGroupSlug] = useState(
    groups[0]?.slug ?? ''
  );
  const [plainKey, setPlainKey] = useState('');
  const [notice, setNotice] = useState<NoticeState | null>(null);
  const [loading, setLoading] = useState(false);
  const [mounted, setMounted] = useState(false);
  // 删除会吊销远端 token 且完整 key 无法找回：必须显式确认，不能单击图标即删
  const [pendingDelete, setPendingDelete] = useState<ApiKeyRow | null>(null);
  const groupOptions = buildGroupSelectOptions(groups);
  const selectedGroupLabel =
    groupOptions.find((group) => group.value === selectedGroupSlug)?.label ??
    t('form.groupPlaceholder');

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
        body: JSON.stringify(
          buildCreateKeyRequest(name, selectedGroupSlug, t('defaultName'))
        ),
      });
      const payload = await response.json();
      if (payload.code !== 0) throw new Error(payload.message);
      setPlainKey(payload.data.plainKey || '');
      setKeys((prev) => [payload.data.key, ...prev]);
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
  }

  function requestDeleteKey(id: string) {
    const target = keys.find((key) => key.id === id);
    if (!target) return;
    setNotice(null);
    setPendingDelete(target);
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
            disabled={loading || !creationEnabled || !selectedGroupSlug}
          >
            <Plus className="size-4" />
            {loading ? t('form.creating') : t('form.create')}
          </Button>
        </div>
        <p className="text-muted-foreground mt-3 text-xs">{t('form.hint')}</p>
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
                onClick={() => navigator.clipboard.writeText(plainKey)}
                title={t('fullKey.copy')}
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
                      <StatusBadge
                        status={key.status}
                        label={t(`status.${key.status}`)}
                      />
                    </TableCell>
                    <TableCell>
                      {key.groupName ?? '—'}
                    </TableCell>
                    <TableCell className="space-x-2 text-right">
                      <Button
                        variant="outline"
                        size="icon"
                        onClick={() =>
                          navigator.clipboard.writeText(key.keyMasked)
                        }
                        title={t('table.copyMasked')}
                        aria-label={t('table.copyMasked')}
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
                        onClick={() => requestDeleteKey(key.id)}
                        disabled={!canDelete}
                        title={
                          canCleanup
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

      <Dialog
        open={pendingDelete !== null}
        onOpenChange={(open) => !open && setPendingDelete(null)}
      >
        <DialogContent className="sm:max-w-md">
          {pendingDelete ? (
            <DeleteKeyConfirmation
              target={pendingDelete}
              t={t}
              onCancel={() => setPendingDelete(null)}
              onConfirm={async () => {
                const id = pendingDelete.id;
                setPendingDelete(null);
                await deleteKey(id);
              }}
            />
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function DeleteKeyConfirmation({
  target,
  t,
  onCancel,
  onConfirm,
}: {
  target: ApiKeyRow;
  t: ReturnType<typeof useTranslations<'dashboard.apiKeys'>>;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  // 清理（失败/卡死态）与删除（活跃 key）都不可逆，但文案不同：
  // 前者是恢复手段，后者会立刻断掉仍在调用的应用。
  const isCleanup =
    !canDeleteKeyStatus(target.status) && canCleanupKeyStatus(target.status);

  return (
    <>
      <DialogHeader>
        <DialogTitle>
          {isCleanup
            ? t('table.confirmDelete.cleanupTitle')
            : t('table.confirmDelete.title')}
        </DialogTitle>
        <DialogDescription>
          {isCleanup
            ? t('table.confirmDelete.cleanupDescription')
            : t('table.confirmDelete.description')}
        </DialogDescription>
      </DialogHeader>
      <p className="text-muted-foreground font-mono text-xs">
        {target.displayName}
      </p>
      <DialogFooter>
        <Button variant="outline" onClick={onCancel}>
          {t('table.confirmDelete.cancel')}
        </Button>
        <Button variant="destructive" onClick={onConfirm}>
          {isCleanup
            ? t('table.confirmDelete.cleanupConfirm')
            : t('table.confirmDelete.confirm')}
        </Button>
      </DialogFooter>
    </>
  );
}
