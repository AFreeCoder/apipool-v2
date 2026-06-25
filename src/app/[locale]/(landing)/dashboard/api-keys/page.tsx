import {
  getCallableListingsByGroup,
  getGroupsForKeyCreation,
} from '@/features/api-catalog/server/queries';
import { ApiKeyManager } from '@/features/api-console/components/api-key-manager';
import { listPortalApiKeys } from '@/features/newapi-bridge/server/portal';
import { setRequestLocale } from 'next-intl/server';

import { APIPOOL_CONFIG } from '@/config/apipool';
import { getUserInfo } from '@/shared/models/user';

export default async function ApiKeysPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const user = await getUserInfo();
  const [keys, groups] = await Promise.all([
    user ? listPortalApiKeys(user.id) : Promise.resolve([]),
    getGroupsForKeyCreation(),
  ]);
  const callableEntries = await Promise.all(
    groups.map(async (group) => {
      const listings = await getCallableListingsByGroup(group.slug);
      return [
        group.slug,
        listings.map((listing) => listing.displayName),
      ] as const;
    })
  );
  const callableByGroup = Object.fromEntries(callableEntries);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">API Keys</h1>
        <p className="text-muted-foreground mt-2">
          Create real keys for the APIPool Base URL. Full keys are shown once.
        </p>
      </div>
      <ApiKeyManager
        initialKeys={JSON.parse(JSON.stringify(keys))}
        groups={groups}
        callableByGroup={callableByGroup}
        creationEnabled={APIPOOL_CONFIG.isPortalKeyCreationEnabled}
      />
    </div>
  );
}
