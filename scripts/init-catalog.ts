/**
 * Catalog Initialization Script
 *
 * Usage:
 *   npx tsx scripts/init-catalog.ts
 */

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inArray } from 'drizzle-orm';

import type {
  catalogCapability as catalogCapabilityTable,
  catalogGroup as catalogGroupTable,
  catalogModel as catalogModelTable,
  catalogModelCapability as catalogModelCapabilityTable,
  catalogModelListing as catalogModelListingTable,
  catalogStatus as catalogStatusTable,
  catalogVendor as catalogVendorTable,
} from '@/config/db/schema';
import { db } from '@/core/db';
import { envConfigs } from '@/config';
import { getUuid } from '@/shared/lib/hash';

type CatalogSchemaTables = {
  catalogVendor: typeof catalogVendorTable;
  catalogCapability: typeof catalogCapabilityTable;
  catalogStatus: typeof catalogStatusTable;
  catalogGroup: typeof catalogGroupTable;
  catalogModel: typeof catalogModelTable;
  catalogModelCapability: typeof catalogModelCapabilityTable;
  catalogModelListing: typeof catalogModelListingTable;
};

type CatalogVendorRow = typeof catalogVendorTable.$inferSelect;
type CatalogCapabilityRow = typeof catalogCapabilityTable.$inferSelect;
type CatalogStatusRow = typeof catalogStatusTable.$inferSelect;
type CatalogGroupRow = typeof catalogGroupTable.$inferSelect;
type CatalogModelRow = typeof catalogModelTable.$inferSelect;

const vendors = [
  { slug: 'openai', name: 'OpenAI', sortOrder: 10 },
  { slug: 'anthropic', name: 'Anthropic', sortOrder: 20 },
  { slug: 'google', name: 'Google', sortOrder: 30 },
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
    newapiGroup: '',
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
    statusSlug: 'available',
    inputMicroUsd: 150000,
    outputMicroUsd: 600000,
    smokeTested: true,
    sortOrder: 10,
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
    catalogStatus,
    catalogGroup,
    catalogModel,
    catalogModelCapability,
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
          newapiGroup: group.newapiGroup,
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
      .insert(catalogModelListing)
      .values(
        listings.map((listing) => ({
          id: getUuid(),
          modelId: requireRow(modelByModelId, listing.modelId, 'model').id,
          groupId: requireRow(groupBySlug, listing.groupSlug, 'group').id,
          statusId: requireRow(statusBySlug, listing.statusSlug, 'status').id,
          inputMicroUsd: listing.inputMicroUsd,
          outputMicroUsd: listing.outputMicroUsd,
          smokeTested: listing.smokeTested,
          sortOrder: listing.sortOrder,
        }))
      )
      .onConflictDoNothing({
        target: [catalogModelListing.modelId, catalogModelListing.groupId],
      });
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
