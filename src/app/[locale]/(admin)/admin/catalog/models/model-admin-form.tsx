'use client';

import { FormEvent, useEffect, useRef, useState } from 'react';
import { Loader2, Save, Search } from 'lucide-react';
import { toast } from 'sonner';

import { useRouter } from '@/core/i18n/navigation';
import { Button } from '@/shared/components/ui/button';
import { Input } from '@/shared/components/ui/input';

export type ModelAdminFormOption = {
  value: string;
  title: string;
};

export type ModelAdminFormInitial = {
  modelId: string;
  displayName: string;
  vendorId: string;
  categoryIds: string[];
  capabilityIds: string[];
};

export type ModelAdminFormActionResult = {
  status?: 'success' | 'error';
  message?: string;
  redirect_url?: string;
};

export type ModelAdminFormMessages = {
  submit: string;
  saving: string;
  searchPlaceholder: string;
  searching: string;
  noCandidates: string;
};

export type ModelAdminFormLabels = {
  modelId: string;
  displayName: string;
  vendor: string;
  categories: string;
  capabilities: string;
};

type Candidate = {
  modelId: string;
  displayName: string;
  source: 'ratio' | 'fixed-price';
  supportedEndpointTypes: string[];
};

type Props = {
  initial: ModelAdminFormInitial;
  vendors: ModelAdminFormOption[];
  categories: ModelAdminFormOption[];
  capabilities: ModelAdminFormOption[];
  labels: ModelAdminFormLabels;
  messages: ModelAdminFormMessages;
  action: (data: FormData) => Promise<ModelAdminFormActionResult | void>;
};

function parseMultiSelect(element: HTMLSelectElement) {
  return Array.from(element.selectedOptions).map((option) => option.value);
}

export function ModelAdminForm({
  initial,
  vendors,
  categories,
  capabilities,
  labels,
  messages,
  action,
}: Props) {
  const router = useRouter();
  const [modelId, setModelId] = useState(initial.modelId);
  const [displayName, setDisplayName] = useState(initial.displayName);
  const [vendorId, setVendorId] = useState(initial.vendorId);
  const [categoryIds, setCategoryIds] = useState(initial.categoryIds);
  const [capabilityIds, setCapabilityIds] = useState(initial.capabilityIds);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [hasSearched, setHasSearched] = useState(false);
  const [searchError, setSearchError] = useState('');
  const [searching, setSearching] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const skipNextSearch = useRef(Boolean(initial.modelId));

  useEffect(() => {
    if (skipNextSearch.current) {
      skipNextSearch.current = false;
      return;
    }
    const keyword = modelId.trim();
    if (!vendorId || keyword.length < 2) {
      setCandidates([]);
      setHasSearched(false);
      setSearchError('');
      return;
    }

    setCandidates([]);
    setHasSearched(false);
    setSearchError('');
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setSearching(true);
      try {
        const params = new URLSearchParams({ vendorId, keyword });
        const response = await fetch(
          `/api/apipool/admin/catalog/models/search?${params.toString()}`,
          { signal: controller.signal }
        );
        const payload = await response.json();
        if (payload.code !== 0) throw new Error(payload.message);
        setCandidates(payload.data?.models ?? []);
        setHasSearched(true);
      } catch (error: any) {
        if (error?.name !== 'AbortError') {
          setCandidates([]);
          setHasSearched(true);
          setSearchError(error?.message || messages.noCandidates);
        }
      } finally {
        setSearching(false);
      }
    }, 250);

    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [modelId, messages.noCandidates, vendorId]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;
    const formData = new FormData(event.currentTarget);
    formData.set('categoryIds', JSON.stringify(categoryIds));
    formData.set('capabilityIds', JSON.stringify(capabilityIds));

    setSubmitting(true);
    try {
      const result = await action(formData);
      if (!result) throw new Error('服务器未返回结果');
      if (result.message) {
        if (result.status === 'success') toast.success(result.message);
        else toast.error(result.message);
      }
      if (result.redirect_url) router.push(result.redirect_url as any);
    } catch (error: any) {
      toast.error(error?.message || '提交失败');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={submit} className="bg-card max-w-4xl rounded-lg border p-5">
      <div className="grid gap-6">
        <div className="grid gap-4 md:grid-cols-2">
          <label className="grid gap-2 text-sm">
            {labels.vendor}
            <select
              name="vendorId"
              value={vendorId}
              onChange={(event) => setVendorId(event.target.value)}
              className="border-input bg-background h-9 rounded-md border px-3 text-sm"
              required
            >
              {vendors.map((vendor) => (
                <option key={vendor.value} value={vendor.value}>
                  {vendor.title}
                </option>
              ))}
            </select>
          </label>

          <label className="grid gap-2 text-sm">
            {labels.displayName}
            <Input
              name="displayName"
              value={displayName}
              onChange={(event) => setDisplayName(event.target.value)}
              required
            />
          </label>
        </div>

        <label className="relative grid gap-2 text-sm">
          {labels.modelId}
          <div className="relative">
            <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2" />
            <Input
              name="modelId"
              value={modelId}
              onChange={(event) => setModelId(event.target.value)}
              className="pl-9 font-mono"
              placeholder={messages.searchPlaceholder}
              required
            />
          </div>
          {(searching ||
            hasSearched ||
            searchError ||
            candidates.length > 0) && (
            <div className="bg-popover absolute top-full z-20 mt-1 max-h-64 w-full overflow-auto rounded-md border p-1 shadow-md">
              {searching && (
                <div className="text-muted-foreground px-3 py-2 text-sm">
                  {messages.searching}
                </div>
              )}
              {!searching && searchError && (
                <div className="text-destructive px-3 py-2 text-sm">
                  {searchError}
                </div>
              )}
              {!searching &&
                !searchError &&
                hasSearched &&
                candidates.length === 0 && (
                  <div className="text-muted-foreground px-3 py-2 text-sm">
                    {messages.noCandidates}
                  </div>
                )}
              {!searching &&
                !searchError &&
                candidates.map((candidate) => (
                  <button
                    key={candidate.modelId}
                    type="button"
                    onClick={() => {
                      skipNextSearch.current = true;
                      setModelId(candidate.modelId);
                      setDisplayName(candidate.displayName);
                      setCandidates([]);
                      setHasSearched(false);
                    }}
                    className="hover:bg-accent grid w-full gap-1 rounded-sm px-3 py-2 text-left text-sm"
                  >
                    <span className="font-mono">{candidate.modelId}</span>
                    <span className="text-muted-foreground text-xs">
                      {candidate.supportedEndpointTypes.join(', ') ||
                        candidate.source}
                    </span>
                  </button>
                ))}
            </div>
          )}
        </label>

        <div className="grid gap-4 md:grid-cols-2">
          <label className="grid gap-2 text-sm">
            {labels.categories}
            <select
              multiple
              value={categoryIds}
              onChange={(event) =>
                setCategoryIds(parseMultiSelect(event.currentTarget))
              }
              className="border-input bg-background min-h-28 rounded-md border px-3 py-2 text-sm"
              required
            >
              {categories.map((category) => (
                <option key={category.value} value={category.value}>
                  {category.title}
                </option>
              ))}
            </select>
          </label>

          <label className="grid gap-2 text-sm">
            {labels.capabilities}
            <select
              multiple
              value={capabilityIds}
              onChange={(event) =>
                setCapabilityIds(parseMultiSelect(event.currentTarget))
              }
              className="border-input bg-background min-h-28 rounded-md border px-3 py-2 text-sm"
            >
              {capabilities.map((capability) => (
                <option key={capability.value} value={capability.value}>
                  {capability.title}
                </option>
              ))}
            </select>
          </label>
        </div>

        <Button type="submit" disabled={submitting}>
          {submitting ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <Save className="size-4" />
          )}
          {submitting ? messages.saving : messages.submit}
        </Button>
      </div>
    </form>
  );
}
