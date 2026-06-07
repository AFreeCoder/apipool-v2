import { APIPOOL_PUBLIC_CONFIG } from './public';

export { APIPOOL_PUBLIC_CONFIG };

export const APIPOOL_CONFIG = {
  ...APIPOOL_PUBLIC_CONFIG,
  newApiBaseUrl: process.env.NEWAPI_BASE_URL ?? '',
  isNewApiIntegrationEnabled:
    process.env.NEWAPI_INTEGRATION_ENABLED !== 'false',
  isPortalKeyCreationEnabled:
    process.env.APIPOOL_KEY_CREATION_ENABLED !== 'false',
};

export const PRICE_DISCLAIMER_ZH =
  '页面价格仅供参考，最终以 APIPool API 实际用量扣费为准。';

export const PRICE_DISCLAIMER_EN =
  'Displayed prices are for reference. Final billing follows actual APIPool API usage.';
