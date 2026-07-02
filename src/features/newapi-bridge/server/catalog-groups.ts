import 'server-only';

import type { CatalogGroup } from '@/features/api-catalog/server/catalog-service';

import { APIPOOL_CONFIG } from '@/config/apipool';

import { createNewApiClient, type NewApiClient } from './client';

type CatalogGroupSyncInput = Pick<
  CatalogGroup,
  'slug' | 'newapiGroup' | 'allowCreateKey' | 'status'
>;

export type CatalogGroupSyncResult = {
  attempted: boolean;
  changed: boolean;
  group?: string;
  skippedReason?: 'not_key_capable' | 'not_configured';
};

function getConfiguredBaseUrl() {
  return process.env.NEWAPI_BASE_URL || APIPOOL_CONFIG.newApiBaseUrl;
}

function isNewApiAdminConfigured() {
  return Boolean(
    APIPOOL_CONFIG.isNewApiIntegrationEnabled &&
      getConfiguredBaseUrl() &&
      process.env.NEWAPI_ADMIN_TOKEN &&
      process.env.NEWAPI_ADMIN_USER_ID
  );
}

function getCatalogGroupMapping(group: CatalogGroupSyncInput) {
  const slug = group.slug.trim();
  return group.newapiGroup.trim() || (group.allowCreateKey ? slug : '');
}

export async function syncCatalogGroupToNewApi(
  group: CatalogGroupSyncInput,
  client: NewApiClient = createNewApiClient()
): Promise<CatalogGroupSyncResult> {
  const newapiGroup = getCatalogGroupMapping(group);
  if (
    group.status !== 'active' ||
    group.allowCreateKey !== true ||
    !newapiGroup
  ) {
    return {
      attempted: false,
      changed: false,
      skippedReason: 'not_key_capable',
    };
  }

  if (!isNewApiAdminConfigured()) {
    return {
      attempted: false,
      changed: false,
      skippedReason: 'not_configured',
    };
  }

  const result = await client.ensureGroup({ group: newapiGroup });
  return { attempted: true, changed: result.changed, group: result.group };
}
