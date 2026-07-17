'use client';

import { FormEvent, useEffect, useState } from 'react';
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
  inputMicroUsd: string;
  outputMicroUsd: string;
  imageInputMicroUsd: string;
  imageOutputMicroUsd: string;
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
  fixedPrice: string;
};

export type ModelAdminFormLabels = {
  modelId: string;
  displayName: string;
  vendor: string;
  categories: string;
  capabilities: string;
  inputMicroUsd: string;
  outputMicroUsd: string;
  imageInputMicroUsd: string;
  imageOutputMicroUsd: string;
};

type Candidate = {
  modelId: string;
  displayName: string;
  source: 'ratio' | 'fixed-price';
  inputMicroUsd: number | null;
  outputMicroUsd: number | null;
  imageInputMicroUsd: number | null;
  imageOutputMicroUsd: number | null;
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

function microUsdToDollars(value: number | null | undefined) {
  if (value === null || value === undefined) return '';
  return String(value / 1_000_000);
}

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
  const [inputMicroUsd, setInputMicroUsd] = useState(initial.inputMicroUsd);
  const [outputMicroUsd, setOutputMicroUsd] = useState(initial.outputMicroUsd);
  const [imageInputMicroUsd, setImageInputMicroUsd] = useState(
    initial.imageInputMicroUsd
  );
  const [imageOutputMicroUsd, setImageOutputMicroUsd] = useState(
    initial.imageOutputMicroUsd
  );
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [hasSearched, setHasSearched] = useState(false);
  const [searchError, setSearchError] = useState('');
  const [searching, setSearching] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
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

  function selectCandidate(candidate: Candidate) {
    setModelId(candidate.modelId);
    setDisplayName(candidate.displayName);
    setInputMicroUsd(microUsdToDollars(candidate.inputMicroUsd));
    setOutputMicroUsd(microUsdToDollars(candidate.outputMicroUsd));
    setImageInputMicroUsd(microUsdToDollars(candidate.imageInputMicroUsd));
    setImageOutputMicroUsd(microUsdToDollars(candidate.imageOutputMicroUsd));
    setCandidates([]);
    setHasSearched(false);
    setSearchError('');
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;

    const formData = new FormData(event.currentTarget);
    formData.set('categoryIds', JSON.stringify(categoryIds));
    formData.set('capabilityIds', JSON.stringify(capabilityIds));

    setSubmitting(true);
    try {
      const result = await action(formData);
      if (!result) throw new Error('No response received from server');

      if (result.message) {
        if (result.status === 'success') toast.success(result.message);
        else toast.error(result.message);
      }

      if (result.redirect_url) {
        router.push(result.redirect_url as any);
      }
    } catch (error: any) {
      toast.error(error?.message || 'Submit failed');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={submit} className="bg-card max-w-4xl rounded-lg border p-5">
      <div className="grid gap-5">
        <div className="grid gap-4">
          <label className="grid gap-2 text-sm">
            {labels.vendor}
            <select
              name="vendorId"
              value={vendorId}
              onChange={(event) => {
                setVendorId(event.target.value);
                setCandidates([]);
                setHasSearched(false);
                setSearchError('');
              }}
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
        </div>

        <div className="grid gap-4 md:grid-cols-2">
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
              Boolean(searchError) ||
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
                      onClick={() => selectCandidate(candidate)}
                      className="hover:bg-accent grid w-full gap-1 rounded-sm px-3 py-2 text-left text-sm"
                    >
                      <span className="font-mono">{candidate.modelId}</span>
                      <span className="text-muted-foreground text-xs">
                        {candidate.source === 'fixed-price'
                          ? messages.fixedPrice
                          : candidate.supportedEndpointTypes.join(', ')}
                      </span>
                    </button>
                  ))}
              </div>
            )}
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

        <div className="grid gap-4 md:grid-cols-4">
          <label className="grid gap-2 text-sm">
            {labels.inputMicroUsd}
            <Input
              name="inputMicroUsd"
              inputMode="decimal"
              value={inputMicroUsd}
              onChange={(event) => setInputMicroUsd(event.target.value)}
              required
            />
          </label>
          <label className="grid gap-2 text-sm">
            {labels.outputMicroUsd}
            <Input
              name="outputMicroUsd"
              inputMode="decimal"
              value={outputMicroUsd}
              onChange={(event) => setOutputMicroUsd(event.target.value)}
              required
            />
          </label>
          <label className="grid gap-2 text-sm">
            {labels.imageInputMicroUsd}
            <Input
              name="imageInputMicroUsd"
              inputMode="decimal"
              value={imageInputMicroUsd}
              onChange={(event) => setImageInputMicroUsd(event.target.value)}
            />
          </label>
          <label className="grid gap-2 text-sm">
            {labels.imageOutputMicroUsd}
            <Input
              name="imageOutputMicroUsd"
              inputMode="decimal"
              value={imageOutputMicroUsd}
              onChange={(event) => setImageOutputMicroUsd(event.target.value)}
            />
          </label>
        </div>

        <input
          type="hidden"
          name="categoryIds"
          value={JSON.stringify(categoryIds)}
        />
        <input
          type="hidden"
          name="capabilityIds"
          value={JSON.stringify(capabilityIds)}
        />

        <Button type="submit" className="w-fit" disabled={submitting}>
          {submitting ? <Loader2 className="size-4 animate-spin" /> : <Save />}
          {submitting ? messages.saving : messages.submit}
        </Button>
      </div>
    </form>
  );
}
