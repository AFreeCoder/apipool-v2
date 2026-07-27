/**
 * Catalog Initialization Script
 *
 * Usage:
 *   npx tsx scripts/init-catalog.ts
 */

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
} from '@/config/db/schema';
import { db } from '@/core/db';
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

const groups = [
  {
    slug: 'official',
    name: 'Official',
    userDescription: 'Default verified model route for production usage.',
    allowCreateKey: true,
    sortOrder: 10,
    status: 'active',
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
];

const modelCapabilities = [
  { modelId: 'gpt-4o-mini', capabilitySlug: 'text' },
  { modelId: 'gpt-4o-mini', capabilitySlug: 'vision' },
];

const listings = [
  {
    modelId: 'gpt-4o-mini',
    groupSlug: 'official',
    newapiGroup: 'official',
    statusSlug: 'available',
    pricingProfileName: '默认售卖价',
    sortOrder: 10,
  },
];

const pricingProfiles = [
  {
    modelId: 'gpt-4o-mini',
    name: '默认售卖价',
    pricingBasis: 'token',
    quantityMeter: null,
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

export async function initCatalog() {
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
  } = await loadSchemaTables();

  await db().transaction(async (tx: any) => {
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
