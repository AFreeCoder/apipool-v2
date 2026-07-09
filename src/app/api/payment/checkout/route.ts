import { getTranslations } from 'next-intl/server';

import { enforceMinIntervalRateLimit } from '@/shared/lib/rate-limit';
import { respErr } from '@/shared/lib/resp';

import { createTopUpCheckoutResponse } from './checkout-handler';

// checkout 需要登录，但登录用户可脚本循环 POST：批量 PENDING 订单 +
// Stripe session 泛滥，触发 provider 侧限流与费用。
const MIN_INTERVAL_MS =
  Number(process.env.CHECKOUT_MIN_INTERVAL_MS) || 2000;

export async function POST(req: Request) {
  const limited = enforceMinIntervalRateLimit(req, {
    intervalMs: MIN_INTERVAL_MS,
    keyPrefix: 'payment-checkout',
  });
  if (limited) return limited;

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
