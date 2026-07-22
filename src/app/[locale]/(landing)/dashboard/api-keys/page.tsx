import { getGroupsForKeyCreation } from '@/features/api-catalog/server/queries';
import { ApiKeyManager } from '@/features/api-console/components/api-key-manager';
import { listPortalApiKeys } from '@/features/newapi-bridge/server/portal';
import { getTranslations, setRequestLocale } from 'next-intl/server';

import { APIPOOL_CONFIG } from '@/config/apipool';
import { getUserInfo } from '@/shared/models/user';

export default async function ApiKeysPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations({ locale, namespace: 'dashboard.apiKeys' });
  const localizedGroupNames = t.raw('groups') as Record<string, string>;
  const user = await getUserInfo();
  const [keys, groups] = await Promise.all([
    user ? listPortalApiKeys(user.id) : Promise.resolve([]),
    getGroupsForKeyCreation(),
  ]);
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">{t('title')}</h1>
        <p className="text-muted-foreground mt-2">{t('description')}</p>
      </div>
      <ApiKeyManager
        initialKeys={JSON.parse(JSON.stringify(keys))}
        groups={groups}
        localizedGroupNames={localizedGroupNames}
        creationEnabled={APIPOOL_CONFIG.isPortalKeyCreationEnabled}
      />
    </div>
  );
}
