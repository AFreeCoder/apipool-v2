'use client';

import { FormEvent, useEffect, useRef, useState } from 'react';
import {
  Loader2,
  Plus,
  Save,
  Search,
  Trash2,
  WandSparkles,
} from 'lucide-react';
import { toast } from 'sonner';

import { useRouter } from '@/core/i18n/navigation';
import { Button } from '@/shared/components/ui/button';
import { Input } from '@/shared/components/ui/input';

const BILLING_CAPABILITY_KEYS = [
  'cached_input',
  'cache_write',
  'cache_ttl_split',
  'image_input',
  'cached_image_input',
  'image_output',
  'long_context',
  'web_search',
] as const;

type BillingCapabilityKey = (typeof BILLING_CAPABILITY_KEYS)[number];
type BillingCapabilities = Record<BillingCapabilityKey, boolean>;

type TierRow = {
  skuKey: string;
  price: string;
  note: string;
};

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
  billingScheme: 'token' | 'per_call';
  inputMicroUsd: string;
  cachedInputMicroUsd: string;
  cacheWriteMicroUsd: string;
  cacheWrite5mMicroUsd: string;
  cacheWrite1hMicroUsd: string;
  outputMicroUsd: string;
  imageInputMicroUsd: string;
  cachedImageInputMicroUsd: string;
  imageOutputMicroUsd: string;
  webSearchMicroUsd: string;
  longContextThresholdTokens: string;
  inputLongMicroUsd: string;
  cachedInputLongMicroUsd: string;
  cacheWriteLongMicroUsd: string;
  outputLongMicroUsd: string;
  billingCapabilities: BillingCapabilities;
  sourceSupportedEndpointTypes: string[];
  tiers: TierRow[];
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
  prefillReference: string;
  addTier: string;
  removeTier: string;
};

export type ModelAdminFormLabels = {
  modelId: string;
  displayName: string;
  vendor: string;
  categories: string;
  capabilities: string;
  billingScheme: string;
  tokenScheme: string;
  perCallScheme: string;
  tokenPrices: string;
  tierPrices: string;
  billingCapabilities: string;
  inputMicroUsd: string;
  cachedInputMicroUsd: string;
  cacheWriteMicroUsd: string;
  cacheWrite5mMicroUsd: string;
  cacheWrite1hMicroUsd: string;
  outputMicroUsd: string;
  imageInputMicroUsd: string;
  cachedImageInputMicroUsd: string;
  imageOutputMicroUsd: string;
  webSearchMicroUsd: string;
  longContextThresholdTokens: string;
  inputLongMicroUsd: string;
  cachedInputLongMicroUsd: string;
  cacheWriteLongMicroUsd: string;
  outputLongMicroUsd: string;
  skuKey: string;
  unitPrice: string;
  note: string;
  capabilityLabels: Record<BillingCapabilityKey, string>;
};

type Candidate = {
  modelId: string;
  displayName: string;
  source: 'ratio' | 'fixed-price';
  inputMicroUsd: number | null;
  cachedInputMicroUsd?: number | null;
  cacheWriteMicroUsd?: number | null;
  cacheWrite1hMicroUsd?: number | null;
  outputMicroUsd: number | null;
  imageInputMicroUsd: number | null;
  imageOutputMicroUsd: number | null;
  fixedPriceMicroUsd?: number | null;
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

function PriceInput({
  name,
  label,
  value,
  onChange,
  required = false,
}: {
  name: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  required?: boolean;
}) {
  return (
    <label className="grid gap-2 text-sm">
      {label}
      <Input
        name={name}
        inputMode="decimal"
        min="0"
        step="any"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        required={required}
      />
    </label>
  );
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
  const [billingScheme, setBillingScheme] = useState(initial.billingScheme);
  const [inputMicroUsd, setInputMicroUsd] = useState(initial.inputMicroUsd);
  const [cachedInputMicroUsd, setCachedInputMicroUsd] = useState(
    initial.cachedInputMicroUsd
  );
  const [cacheWriteMicroUsd, setCacheWriteMicroUsd] = useState(
    initial.cacheWriteMicroUsd
  );
  const [cacheWrite5mMicroUsd, setCacheWrite5mMicroUsd] = useState(
    initial.cacheWrite5mMicroUsd
  );
  const [cacheWrite1hMicroUsd, setCacheWrite1hMicroUsd] = useState(
    initial.cacheWrite1hMicroUsd
  );
  const [outputMicroUsd, setOutputMicroUsd] = useState(initial.outputMicroUsd);
  const [imageInputMicroUsd, setImageInputMicroUsd] = useState(
    initial.imageInputMicroUsd
  );
  const [cachedImageInputMicroUsd, setCachedImageInputMicroUsd] = useState(
    initial.cachedImageInputMicroUsd
  );
  const [imageOutputMicroUsd, setImageOutputMicroUsd] = useState(
    initial.imageOutputMicroUsd
  );
  const [webSearchMicroUsd, setWebSearchMicroUsd] = useState(
    initial.webSearchMicroUsd
  );
  const [longContextThresholdTokens, setLongContextThresholdTokens] = useState(
    initial.longContextThresholdTokens
  );
  const [inputLongMicroUsd, setInputLongMicroUsd] = useState(
    initial.inputLongMicroUsd
  );
  const [cachedInputLongMicroUsd, setCachedInputLongMicroUsd] = useState(
    initial.cachedInputLongMicroUsd
  );
  const [cacheWriteLongMicroUsd, setCacheWriteLongMicroUsd] = useState(
    initial.cacheWriteLongMicroUsd
  );
  const [outputLongMicroUsd, setOutputLongMicroUsd] = useState(
    initial.outputLongMicroUsd
  );
  const [billingCapabilities, setBillingCapabilities] = useState(
    initial.billingCapabilities
  );
  const [sourceSupportedEndpointTypes, setSourceSupportedEndpointTypes] =
    useState(initial.sourceSupportedEndpointTypes);
  const [tiers, setTiers] = useState(initial.tiers);
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [referenceCandidate, setReferenceCandidate] =
    useState<Candidate | null>(null);
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

  function selectCandidate(candidate: Candidate) {
    skipNextSearch.current = true;
    setModelId(candidate.modelId);
    setDisplayName(candidate.displayName);
    setSourceSupportedEndpointTypes(candidate.supportedEndpointTypes);
    setReferenceCandidate(candidate);
    setCandidates([]);
    setHasSearched(false);
    setSearchError('');
  }

  function prefillReference() {
    if (!referenceCandidate) return;
    const candidate = referenceCandidate;
    if (candidate.source === 'fixed-price') {
      setBillingScheme('per_call');
      setTiers([
        {
          skuKey: 'default',
          price: microUsdToDollars(candidate.fixedPriceMicroUsd),
          note: '',
        },
      ]);
      return;
    }

    setBillingScheme('token');
    setInputMicroUsd(microUsdToDollars(candidate.inputMicroUsd));
    setCachedInputMicroUsd(microUsdToDollars(candidate.cachedInputMicroUsd));
    setCacheWriteMicroUsd(
      candidate.cacheWrite1hMicroUsd === null ||
        candidate.cacheWrite1hMicroUsd === undefined
        ? microUsdToDollars(candidate.cacheWriteMicroUsd)
        : ''
    );
    setCacheWrite5mMicroUsd(
      candidate.cacheWrite1hMicroUsd !== null &&
        candidate.cacheWrite1hMicroUsd !== undefined
        ? microUsdToDollars(candidate.cacheWriteMicroUsd)
        : ''
    );
    setCacheWrite1hMicroUsd(microUsdToDollars(candidate.cacheWrite1hMicroUsd));
    setOutputMicroUsd(microUsdToDollars(candidate.outputMicroUsd));
    setImageInputMicroUsd(microUsdToDollars(candidate.imageInputMicroUsd));
    setImageOutputMicroUsd(microUsdToDollars(candidate.imageOutputMicroUsd));
    setBillingCapabilities((current) => ({
      ...current,
      cached_input: candidate.cachedInputMicroUsd != null,
      cache_write: candidate.cacheWriteMicroUsd != null,
      cache_ttl_split: candidate.cacheWrite1hMicroUsd != null,
      image_input: candidate.imageInputMicroUsd != null,
      image_output: candidate.imageOutputMicroUsd != null,
    }));
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;

    const formData = new FormData(event.currentTarget);
    formData.set('categoryIds', JSON.stringify(categoryIds));
    formData.set('capabilityIds', JSON.stringify(capabilityIds));
    formData.set(
      'billingCapabilitiesJson',
      JSON.stringify(billingCapabilities)
    );
    formData.set('tiersJson', JSON.stringify(tiers));
    formData.set(
      'sourceSupportedEndpointTypes',
      JSON.stringify(sourceSupportedEndpointTypes)
    );

    setSubmitting(true);
    try {
      const result = await action(formData);
      if (!result) throw new Error('服务器未返回结果');

      if (result.message) {
        if (result.status === 'success') toast.success(result.message);
        else toast.error(result.message);
      }

      if (result.redirect_url) {
        router.push(result.redirect_url as any);
      }
    } catch (error: any) {
      toast.error(error?.message || '提交失败');
    } finally {
      setSubmitting(false);
    }
  }

  const showLongPrices =
    billingCapabilities.long_context || Boolean(longContextThresholdTokens);

  return (
    <form onSubmit={submit} className="bg-card max-w-6xl rounded-lg border p-5">
      <div className="grid gap-6">
        <div className="grid gap-4 md:grid-cols-2">
          <label className="grid gap-2 text-sm">
            {labels.vendor}
            <select
              name="vendorId"
              value={vendorId}
              onChange={(event) => {
                setVendorId(event.target.value);
                setReferenceCandidate(null);
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
          <div className="flex gap-2">
            <div className="relative flex-1">
              <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2" />
              <Input
                name="modelId"
                value={modelId}
                onChange={(event) => {
                  setModelId(event.target.value);
                  setReferenceCandidate(null);
                }}
                className="pl-9 font-mono"
                placeholder={messages.searchPlaceholder}
                required
              />
            </div>
            <Button
              type="button"
              variant="outline"
              disabled={!referenceCandidate}
              onClick={prefillReference}
            >
              <WandSparkles className="size-4" />
              {messages.prefillReference}
            </Button>
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

        <fieldset className="grid gap-3 rounded-md border p-4">
          <legend className="px-2 text-sm font-medium">
            {labels.billingScheme}
          </legend>
          <div className="flex gap-6">
            {(['token', 'per_call'] as const).map((scheme) => (
              <label key={scheme} className="flex items-center gap-2 text-sm">
                <input
                  type="radio"
                  name="billingScheme"
                  value={scheme}
                  checked={billingScheme === scheme}
                  onChange={() => setBillingScheme(scheme)}
                />
                {scheme === 'token' ? labels.tokenScheme : labels.perCallScheme}
              </label>
            ))}
          </div>
        </fieldset>

        <fieldset className="grid gap-3 rounded-md border p-4">
          <legend className="px-2 text-sm font-medium">
            {labels.billingCapabilities}
          </legend>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {BILLING_CAPABILITY_KEYS.map((key) => (
              <label key={key} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={billingCapabilities[key]}
                  onChange={(event) =>
                    setBillingCapabilities((current) => ({
                      ...current,
                      [key]: event.target.checked,
                    }))
                  }
                />
                {labels.capabilityLabels[key]}
              </label>
            ))}
          </div>
        </fieldset>

        {billingScheme === 'token' ? (
          <fieldset className="grid gap-4 rounded-md border p-4">
            <legend className="px-2 text-sm font-medium">
              {labels.tokenPrices}
            </legend>
            <div className="grid gap-4 md:grid-cols-3 lg:grid-cols-4">
              <PriceInput
                name="inputMicroUsd"
                label={labels.inputMicroUsd}
                value={inputMicroUsd}
                onChange={setInputMicroUsd}
                required
              />
              <PriceInput
                name="cachedInputMicroUsd"
                label={labels.cachedInputMicroUsd}
                value={cachedInputMicroUsd}
                onChange={setCachedInputMicroUsd}
              />
              <PriceInput
                name="cacheWriteMicroUsd"
                label={labels.cacheWriteMicroUsd}
                value={cacheWriteMicroUsd}
                onChange={setCacheWriteMicroUsd}
              />
              <PriceInput
                name="cacheWrite5mMicroUsd"
                label={labels.cacheWrite5mMicroUsd}
                value={cacheWrite5mMicroUsd}
                onChange={setCacheWrite5mMicroUsd}
              />
              <PriceInput
                name="cacheWrite1hMicroUsd"
                label={labels.cacheWrite1hMicroUsd}
                value={cacheWrite1hMicroUsd}
                onChange={setCacheWrite1hMicroUsd}
              />
              <PriceInput
                name="outputMicroUsd"
                label={labels.outputMicroUsd}
                value={outputMicroUsd}
                onChange={setOutputMicroUsd}
              />
              <PriceInput
                name="imageInputMicroUsd"
                label={labels.imageInputMicroUsd}
                value={imageInputMicroUsd}
                onChange={setImageInputMicroUsd}
              />
              <PriceInput
                name="cachedImageInputMicroUsd"
                label={labels.cachedImageInputMicroUsd}
                value={cachedImageInputMicroUsd}
                onChange={setCachedImageInputMicroUsd}
              />
              <PriceInput
                name="imageOutputMicroUsd"
                label={labels.imageOutputMicroUsd}
                value={imageOutputMicroUsd}
                onChange={setImageOutputMicroUsd}
              />
              <PriceInput
                name="webSearchMicroUsd"
                label={labels.webSearchMicroUsd}
                value={webSearchMicroUsd}
                onChange={setWebSearchMicroUsd}
              />
              <label className="grid gap-2 text-sm">
                {labels.longContextThresholdTokens}
                <Input
                  name="longContextThresholdTokens"
                  type="number"
                  min="1"
                  step="1"
                  value={longContextThresholdTokens}
                  onChange={(event) =>
                    setLongContextThresholdTokens(event.target.value)
                  }
                />
              </label>
            </div>
            {showLongPrices && (
              <div className="grid gap-4 border-t pt-4 md:grid-cols-4">
                <PriceInput
                  name="inputLongMicroUsd"
                  label={labels.inputLongMicroUsd}
                  value={inputLongMicroUsd}
                  onChange={setInputLongMicroUsd}
                />
                <PriceInput
                  name="cachedInputLongMicroUsd"
                  label={labels.cachedInputLongMicroUsd}
                  value={cachedInputLongMicroUsd}
                  onChange={setCachedInputLongMicroUsd}
                />
                <PriceInput
                  name="cacheWriteLongMicroUsd"
                  label={labels.cacheWriteLongMicroUsd}
                  value={cacheWriteLongMicroUsd}
                  onChange={setCacheWriteLongMicroUsd}
                />
                <PriceInput
                  name="outputLongMicroUsd"
                  label={labels.outputLongMicroUsd}
                  value={outputLongMicroUsd}
                  onChange={setOutputLongMicroUsd}
                />
              </div>
            )}
          </fieldset>
        ) : (
          <fieldset className="grid gap-4 rounded-md border p-4">
            <legend className="px-2 text-sm font-medium">
              {labels.tierPrices}
            </legend>
            {tiers.map((tier, index) => (
              <div
                key={`${index}-${tier.skuKey}`}
                className="grid gap-3 md:grid-cols-[1fr_1fr_1.5fr_auto]"
              >
                <Input
                  aria-label={labels.skuKey}
                  placeholder={labels.skuKey}
                  value={tier.skuKey}
                  onChange={(event) =>
                    setTiers((current) =>
                      current.map((item, itemIndex) =>
                        itemIndex === index
                          ? { ...item, skuKey: event.target.value }
                          : item
                      )
                    )
                  }
                  required
                />
                <Input
                  aria-label={labels.unitPrice}
                  placeholder={labels.unitPrice}
                  inputMode="decimal"
                  min="0"
                  step="any"
                  value={tier.price}
                  onChange={(event) =>
                    setTiers((current) =>
                      current.map((item, itemIndex) =>
                        itemIndex === index
                          ? { ...item, price: event.target.value }
                          : item
                      )
                    )
                  }
                  required
                />
                <Input
                  aria-label={labels.note}
                  placeholder={labels.note}
                  value={tier.note}
                  onChange={(event) =>
                    setTiers((current) =>
                      current.map((item, itemIndex) =>
                        itemIndex === index
                          ? { ...item, note: event.target.value }
                          : item
                      )
                    )
                  }
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={messages.removeTier}
                  onClick={() =>
                    setTiers((current) =>
                      current.filter((_, itemIndex) => itemIndex !== index)
                    )
                  }
                >
                  <Trash2 className="size-4" />
                </Button>
              </div>
            ))}
            <Button
              type="button"
              variant="outline"
              className="w-fit"
              onClick={() =>
                setTiers((current) => [
                  ...current,
                  { skuKey: '', price: '', note: '' },
                ])
              }
            >
              <Plus className="size-4" />
              {messages.addTier}
            </Button>
          </fieldset>
        )}

        <input
          type="hidden"
          name="billingCapabilitiesJson"
          value={JSON.stringify(billingCapabilities)}
        />
        <input type="hidden" name="tiersJson" value={JSON.stringify(tiers)} />
        <input
          type="hidden"
          name="sourceSupportedEndpointTypes"
          value={JSON.stringify(sourceSupportedEndpointTypes)}
        />
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
