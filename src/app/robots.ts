import { MetadataRoute } from 'next';

import { APIPOOL_CONFIG } from '@/config/apipool';
import { getRobotsDisallowRules } from '@/features/apipool-ui/lib/indexing';

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: '*',
      allow: '/',
      disallow: getRobotsDisallowRules(),
    },
    sitemap: `${APIPOOL_CONFIG.siteUrl}/sitemap.xml`,
  };
}
