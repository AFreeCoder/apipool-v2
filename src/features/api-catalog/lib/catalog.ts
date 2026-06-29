import { APIPOOL_CONFIG, PRICE_DISCLAIMER_ZH } from '@/config/apipool';

export type ApiModelProvider = 'OpenAI' | 'Anthropic';
export type ApiModelCapability = 'text' | 'vision' | 'reasoning' | 'coding';
export type ApiModelStatus = 'available' | 'coming_soon';

// official = 官方正价渠道；deal = 短期特价渠道，与正价渠道分区展示、可能随时下架
export type ApiModelChannelTier = 'official' | 'deal';

export type ApiModel = {
  slug: string;
  modelId: string;
  displayName: string;
  provider: ApiModelProvider;
  category: 'llm';
  capabilities: ApiModelCapability[];
  shortDescription: string;
  longDescription: string;
  contextWindow: number;
  featured: boolean;
  smokeTested: boolean;
  status: ApiModelStatus;
  sortOrder: number;
  channelTier?: ApiModelChannelTier; // 缺省视为 official
  dealNote?: string; // 特价渠道说明（如有效期/限速）
  pricing: {
    inputPerMillionUsd: number;
    outputPerMillionUsd: number;
    officialInputPerMillionUsd?: number;
    officialOutputPerMillionUsd?: number;
    source: 'manual' | 'apipool-litellm-seed' | 'newapi-reference';
    note?: string;
  };
};

export function isDealModel(model: ApiModel) {
  return model.channelTier === 'deal';
}

export type ModelFilters = {
  vendor?: string;
  group?: string;
  category?: string;
  capability?: string;
  status?: string;
};

export type ModelFilterSearchParams = Record<
  string,
  string | string[] | undefined
>;

export const MODEL_PROVIDER_FILTERS = ['All', 'OpenAI', 'Anthropic'] as const;
export const MODEL_CAPABILITY_FILTERS = [
  'All',
  'text',
  'vision',
  'reasoning',
  'coding',
] as const;
export const MODEL_STATUS_FILTERS = [
  'All',
  'available',
  'coming_soon',
] as const;

function firstParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

export function parseModelFilters(
  params: ModelFilterSearchParams | ModelFilters = {}
): ModelFilters {
  const filters: ModelFilters = {};

  for (const key of [
    'vendor',
    'group',
    'category',
    'capability',
    'status',
  ] as const) {
    const value = firstParam(params[key]);
    if (value) filters[key] = value;
  }

  return filters;
}

export function buildModelFilterHref(
  current: ModelFilters,
  patch: ModelFilters
) {
  const filters: ModelFilters = { ...current };
  for (const key of [
    'vendor',
    'group',
    'category',
    'capability',
    'status',
  ] as const) {
    if (!(key in patch)) continue;

    const value = patch[key];
    if (value === undefined || value === '') {
      delete filters[key];
    } else {
      filters[key] = value;
    }
  }

  const params = new URLSearchParams();

  for (const key of [
    'vendor',
    'group',
    'category',
    'capability',
    'status',
  ] as const) {
    if (filters[key]) params.set(key, filters[key]);
  }

  const query = params.toString();
  return query ? `/models?${query}` : '/models';
}

export function formatMicroUsdPerMillion(micro: number): string {
  return `$${(micro / 1_000_000).toFixed(2)}`;
}

export const publicModels: ApiModel[] = [
  // test fixture only; runtime catalog reads DB-backed queries.ts.
  {
    slug: 'gpt-4o-mini',
    modelId: 'gpt-4o-mini',
    displayName: 'GPT-4o mini',
    provider: 'OpenAI',
    category: 'llm',
    capabilities: ['text', 'vision', 'coding'],
    shortDescription: 'Fast multimodal model for production API workflows.',
    longDescription:
      'GPT-4o mini is the APIPool MVP launch model for validating key creation, quota, usage, and disable flows.',
    contextWindow: 128000,
    featured: true,
    smokeTested: true,
    status: 'available',
    sortOrder: 10,
    pricing: {
      inputPerMillionUsd: 0.15,
      outputPerMillionUsd: 0.6,
      officialInputPerMillionUsd: 0.15,
      officialOutputPerMillionUsd: 0.6,
      source: 'manual',
      note: 'Launch smoke model. Recheck billing multiplier before public traffic.',
    },
  },
  {
    // 特价区示例：同一模型的短期特价渠道，独立条目、不与正价混排
    slug: 'gpt-4o-mini-deal',
    modelId: 'gpt-4o-mini',
    displayName: 'GPT-4o mini',
    provider: 'OpenAI',
    category: 'llm',
    capabilities: ['text', 'vision', 'coding'],
    shortDescription: 'Limited-time discounted route for GPT-4o mini.',
    longDescription:
      'Short-term discounted channel for GPT-4o mini. Same model and API, separate route that may rotate without notice.',
    contextWindow: 128000,
    featured: false,
    smokeTested: false,
    status: 'coming_soon',
    sortOrder: 11,
    channelTier: 'deal',
    dealNote: 'Limited-time route · may rotate without notice',
    pricing: {
      inputPerMillionUsd: 0.08,
      outputPerMillionUsd: 0.3,
      officialInputPerMillionUsd: 0.15,
      officialOutputPerMillionUsd: 0.6,
      source: 'manual',
      note: 'Demo deal entry. Replace with a real short-term channel before launch.',
    },
  },
  {
    slug: 'gpt-4o',
    modelId: 'gpt-4o',
    displayName: 'GPT-4o',
    provider: 'OpenAI',
    category: 'llm',
    capabilities: ['text', 'vision', 'reasoning'],
    shortDescription: 'General purpose multimodal model.',
    longDescription:
      'GPT-4o is listed as a candidate model until APIPool supply and smoke calls are confirmed.',
    contextWindow: 128000,
    featured: true,
    smokeTested: false,
    status: 'coming_soon',
    sortOrder: 20,
    pricing: {
      inputPerMillionUsd: 2.5,
      outputPerMillionUsd: 10,
      source: 'manual',
    },
  },
  {
    slug: 'gpt-4-1-mini',
    modelId: 'gpt-4.1-mini',
    displayName: 'GPT-4.1 mini',
    provider: 'OpenAI',
    category: 'llm',
    capabilities: ['text', 'coding', 'reasoning'],
    shortDescription: 'Efficient model for coding and structured tasks.',
    longDescription:
      'GPT-4.1 mini is kept as a candidate until routing is verified.',
    contextWindow: 1047576,
    featured: true,
    smokeTested: false,
    status: 'coming_soon',
    sortOrder: 30,
    pricing: {
      inputPerMillionUsd: 0.4,
      outputPerMillionUsd: 1.6,
      source: 'manual',
    },
  },
  {
    slug: 'claude-sonnet-4',
    modelId: 'claude-sonnet-4',
    displayName: 'Claude Sonnet 4',
    provider: 'Anthropic',
    category: 'llm',
    capabilities: ['text', 'coding', 'reasoning'],
    shortDescription: 'Strong coding and agentic workflow model.',
    longDescription:
      'Claude Sonnet 4 is a candidate model for APIPool users after supply validation.',
    contextWindow: 200000,
    featured: true,
    smokeTested: false,
    status: 'coming_soon',
    sortOrder: 40,
    pricing: {
      inputPerMillionUsd: 3,
      outputPerMillionUsd: 15,
      source: 'manual',
    },
  },
  {
    slug: 'claude-3-5-sonnet',
    modelId: 'claude-3.5-sonnet',
    displayName: 'Claude 3.5 Sonnet',
    provider: 'Anthropic',
    category: 'llm',
    capabilities: ['text', 'vision', 'coding'],
    shortDescription: 'Balanced Anthropic model for developer workloads.',
    longDescription:
      'Claude 3.5 Sonnet remains hidden from available inventory until smoke calls pass.',
    contextWindow: 200000,
    featured: true,
    smokeTested: false,
    status: 'coming_soon',
    sortOrder: 50,
    pricing: {
      inputPerMillionUsd: 3,
      outputPerMillionUsd: 15,
      source: 'manual',
    },
  },
  {
    slug: 'claude-haiku',
    modelId: 'claude-haiku',
    displayName: 'Claude Haiku',
    provider: 'Anthropic',
    category: 'llm',
    capabilities: ['text', 'coding'],
    shortDescription: 'Low-latency Anthropic candidate model.',
    longDescription:
      'Claude Haiku is staged as a coming soon model until route and quota behavior are verified.',
    contextWindow: 200000,
    featured: false,
    smokeTested: false,
    status: 'coming_soon',
    sortOrder: 60,
    pricing: {
      inputPerMillionUsd: 0.25,
      outputPerMillionUsd: 1.25,
      source: 'manual',
    },
  },
];

type LegacyModelFilters = ModelFilters & {
  provider?: ApiModelProvider | 'All';
};

export function filterModels(
  models: ApiModel[],
  filters: LegacyModelFilters = {}
) {
  return models
    .filter((model) => {
      if (filters.vendor) {
        return model.provider.toLowerCase() === filters.vendor.toLowerCase();
      }
      if (filters.provider && filters.provider !== 'All') {
        return model.provider === filters.provider;
      }
      return true;
    })
    .filter((model) => {
      if (filters.capability && filters.capability !== 'All') {
        return model.capabilities.includes(
          filters.capability as ApiModelCapability
        );
      }
      return true;
    })
    .filter((model) => {
      if (filters.status && filters.status !== 'All') {
        return model.status === filters.status;
      }
      return true;
    })
    .sort((a, b) => a.sortOrder - b.sortOrder);
}

export function getModelBySlug(slug: string) {
  return publicModels.find((model) => model.slug === slug);
}

export function isModelCallable(model: ApiModel) {
  return model.status === 'available' && model.smokeTested;
}

export function getFeaturedModels(models = publicModels, limit = 6) {
  return models
    .filter(isModelCallable)
    .filter((model) => model.featured)
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .slice(0, limit);
}

export function getDefaultCallableModelId(
  configuredModelId = APIPOOL_CONFIG.defaultLaunchModel
) {
  const configuredModel = publicModels.find(
    (model) =>
      model.modelId === configuredModelId || model.slug === configuredModelId
  );

  if (configuredModel && isModelCallable(configuredModel)) {
    return configuredModel.modelId;
  }

  const fallbackModel = publicModels.find(isModelCallable);
  if (!fallbackModel) {
    throw new Error('No smoke-tested APIPool launch model is configured');
  }

  return fallbackModel.modelId;
}

export function formatModelPrice(model: ApiModel) {
  const { inputPerMillionUsd, outputPerMillionUsd } = model.pricing;
  return {
    summary: `$${inputPerMillionUsd.toFixed(2)} input / $${outputPerMillionUsd.toFixed(2)} output per 1M tokens`,
    input: `$${inputPerMillionUsd.toFixed(2)} / 1M input tokens`,
    output: `$${outputPerMillionUsd.toFixed(2)} / 1M output tokens`,
    disclaimer: PRICE_DISCLAIMER_ZH,
  };
}

export function getQuickstartCurl(modelId = getDefaultCallableModelId()) {
  return `curl ${APIPOOL_CONFIG.apiBaseUrl}/v1/chat/completions \\
  -H "Authorization: Bearer $APIPOOL_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "${modelId}",
    "messages": [{ "role": "user", "content": "Hello!" }]
  }'`;
}

export function getCallableModelQuickstartCurl(model: ApiModel) {
  if (!isModelCallable(model)) return null;
  return getQuickstartCurl(model.modelId);
}
