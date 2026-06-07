import { setRequestLocale } from 'next-intl/server';

import { APIPOOL_CONFIG } from '@/config/apipool';
import { ApiKeyManager } from '@/features/api-console/components/api-key-manager';
import { listPortalApiKeys } from '@/features/newapi-bridge/server/portal';
import { getUserInfo } from '@/shared/models/user';

export default async function ApiKeysPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const user = await getUserInfo();
  const keys = user ? await listPortalApiKeys(user.id) : [];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">API Keys</h1>
        <p className="mt-2 text-muted-foreground">
          Create real keys for the APIPool Base URL. Full keys are shown once.
        </p>
      </div>
      <ApiKeyManager
        initialKeys={JSON.parse(JSON.stringify(keys))}
        creationEnabled={APIPOOL_CONFIG.isPortalKeyCreationEnabled}
      />
    </div>
  );
}
