import { setRequestLocale } from 'next-intl/server';

import { APIPOOL_CONFIG } from '@/config/apipool';
import { ApiKeyManager } from '@/features/api-console/components/api-key-manager';
import { getApipoolCopy } from '@/features/apipool-ui/copy';
import { listPortalApiKeys } from '@/features/newapi-bridge/server/portal';
import { getUserInfo } from '@/shared/models/user';

export default async function ApiKeysPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const copy = getApipoolCopy(locale);
  const user = await getUserInfo();
  const keys = user ? await listPortalApiKeys(user.id) : [];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">{copy.apiKeysPage.title}</h1>
        <p className="mt-2 text-muted-foreground">
          {copy.apiKeysPage.description}
        </p>
      </div>
      <ApiKeyManager
        initialKeys={JSON.parse(JSON.stringify(keys))}
        creationEnabled={APIPOOL_CONFIG.isPortalKeyCreationEnabled}
        copy={copy.apiKeyManager}
      />
    </div>
  );
}
