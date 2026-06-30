import {
  getCallableListingsByGroup,
  getGroupsForKeyCreation,
} from '@/features/api-catalog/server/queries';
import { ApiKeyManager } from '@/features/api-console/components/api-key-manager';
import { listPortalApiKeys } from '@/features/newapi-bridge/server/portal';
import { getTranslations, setRequestLocale } from 'next-intl/server';

import { APIPOOL_CONFIG } from '@/config/apipool';
import { getUserInfo } from '@/shared/models/user';

type ApiKeyGroupMessages = Record<string, string>;

function localizeApiKeyGroupName(
  messages: ApiKeyGroupMessages,
  slug: string,
  fallback: string
) {
  return messages[slug] ?? fallback;
}

export default async function ApiKeysPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations({ locale, namespace: 'dashboard.apiKeys' });
  const user = await getUserInfo();
  const [keys, groups] = await Promise.all([
    user ? listPortalApiKeys(user.id) : Promise.resolve([]),
    getGroupsForKeyCreation(),
  ]);
  const groupMessages = t.raw('groups') as ApiKeyGroupMessages;
  const localizedGroups = groups.map((group) => ({
    ...group,
    name: localizeApiKeyGroupName(groupMessages, group.slug, group.name),
  }));
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
        <h1 className="text-2xl font-semibold">{t('title')}</h1>
        <p className="text-muted-foreground mt-2">{t('description')}</p>
      </div>
      <ApiKeyManager
        initialKeys={JSON.parse(JSON.stringify(keys))}
        groups={localizedGroups}
        callableByGroup={callableByGroup}
        creationEnabled={APIPOOL_CONFIG.isPortalKeyCreationEnabled}
      />
    </div>
  );
}
