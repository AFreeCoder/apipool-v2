import { getTranslations } from 'next-intl/server';

import { respErr } from '@/shared/lib/resp';

import { createTopUpCheckoutResponse } from './checkout-handler';

export async function POST(req: Request) {
  try {
    const body = await req.json();

    const t = await getTranslations({
      locale: body.locale || 'en',
      namespace: 'pages.pricing',
    });
    const pricing = t.raw('page.sections.pricing');

    return createTopUpCheckoutResponse({
      body,
      pricingItems: pricing.items || [],
    });
  } catch (e: any) {
    console.log('checkout failed:', e);
    return respErr('checkout failed: ' + e.message);
  }
}
