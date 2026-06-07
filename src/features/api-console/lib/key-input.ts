import { getDefaultCallableModelId } from '@/features/api-catalog/lib/catalog';

export const API_KEY_CREATION_PAUSED_MESSAGE =
  'API key creation is temporarily paused.';

export function assertPortalApiKeyCreationEnabled(isEnabled: boolean) {
  if (!isEnabled) throw new Error(API_KEY_CREATION_PAUSED_MESSAGE);
}

export function sanitizePortalApiKeyCreateInput(
  body: any,
  configuredLaunchModel?: string
) {
  const rawName = typeof body?.name === 'string' ? body.name : '';
  const name = rawName.trim() || 'Default APIPool key';

  return {
    name,
    allowedModels: [getDefaultCallableModelId(configuredLaunchModel)],
  };
}
