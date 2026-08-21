/**
 * Catalog Initialization Script
 *
 * Usage:
 *   npx tsx scripts/init-catalog.ts
 */

import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { and, eq, inArray, isNull } from 'drizzle-orm';

import { envConfigs } from '@/config';
import type {
  catalogCapability as catalogCapabilityTable,
  catalogCategory as catalogCategoryTable,
  catalogGroup as catalogGroupTable,
  catalogModelCapability as catalogModelCapabilityTable,
  catalogModelListing as catalogModelListingTable,
  catalogModelPrice as catalogModelPriceTable,
  catalogModelPricingProfile as catalogModelPricingProfileTable,
  catalogModelPricingRate as catalogModelPricingRateTable,
  catalogModel as catalogModelTable,
  catalogStatus as catalogStatusTable,
  catalogVendor as catalogVendorTable,
  gatewayTask as gatewayTaskTable,
  modelPriceVersion as modelPriceVersionTable,
  modelRoute as modelRouteTable,
  newApiKeyBinding as newApiKeyBindingTable,
  portalApiKey as portalApiKeyTable,
  requestLedger as requestLedgerTable,
} from '@/config/db/schema';
import { db } from '@/core/db';
import {
  compileSkuRule,
  SKU_RULE_COMPILER_VERSION,
} from '@/features/api-catalog/lib/sku-rule';
import { getUuid } from '@/shared/lib/hash';

type CatalogSchemaTables = {
  catalogVendor: typeof catalogVendorTable;
  catalogCapability: typeof catalogCapabilityTable;
  catalogCategory: typeof catalogCategoryTable;
  catalogStatus: typeof catalogStatusTable;
  catalogGroup: typeof catalogGroupTable;
  catalogModel: typeof catalogModelTable;
  catalogModelCapability: typeof catalogModelCapabilityTable;
  catalogModelPrice: typeof catalogModelPriceTable;
  catalogModelPricingProfile: typeof catalogModelPricingProfileTable;
  catalogModelPricingRate: typeof catalogModelPricingRateTable;
  catalogModelListing: typeof catalogModelListingTable;
  gatewayTask: typeof gatewayTaskTable;
  modelPriceVersion: typeof modelPriceVersionTable;
  modelRoute: typeof modelRouteTable;
  newApiKeyBinding: typeof newApiKeyBindingTable;
  portalApiKey: typeof portalApiKeyTable;
  requestLedger: typeof requestLedgerTable;
};

type CatalogVendorRow = typeof catalogVendorTable.$inferSelect;
type CatalogCapabilityRow = typeof catalogCapabilityTable.$inferSelect;
type CatalogStatusRow = typeof catalogStatusTable.$inferSelect;
type CatalogGroupRow = typeof catalogGroupTable.$inferSelect;
type CatalogModelRow = typeof catalogModelTable.$inferSelect;
type CatalogModelPricingProfileRow =
  typeof catalogModelPricingProfileTable.$inferSelect;

const vendors = [
  { slug: 'openai', name: 'OpenAI', sortOrder: 10 },
  { slug: 'anthropic', name: 'Anthropic', sortOrder: 20 },
  { slug: 'google', name: 'Google', sortOrder: 30 },
];

const categories = [
  { slug: 'llm', name: 'LLM', sortOrder: 10 },
  { slug: 'embedding', name: 'Embedding', sortOrder: 20 },
  { slug: 'image', name: 'Image', sortOrder: 30 },
  { slug: 'audio', name: 'Audio', sortOrder: 40 },
  { slug: 'video', name: 'Video', sortOrder: 50 },
];

const capabilities = [
  { slug: 'text', name: 'Text', sortOrder: 10 },
  { slug: 'vision', name: 'Vision', sortOrder: 20 },
  { slug: 'video', name: 'Video', sortOrder: 30 },
  { slug: 'audio', name: 'Audio', sortOrder: 40 },
];

const statuses = [
  {
    slug: 'available',
    name: 'Available',
    isCallable: true,
    isPublicVisible: true,
    sortOrder: 10,
  },
  {
    slug: 'coming_soon',
    name: 'Coming soon',
    isCallable: false,
    isPublicVisible: true,
    sortOrder: 20,
  },
  {
    slug: 'retired',
    name: 'Retired',
    isCallable: false,
    isPublicVisible: false,
    sortOrder: 30,
  },
];

const LEGACY_DISCOUNT_GROUP_SLUG = 'codex-discount';
const DISCOUNT_GROUP_SLUG = 'discount';
const RETIRED_DISCOUNT_GROUP_SLUG = 'discount-1';
const OFFICIAL_GROUP_NAME = '官方分组';
const OFFICIAL_GROUP_DESCRIPTION = '官方稳定线路，适合生产使用。';
const DISCOUNT_GROUP_NAME = '特惠分组';
const DISCOUNT_GROUP_DESCRIPTION = '特惠模型线路，每个模型独立映射上游分组。';

const groups = [
  {
    slug: 'official',
    name: OFFICIAL_GROUP_NAME,
    userDescription: OFFICIAL_GROUP_DESCRIPTION,
    allowCreateKey: true,
    sortOrder: 10,
    status: 'active',
  },
  {
    slug: DISCOUNT_GROUP_SLUG,
    name: DISCOUNT_GROUP_NAME,
    userDescription: DISCOUNT_GROUP_DESCRIPTION,
    allowCreateKey: true,
    sortOrder: 20,
    status: 'active',
  },
];

const discountGptModels = [
  {
    modelId: 'gpt-5.3-codex-spark',
    displayName: 'GPT-5.3 Codex Spark',
    contextWindow: 128000,
    rates: { input: 1_750_000, cached_input: 175_000, output: 14_000_000 },
  },
  {
    modelId: 'gpt-5.4',
    displayName: 'GPT-5.4',
    contextWindow: 1_100_000,
    rates: { input: 2_500_000, cached_input: 250_000, output: 15_000_000 },
  },
  {
    modelId: 'gpt-5.4-mini',
    displayName: 'GPT-5.4 Mini',
    contextWindow: 400000,
    rates: { input: 750_000, cached_input: 75_000, output: 4_500_000 },
  },
  {
    modelId: 'gpt-5.5',
    displayName: 'GPT-5.5',
    contextWindow: 1_100_000,
    rates: { input: 5_000_000, cached_input: 500_000, output: 30_000_000 },
  },
  {
    modelId: 'gpt-5.6-luna',
    displayName: 'GPT-5.6 Luna',
    contextWindow: 1_100_000,
    rates: { input: 1_000_000, cached_input: 100_000, output: 6_000_000 },
  },
  {
    modelId: 'gpt-5.6-terra',
    displayName: 'GPT-5.6 Terra',
    contextWindow: 1_100_000,
    rates: { input: 2_500_000, cached_input: 250_000, output: 15_000_000 },
  },
  {
    modelId: 'gpt-5.6-sol',
    displayName: 'GPT-5.6 Sol',
    contextWindow: 1_100_000,
    rates: { input: 5_000_000, cached_input: 500_000, output: 30_000_000 },
  },
];

const models = [
  {
    modelId: 'gpt-4o-mini',
    displayName: 'GPT-4o mini',
    vendorSlug: 'openai',
    contextWindow: 128000,
    category: 'llm',
  },
  ...discountGptModels.map((model) => ({
    modelId: model.modelId,
    displayName: model.displayName,
    vendorSlug: 'openai',
    contextWindow: model.contextWindow,
    category: 'llm',
  })),
  {
    modelId: 'gpt-image-2',
    displayName: 'gpt-image-2',
    vendorSlug: 'openai',
    contextWindow: null,
    category: 'image',
  },
];

const modelCapabilities = [
  { modelId: 'gpt-4o-mini', capabilitySlug: 'text' },
  { modelId: 'gpt-4o-mini', capabilitySlug: 'vision' },
  ...discountGptModels.map((model) => ({
    modelId: model.modelId,
    capabilitySlug: 'text',
  })),
  { modelId: 'gpt-image-2', capabilitySlug: 'vision' },
];

const listings = [
  {
    modelId: 'gpt-4o-mini',
    groupSlug: 'official',
    newapiGroup: 'official',
    statusSlug: 'available',
    pricingProfileName: '默认售卖价',
    discountRateBps: null,
    sortOrder: 10,
  },
  {
    modelId: 'gpt-image-2',
    groupSlug: 'official',
    newapiGroup: 'official',
    statusSlug: 'available',
    pricingProfileName: '官方 Token 售卖价',
    discountRateBps: null,
    sortOrder: 20,
  },
  ...discountGptModels.map((model) => ({
    modelId: model.modelId,
    groupSlug: DISCOUNT_GROUP_SLUG,
    newapiGroup: 'codex特惠',
    statusSlug: 'available',
    pricingProfileName: '默认售卖价',
    discountRateBps: 700,
    sortOrder: 0,
  })),
  {
    modelId: 'gpt-image-2',
    groupSlug: DISCOUNT_GROUP_SLUG,
    newapiGroup: 'codex特惠',
    statusSlug: 'available',
    pricingProfileName: 'Codex 特惠按张价',
    discountRateBps: null,
    sortOrder: 10,
  },
];

const gptImageCodexSkuRuleSource =
  'when resolution is missing => "default"\nwhen resolution == "auto" => "default"\nwhen resolution == "1k" => "default"\nelse => "resolution=${resolution}"';
const gptImageCodexSkuRule = compileSkuRule(gptImageCodexSkuRuleSource, {
  allowedFields: ['quality', 'size', 'resolution'],
});
const gptImageCodexRuleHash = createHash('sha256')
  .update(JSON.stringify(gptImageCodexSkuRule))
  .digest('hex');

const pricingProfiles = [
  {
    modelId: 'gpt-4o-mini',
    name: '默认售卖价',
    pricingBasis: 'token',
    quantityMeter: null,
    skuRuleSource: null,
    skuRuleAstJson: null,
    compilerVersion: null,
    ruleHash: null,
    rates: [
      {
        meterKey: 'input',
        skuKey: 'default',
        unitSize: 1_000_000,
        priceMicroUsd: 150000,
      },
      {
        meterKey: 'output',
        skuKey: 'default',
        unitSize: 1_000_000,
        priceMicroUsd: 600000,
      },
    ],
  },
  ...discountGptModels.map((model) => ({
    modelId: model.modelId,
    name: '默认售卖价',
    pricingBasis: 'token',
    quantityMeter: null,
    skuRuleSource: null,
    skuRuleAstJson: null,
    compilerVersion: null,
    ruleHash: null,
    rates: Object.entries(model.rates).map(([meterKey, priceMicroUsd]) => ({
      meterKey,
      skuKey: 'default',
      unitSize: 1_000_000,
      priceMicroUsd,
    })),
  })),
  {
    modelId: 'gpt-image-2',
    name: '官方 Token 售卖价',
    pricingBasis: 'token',
    quantityMeter: null,
    skuRuleSource: null,
    skuRuleAstJson: null,
    compilerVersion: null,
    ruleHash: null,
    rates: [
      {
        meterKey: 'input',
        skuKey: 'default',
        unitSize: 1_000_000,
        priceMicroUsd: 5_000_000,
      },
      {
        meterKey: 'cached_input',
        skuKey: 'default',
        unitSize: 1_000_000,
        priceMicroUsd: 5_000_000,
      },
      {
        meterKey: 'image_input',
        skuKey: 'default',
        unitSize: 1_000_000,
        priceMicroUsd: 8_000_000,
      },
      {
        meterKey: 'cached_image_input',
        skuKey: 'default',
        unitSize: 1_000_000,
        priceMicroUsd: 8_000_000,
      },
      {
        meterKey: 'image_output',
        skuKey: 'default',
        unitSize: 1_000_000,
        priceMicroUsd: 30_000_000,
      },
    ],
  },
  {
    modelId: 'gpt-image-2',
    name: 'Codex 特惠按张价',
    pricingBasis: 'unit',
    quantityMeter: 'output_count',
    skuRuleSource: gptImageCodexSkuRuleSource,
    skuRuleAstJson: JSON.stringify(gptImageCodexSkuRule),
    compilerVersion: SKU_RULE_COMPILER_VERSION,
    ruleHash: gptImageCodexRuleHash,
    rates: [
      {
        meterKey: 'output_count',
        skuKey: 'default',
        unitSize: 1,
        priceMicroUsd: 8_500,
      },
      {
        meterKey: 'output_count',
        skuKey: 'resolution=2k',
        unitSize: 1,
        priceMicroUsd: 14_000,
      },
      {
        meterKey: 'output_count',
        skuKey: 'resolution=4k',
        unitSize: 1,
        priceMicroUsd: 21_000,
      },
    ],
  },
];

const modelPrices = [
  {
    modelId: 'gpt-4o-mini',
    pricingMode: 'cost_token',
    source: 'seed_cost',
    baseInputMicroUsd: 150000,
    baseOutputMicroUsd: 600000,
    syncStatus: 'manual',
    driftStatus: 'unknown',
    reviewNote:
      'Independent sample upstream cost reference for local bootstrap.',
  },
];

async function loadSchemaTables(): Promise<CatalogSchemaTables> {
  if (!['sqlite', 'turso', 'd1'].includes(envConfigs.database_provider)) {
    throw new Error(
      `init-catalog supports sqlite/turso/d1 providers only (current: ${envConfigs.database_provider})`
    );
  }

  return (await import(
    '@/config/db/schema.sqlite'
  )) as unknown as CatalogSchemaTables;
}

type GroupConsolidationTables = Pick<
  CatalogSchemaTables,
  | 'catalogGroup'
  | 'catalogModelListing'
  | 'gatewayTask'
  | 'modelPriceVersion'
  | 'modelRoute'
  | 'newApiKeyBinding'
  | 'portalApiKey'
  | 'requestLedger'
>;

type GroupConsolidationPlan = {
  legacyDiscount: CatalogGroupRow;
  official?: CatalogGroupRow;
  retiredDiscount?: CatalogGroupRow;
  legacyKeys: Array<{ id: string; portalUserId: string; status: string }>;
  portalKeyIds: string[];
  requestIds: string[];
  relatedTaskIds: string[];
};

type DeleteLegacyPortalKey = (
  portalUserId: string,
  keyId: string
) => Promise<void>;

async function loadGroupConsolidationPlan(
  executor: any,
  tables: GroupConsolidationTables,
  requireRemoteDeletion: boolean
): Promise<GroupConsolidationPlan | null> {
  const {
    catalogGroup,
    gatewayTask,
    newApiKeyBinding,
    portalApiKey,
    requestLedger,
  } = tables;

  const existingGroups = (await executor
    .select()
    .from(catalogGroup)
    .where(
      inArray(catalogGroup.slug, [
        'official',
        LEGACY_DISCOUNT_GROUP_SLUG,
        DISCOUNT_GROUP_SLUG,
        RETIRED_DISCOUNT_GROUP_SLUG,
      ])
    )) as CatalogGroupRow[];
  const legacyDiscount = existingGroups.find(
    (group) => group.slug === LEGACY_DISCOUNT_GROUP_SLUG
  );
  if (!legacyDiscount) return null;

  const discount = existingGroups.find(
    (group) => group.slug === DISCOUNT_GROUP_SLUG
  );
  const official = existingGroups.find((group) => group.slug === 'official');
  if (discount && legacyDiscount.id !== discount.id) {
    throw new Error(
      'catalog group consolidation requires manual review: codex-discount and discount both exist'
    );
  }

  const retiredDiscount = existingGroups.find(
    (group) => group.slug === RETIRED_DISCOUNT_GROUP_SLUG
  );
  if (!retiredDiscount) {
    return {
      legacyDiscount,
      official,
      legacyKeys: [],
      portalKeyIds: [],
      requestIds: [],
      relatedTaskIds: [],
    };
  }

  const legacyKeys = await executor
    .select({
      id: newApiKeyBinding.id,
      portalUserId: newApiKeyBinding.portalUserId,
      status: newApiKeyBinding.status,
    })
    .from(newApiKeyBinding)
    .where(eq(newApiKeyBinding.groupId, retiredDiscount.id));
  const portalKeys = await executor
    .select({ id: portalApiKey.id, status: portalApiKey.status })
    .from(portalApiKey)
    .where(eq(portalApiKey.groupId, retiredDiscount.id));
  if (
    legacyKeys.some((key: { status: string }) =>
      requireRemoteDeletion
        ? key.status !== 'deleted'
        : !['disabled', 'deleted'].includes(key.status)
    ) ||
    portalKeys.some(
      (key: { status: string }) => !['disabled', 'deleted'].includes(key.status)
    )
  ) {
    throw new Error(
      requireRemoteDeletion
        ? 'catalog group consolidation refused to detach discount-1 legacy keys before remote deletion'
        : 'catalog group consolidation refused to delete discount-1 with non-disabled API keys'
    );
  }

  const requests = await executor
    .select({ id: requestLedger.id, status: requestLedger.status })
    .from(requestLedger)
    .where(eq(requestLedger.portalGroupId, retiredDiscount.id));
  if (
    requests.some(
      (request: { status: string }) =>
        !['settled', 'failed_unbilled'].includes(request.status)
    )
  ) {
    throw new Error(
      'catalog group consolidation refused to delete discount-1 with non-terminal requests'
    );
  }

  const requestIds = requests.map((request: { id: string }) => request.id);
  const portalKeyIds = portalKeys.map((key: { id: string }) => key.id);
  const relatedTasks = [
    ...(requestIds.length > 0
      ? await executor
          .select({ id: gatewayTask.id, status: gatewayTask.status })
          .from(gatewayTask)
          .where(inArray(gatewayTask.requestLedgerId, requestIds))
      : []),
    ...(portalKeyIds.length > 0
      ? await executor
          .select({ id: gatewayTask.id, status: gatewayTask.status })
          .from(gatewayTask)
          .where(inArray(gatewayTask.portalKeyId, portalKeyIds))
      : []),
  ];
  if (
    relatedTasks.some(
      (task: { status: string }) =>
        !['completed', 'failed_unbilled'].includes(task.status)
    )
  ) {
    throw new Error(
      'catalog group consolidation refused to delete discount-1 with non-terminal tasks'
    );
  }

  return {
    legacyDiscount,
    official,
    retiredDiscount,
    legacyKeys,
    portalKeyIds,
    requestIds,
    relatedTaskIds: [
      ...new Set(relatedTasks.map((task: { id: string }) => task.id)),
    ],
  };
}

async function deleteLegacyPortalKeyThroughSupportedPath(
  portalUserId: string,
  keyId: string
) {
  const { deletePortalApiKey } = await import(
    '@/features/newapi-bridge/server/portal'
  );
  await deletePortalApiKey(portalUserId, keyId);
}

async function preparePortalGroupConsolidation(
  tables: GroupConsolidationTables,
  deleteLegacyPortalKey: DeleteLegacyPortalKey
) {
  const plan = await loadGroupConsolidationPlan(db(), tables, false);
  if (!plan) return;

  for (const key of plan.legacyKeys) {
    if (key.status === 'disabled') {
      await deleteLegacyPortalKey(key.portalUserId, key.id);
    }
  }
}

async function normalizeSeededOfficialGroup(
  tx: any,
  catalogGroup: CatalogSchemaTables['catalogGroup']
) {
  await tx
    .update(catalogGroup)
    .set({
      name: OFFICIAL_GROUP_NAME,
      userDescription: OFFICIAL_GROUP_DESCRIPTION,
    })
    .where(
      and(
        eq(catalogGroup.slug, 'official'),
        eq(catalogGroup.name, 'Official'),
        eq(
          catalogGroup.userDescription,
          'Default verified model route for production usage.'
        )
      )
    );
}

async function consolidatePortalGroups(
  tx: any,
  tables: GroupConsolidationTables
) {
  const {
    catalogGroup,
    catalogModelListing,
    gatewayTask,
    modelPriceVersion,
    modelRoute,
    newApiKeyBinding,
    portalApiKey,
    requestLedger,
  } = tables;
  const plan = await loadGroupConsolidationPlan(tx, tables, true);
  if (!plan) return;

  if (plan.official) {
    await tx
      .update(catalogGroup)
      .set({
        name: OFFICIAL_GROUP_NAME,
        userDescription: OFFICIAL_GROUP_DESCRIPTION,
      })
      .where(eq(catalogGroup.id, plan.official.id));
  }
  await tx
    .update(catalogGroup)
    .set({
      slug: DISCOUNT_GROUP_SLUG,
      name: DISCOUNT_GROUP_NAME,
      userDescription: DISCOUNT_GROUP_DESCRIPTION,
    })
    .where(eq(catalogGroup.id, plan.legacyDiscount.id));

  if (!plan.retiredDiscount) return;

  const { portalKeyIds, requestIds, relatedTaskIds, retiredDiscount } = plan;
  if (relatedTaskIds.length > 0) {
    await tx.delete(gatewayTask).where(inArray(gatewayTask.id, relatedTaskIds));
  }
  if (requestIds.length > 0) {
    // 资金流水必须 append-only；其 request_ledger_id 作为历史快照保持不变。
    await tx.delete(requestLedger).where(inArray(requestLedger.id, requestIds));
  }
  if (portalKeyIds.length > 0) {
    await tx.delete(portalApiKey).where(inArray(portalApiKey.id, portalKeyIds));
  }

  await tx
    .delete(catalogModelListing)
    .where(eq(catalogModelListing.groupId, retiredDiscount.id));
  await tx
    .delete(modelRoute)
    .where(eq(modelRoute.portalGroupId, retiredDiscount.id));
  await tx
    .delete(modelPriceVersion)
    .where(eq(modelPriceVersion.portalGroupId, retiredDiscount.id));
  // 远端删除已由标准链路完成；本地仅解除已删除 Key 的分组引用。
  await tx
    .update(newApiKeyBinding)
    .set({
      groupId: null,
    })
    .where(eq(newApiKeyBinding.groupId, retiredDiscount.id));
  await tx.delete(catalogGroup).where(eq(catalogGroup.id, retiredDiscount.id));
}

function indexBy<T, K extends keyof T & string>(rows: T[], key: K) {
  return Object.fromEntries(rows.map((row) => [row[key], row])) as Record<
    string,
    T
  >;
}

function requireRow<T>(
  rowsByKey: Record<string, T>,
  key: string,
  label: string
) {
  const row = rowsByKey[key];
  if (!row) {
    throw new Error(`Missing catalog seed dependency: ${label} ${key}`);
  }
  return row;
}

export async function initCatalog(options?: {
  deleteLegacyPortalKey?: DeleteLegacyPortalKey;
}) {
  const {
    catalogVendor,
    catalogCapability,
    catalogCategory,
    catalogStatus,
    catalogGroup,
    catalogModel,
    catalogModelCapability,
    catalogModelPrice,
    catalogModelPricingProfile,
    catalogModelPricingRate,
    catalogModelListing,
    gatewayTask,
    modelPriceVersion,
    modelRoute,
    newApiKeyBinding,
    portalApiKey,
    requestLedger,
  } = await loadSchemaTables();

  const consolidationTables = {
    catalogGroup,
    catalogModelListing,
    gatewayTask,
    modelPriceVersion,
    modelRoute,
    newApiKeyBinding,
    portalApiKey,
    requestLedger,
  };
  await preparePortalGroupConsolidation(
    consolidationTables,
    options?.deleteLegacyPortalKey ?? deleteLegacyPortalKeyThroughSupportedPath
  );

  await db().transaction(async (tx: any) => {
    await normalizeSeededOfficialGroup(tx, catalogGroup);
    await consolidatePortalGroups(tx, consolidationTables);

    await tx
      .insert(catalogVendor)
      .values(
        vendors.map((vendor) => ({
          id: getUuid(),
          slug: vendor.slug,
          name: vendor.name,
          sortOrder: vendor.sortOrder,
          status: 'active',
        }))
      )
      .onConflictDoNothing({ target: catalogVendor.slug });

    const vendorBySlug = indexBy<CatalogVendorRow, 'slug'>(
      await tx
        .select()
        .from(catalogVendor)
        .where(
          inArray(
            catalogVendor.slug,
            vendors.map((vendor) => vendor.slug)
          )
        ),
      'slug'
    );

    await tx
      .insert(catalogCategory)
      .values(
        categories.map((category) => ({
          id: getUuid(),
          slug: category.slug,
          name: category.name,
          sortOrder: category.sortOrder,
          status: 'active',
        }))
      )
      .onConflictDoNothing({ target: catalogCategory.slug });

    await tx
      .insert(catalogCapability)
      .values(
        capabilities.map((capability) => ({
          id: getUuid(),
          slug: capability.slug,
          name: capability.name,
          sortOrder: capability.sortOrder,
          status: 'active',
        }))
      )
      .onConflictDoNothing({ target: catalogCapability.slug });

    const capabilityBySlug = indexBy<CatalogCapabilityRow, 'slug'>(
      await tx
        .select()
        .from(catalogCapability)
        .where(
          inArray(
            catalogCapability.slug,
            capabilities.map((capability) => capability.slug)
          )
        ),
      'slug'
    );

    await tx
      .insert(catalogStatus)
      .values(
        statuses.map((status) => ({
          id: getUuid(),
          slug: status.slug,
          name: status.name,
          isCallable: status.isCallable,
          isPublicVisible: status.isPublicVisible,
          sortOrder: status.sortOrder,
          status: 'active',
        }))
      )
      .onConflictDoNothing({ target: catalogStatus.slug });

    const statusBySlug = indexBy<CatalogStatusRow, 'slug'>(
      await tx
        .select()
        .from(catalogStatus)
        .where(
          inArray(
            catalogStatus.slug,
            statuses.map((status) => status.slug)
          )
        ),
      'slug'
    );

    await tx
      .insert(catalogGroup)
      .values(
        groups.map((group) => ({
          id: getUuid(),
          slug: group.slug,
          name: group.name,
          userDescription: group.userDescription,
          allowCreateKey: group.allowCreateKey,
          sortOrder: group.sortOrder,
          status: group.status,
        }))
      )
      .onConflictDoNothing({ target: catalogGroup.slug });

    const groupBySlug = indexBy<CatalogGroupRow, 'slug'>(
      await tx
        .select()
        .from(catalogGroup)
        .where(
          inArray(
            catalogGroup.slug,
            groups.map((group) => group.slug)
          )
        ),
      'slug'
    );

    await tx
      .insert(catalogModel)
      .values(
        models.map((model) => ({
          id: getUuid(),
          modelId: model.modelId,
          displayName: model.displayName,
          vendorId: requireRow(vendorBySlug, model.vendorSlug, 'vendor').id,
          category: model.category,
          contextWindow: model.contextWindow,
        }))
      )
      .onConflictDoNothing({ target: catalogModel.modelId });

    const modelByModelId = indexBy<CatalogModelRow, 'modelId'>(
      await tx
        .select()
        .from(catalogModel)
        .where(
          inArray(
            catalogModel.modelId,
            models.map((model) => model.modelId)
          )
        ),
      'modelId'
    );

    await tx
      .insert(catalogModelPrice)
      .values(
        modelPrices.map((price) => ({
          id: getUuid(),
          modelId: requireRow(modelByModelId, price.modelId, 'model').id,
          pricingMode: price.pricingMode,
          source: price.source,
          sourceModelId: price.modelId,
          baseInputMicroUsd: price.baseInputMicroUsd,
          baseOutputMicroUsd: price.baseOutputMicroUsd,
          syncStatus: price.syncStatus,
          driftStatus: price.driftStatus,
          reviewNote: price.reviewNote,
        }))
      )
      .onConflictDoNothing({ target: catalogModelPrice.modelId });

    await tx
      .insert(catalogModelCapability)
      .values(
        modelCapabilities.map((item) => ({
          id: getUuid(),
          modelId: requireRow(modelByModelId, item.modelId, 'model').id,
          capabilityId: requireRow(
            capabilityBySlug,
            item.capabilitySlug,
            'capability'
          ).id,
        }))
      )
      .onConflictDoNothing({
        target: [
          catalogModelCapability.modelId,
          catalogModelCapability.capabilityId,
        ],
      });

    await tx
      .insert(catalogModelPricingProfile)
      .values(
        pricingProfiles.map((profile) => ({
          id: getUuid(),
          modelId: requireRow(modelByModelId, profile.modelId, 'model').id,
          name: profile.name,
          pricingBasis: profile.pricingBasis,
          quantityMeter: profile.quantityMeter,
          skuRuleSource: profile.skuRuleSource,
          skuRuleAstJson: profile.skuRuleAstJson,
          compilerVersion: profile.compilerVersion,
          ruleHash: profile.ruleHash,
          reviewedAt: new Date(),
          reviewNote: '初始化脚本写入的已确认售卖定价。',
        }))
      )
      .onConflictDoNothing({
        target: [
          catalogModelPricingProfile.modelId,
          catalogModelPricingProfile.name,
        ],
      });

    const pricingProfileRows = (await tx
      .select()
      .from(catalogModelPricingProfile)
      .where(
        inArray(
          catalogModelPricingProfile.modelId,
          Object.values(modelByModelId).map((model) => model.id)
        )
      )) as CatalogModelPricingProfileRow[];
    const pricingProfileByModelAndName = Object.fromEntries(
      pricingProfileRows.map((profile) => [
        `${profile.modelId}:${profile.name}`,
        profile,
      ])
    ) as Record<string, CatalogModelPricingProfileRow>;

    await tx
      .insert(catalogModelPricingRate)
      .values(
        pricingProfiles.flatMap((profile) => {
          const model = requireRow(modelByModelId, profile.modelId, 'model');
          const savedProfile = requireRow(
            pricingProfileByModelAndName,
            `${model.id}:${profile.name}`,
            'pricing profile'
          );
          return profile.rates.map((rate) => ({
            id: getUuid(),
            profileId: savedProfile.id,
            ...rate,
          }));
        })
      )
      .onConflictDoNothing({
        target: [
          catalogModelPricingRate.profileId,
          catalogModelPricingRate.meterKey,
          catalogModelPricingRate.skuKey,
        ],
      });

    await tx
      .insert(catalogModelListing)
      .values(
        listings.map((listing) => {
          const model = requireRow(modelByModelId, listing.modelId, 'model');
          const profile = requireRow(
            pricingProfileByModelAndName,
            `${model.id}:${listing.pricingProfileName}`,
            'pricing profile'
          );
          return {
            id: getUuid(),
            modelId: model.id,
            groupId: requireRow(groupBySlug, listing.groupSlug, 'group').id,
            newapiGroup: listing.newapiGroup,
            pricingProfileId: profile.id,
            statusId: requireRow(statusBySlug, listing.statusSlug, 'status').id,
            // 旧列只为数据库迁移兼容保留，售卖链路不再读取。
            inputMicroUsd: 0,
            outputMicroUsd: 0,
            discountRateBps: listing.discountRateBps,
            sortOrder: listing.sortOrder,
          };
        })
      )
      .onConflictDoNothing({
        target: [catalogModelListing.modelId, catalogModelListing.groupId],
      });

    // 旧迁移已经写入种子 listing、但当时可能尚无 catalog_model_price，
    // 因而 0018 无法为它关联定价档案。初始化时只补空引用，绝不覆盖管理员选择。
    for (const listing of listings) {
      const model = requireRow(modelByModelId, listing.modelId, 'model');
      const group = requireRow(groupBySlug, listing.groupSlug, 'group');
      const profile = requireRow(
        pricingProfileByModelAndName,
        `${model.id}:${listing.pricingProfileName}`,
        'pricing profile'
      );
      await tx
        .update(catalogModelListing)
        .set({ pricingProfileId: profile.id })
        .where(
          and(
            eq(catalogModelListing.modelId, model.id),
            eq(catalogModelListing.groupId, group.id),
            isNull(catalogModelListing.pricingProfileId)
          )
        );
    }
  });
}

const isCli =
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isCli) {
  initCatalog()
    .then(() => {
      console.log('Catalog initialization completed successfully.');
      process.exit(0);
    })
    .catch((error) => {
      console.error('Error during catalog initialization:', error);
      process.exit(1);
    });
}
