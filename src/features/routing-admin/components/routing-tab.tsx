'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';

import { Button } from '@/shared/components/ui/button';
import { Input } from '@/shared/components/ui/input';
import { Label } from '@/shared/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/shared/components/ui/select';

import { apiRequest, Notice, Panel, RecordTable } from './primitives';

type GroupRow = {
  id: string;
  name: string;
  newapiGroup: string;
  newapiGroupRatioBps: number | null;
};
type ModelRow = { id: string; modelId: string; displayName: string };
type BasePriceRow = {
  modelId: string;
  baseInputMicroUsd: number | null;
  baseCachedInputMicroUsd: number | null;
  baseCacheWrite5mMicroUsd: number | null;
  baseCacheWrite1hMicroUsd: number | null;
  baseOutputMicroUsd: number | null;
};
type RouteRow = {
  id: string;
  portalGroupId: string;
  portalModelId: string;
  newapiGroup: string;
  version: number;
};
type PriceRow = {
  id: string;
  portalGroupId: string;
  portalModelId: string;
  refNewapiGroup: string | null;
  version: number;
};
type RoutingMatrix = {
  groups: GroupRow[];
  models: ModelRow[];
  basePrices: BasePriceRow[];
  routes: RouteRow[];
  prices: PriceRow[];
};

const PRICE_FIELDS = [
  'inputMicroUsdPerM',
  'cachedInputMicroUsdPerM',
  'cacheWrite5mMicroUsdPerM',
  'cacheWrite1hMicroUsdPerM',
  'outputMicroUsdPerM',
] as const;
type PriceField = (typeof PRICE_FIELDS)[number];
type PriceForm = Record<PriceField, string>;

const EMPTY_PRICE: PriceForm = {
  inputMicroUsdPerM: '',
  cachedInputMicroUsdPerM: '',
  cacheWrite5mMicroUsdPerM: '',
  cacheWrite1hMicroUsdPerM: '',
  outputMicroUsdPerM: '',
};

export function RoutingTab() {
  const t = useTranslations('admin.apipool');
  const [matrix, setMatrix] = useState<RoutingMatrix | null>(null);
  const [groupId, setGroupId] = useState('');
  const [modelId, setModelId] = useState('');
  const [targetGroup, setTargetGroup] = useState('');
  const [price, setPrice] = useState<PriceForm>(EMPTY_PRICE);
  const [retireReason, setRetireReason] = useState('');
  const [failures, setFailures] = useState<Array<{ check: string; message: string }>>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [worstCase, setWorstCase] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiRequest<RoutingMatrix>(
        '/api/apipool/admin/gateway/routing'
      );
      setMatrix(data);
      setGroupId((current) => current || data.groups[0]?.id || '');
      setModelId((current) => current || data.models[0]?.modelId || '');
      setTargetGroup(
        (current) => current || data.groups[0]?.newapiGroup || ''
      );
      setNotice(null);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : t('common.failed'));
    } finally {
      setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void load();
  }, [load]);

  const selectedGroup = matrix?.groups.find((group) => group.id === groupId);
  const selectedModel = matrix?.models.find((model) => model.modelId === modelId);
  const activeRoute = matrix?.routes.find(
    (row) => row.portalGroupId === groupId && row.portalModelId === modelId
  );
  const activePrice = matrix?.prices.find(
    (row) => row.portalGroupId === groupId && row.portalModelId === modelId
  );
  const basePrice = matrix?.basePrices.find(
    (row) => row.modelId === selectedModel?.id
  );
  const atomicRemap = Boolean(
    activePrice && targetGroup && activePrice.refNewapiGroup !== targetGroup
  );

  const suggestedPrice = useMemo(() => {
    const ratio = selectedGroup?.newapiGroupRatioBps ?? 10_000;
    const ceil = (value: number | null | undefined) =>
      value == null ? '' : String(Math.ceil((value * ratio) / 10_000));
    return {
      inputMicroUsdPerM: ceil(basePrice?.baseInputMicroUsd),
      cachedInputMicroUsdPerM: ceil(basePrice?.baseCachedInputMicroUsd),
      cacheWrite5mMicroUsdPerM: ceil(basePrice?.baseCacheWrite5mMicroUsd),
      cacheWrite1hMicroUsdPerM: ceil(basePrice?.baseCacheWrite1hMicroUsd),
      outputMicroUsdPerM: ceil(basePrice?.baseOutputMicroUsd),
    };
  }, [basePrice, selectedGroup]);

  useEffect(() => {
    setTargetGroup(activeRoute?.newapiGroup || selectedGroup?.newapiGroup || '');
    setPrice(suggestedPrice);
  }, [activeRoute?.newapiGroup, selectedGroup?.newapiGroup, suggestedPrice]);

  function numericPrice() {
    return Object.fromEntries(
      PRICE_FIELDS.map((field) => [field, Number(price[field])])
    );
  }

  async function publish(kind: 'price' | 'route') {
    if (!groupId || !modelId) return;
    setLoading(true);
    setNotice(null);
    setFailures([]);
    try {
      const body =
        kind === 'price'
          ? { kind: 'price', portalGroupId: groupId, portalModelId: modelId, price: numericPrice(), sourceNote: t('routing.reviewedSource') }
          : {
              kind: 'route',
              portalGroupId: groupId,
              portalModelId: modelId,
              newapiGroup: targetGroup,
              ...(atomicRemap ? { remapPrice: { ...numericPrice(), sourceNote: t('routing.remapSource') } } : {}),
            };
      const result = await apiRequest<{
        ok: boolean;
        version?: number;
        worstCaseMicroUsd?: string;
        failures?: Array<{ check: string; message: string }>;
      }>('/api/apipool/admin/gateway/routing', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!result.ok) {
        setFailures(result.failures || []);
        return;
      }
      setWorstCase(result.worstCaseMicroUsd ?? null);
      setNotice(t('routing.published', { version: result.version ?? 0 }));
      await load();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : t('common.failed'));
    } finally {
      setLoading(false);
    }
  }

  async function retire() {
    if (!retireReason.trim()) {
      setNotice(t('routing.reasonRequired'));
      return;
    }
    setLoading(true);
    try {
      await apiRequest('/api/apipool/admin/gateway/routing/retire', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ portalGroupId: groupId, portalModelId: modelId, reason: retireReason }),
      });
      setNotice(t('routing.retired'));
      setRetireReason('');
      await load();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : t('common.failed'));
    } finally {
      setLoading(false);
    }
  }

  const routeRows = (matrix?.routes ?? []).map((row) => ({
    ...row,
    priceVersion:
      matrix?.prices.find(
        (priceRow) =>
          priceRow.portalGroupId === row.portalGroupId &&
          priceRow.portalModelId === row.portalModelId
      )?.version ?? null,
    refNewapiGroup:
      matrix?.prices.find(
        (priceRow) =>
          priceRow.portalGroupId === row.portalGroupId &&
          priceRow.portalModelId === row.portalModelId
      )?.refNewapiGroup ?? null,
  }));

  return (
    <div className="space-y-4">
      <Panel title={t('routing.matrix')} description={t('routing.matrixHelp')}>
        <RecordTable
          rows={routeRows as unknown as Array<Record<string, unknown>>}
          columns={[
            { key: 'portalGroupId', label: t('routing.group') },
            { key: 'portalModelId', label: t('routing.model') },
            { key: 'newapiGroup', label: t('routing.targetGroup') },
            { key: 'version', label: t('routing.routeVersion') },
            { key: 'priceVersion', label: t('routing.priceVersion') },
            { key: 'refNewapiGroup', label: t('routing.refGroup') },
          ]}
          emptyLabel={t('common.empty')}
        />
      </Panel>

      <Panel title={t('routing.wizard')} description={t('routing.wizardHelp')}>
        <div className="space-y-4">
          <div className="grid gap-3 md:grid-cols-3">
            <div className="space-y-2">
              <Label>{t('routing.group')}</Label>
              <Select value={groupId} onValueChange={setGroupId}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>{matrix?.groups.map((group) => <SelectItem key={group.id} value={group.id}>{group.name}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>{t('routing.model')}</Label>
              <Select value={modelId} onValueChange={setModelId}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>{matrix?.models.map((model) => <SelectItem key={model.id} value={model.modelId}>{model.displayName}</SelectItem>)}</SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>{t('routing.targetGroup')}</Label>
              <Select value={targetGroup} onValueChange={setTargetGroup}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>{matrix?.groups.map((group) => <SelectItem key={group.newapiGroup} value={group.newapiGroup}>{group.newapiGroup}</SelectItem>)}</SelectContent>
              </Select>
            </div>
          </div>
          {atomicRemap && <div className="border-warning/40 bg-warning/10 rounded-md border p-3 text-sm">{t('routing.atomicRemap')}</div>}
          <div className="grid gap-3 md:grid-cols-5">
            {PRICE_FIELDS.map((field) => (
              <div key={field} className="space-y-2">
                <Label htmlFor={field}>{t(`routing.priceFields.${field}`)}</Label>
                <Input id={field} type="number" min="1" value={price[field]} onChange={(event) => setPrice((current) => ({ ...current, [field]: event.target.value }))} />
              </div>
            ))}
          </div>
          {failures.length > 0 && (
            <ul className="text-destructive list-disc space-y-1 pl-5 text-sm">
              {failures.map((item) => <li key={`${item.check}:${item.message}`}>{item.check}: {item.message}</li>)}
            </ul>
          )}
          {worstCase && <div className="text-muted-foreground text-sm">{t('routing.worstCase', { value: worstCase })} · {t('routing.exposure', { value: (BigInt(worstCase) * BigInt(10)).toString() })}</div>}
          <Notice message={notice} />
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => void publish('price')} disabled={loading}>{t('routing.publishPrice')}</Button>
            <Button onClick={() => void publish('route')} disabled={loading}>{atomicRemap ? t('routing.publishAtomic') : t('routing.publishRoute')}</Button>
          </div>
          <div className="grid gap-2 md:grid-cols-[1fr_auto]">
            <Input value={retireReason} onChange={(event) => setRetireReason(event.target.value)} placeholder={t('routing.retireReason')} />
            <Button variant="destructive" onClick={() => void retire()} disabled={loading}>{t('routing.retire')}</Button>
          </div>
        </div>
      </Panel>
    </div>
  );
}
