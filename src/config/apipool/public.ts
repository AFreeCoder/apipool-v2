export const APIPOOL_PUBLIC_CONFIG = {
  brandName: process.env.NEXT_PUBLIC_APIPOOL_BRAND_NAME ?? 'APIPool',
  siteUrl: process.env.NEXT_PUBLIC_APIPOOL_SITE_URL ?? 'https://apipool.dev',
  apiBaseUrl:
    process.env.NEXT_PUBLIC_APIPOOL_API_BASE_URL ?? 'https://app.apipool.dev',
  supportEmail:
    process.env.NEXT_PUBLIC_APIPOOL_SUPPORT_EMAIL ?? 'support@apipool.dev',
  defaultLaunchModel:
    process.env.NEXT_PUBLIC_APIPOOL_DEFAULT_MODEL ?? 'gpt-4o-mini',
};
