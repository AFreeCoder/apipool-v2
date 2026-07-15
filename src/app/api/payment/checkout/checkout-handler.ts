import { resolveTopUpCheckout } from '@/features/api-console/lib/top-up-products';
import { checkoutEnabled } from '@/features/gateway/lib/config';

import { PaymentOrder, PaymentPrice } from '@/extensions/payment/types';
import { getSnowId, getUuid } from '@/shared/lib/hash';
import { respData, respErr } from '@/shared/lib/resp';
import { getAllConfigs } from '@/shared/models/config';
import {
  createOrder,
  NewOrder,
  OrderStatus,
  updateOrderByOrderNo,
} from '@/shared/models/order';
import { getUserInfo } from '@/shared/models/user';
import { getPaymentService } from '@/shared/services/payment';
import type { PricingItem } from '@/shared/types/blocks/pricing';

/**
 * 注意：不接受客户端 metadata。支付 session 的 metadata 由服务端独立构造，
 * 其中 order_no 是 webhook 回查订单的唯一依据（notify/[provider]/route.ts）。
 * 一旦允许客户端写入，攻击者可用小额 checkout 覆盖 order_no 结算大额订单。
 */
type CheckoutRequestBody = {
  product_id?: string;
  custom_amount_usd?: unknown;
  currency?: string;
  locale?: string;
  payment_provider?: string;
};

export type CheckoutHandlerDeps = {
  getUserInfo: typeof getUserInfo;
  getAllConfigs: typeof getAllConfigs;
  getPaymentService: typeof getPaymentService;
  createOrder: typeof createOrder;
  updateOrderByOrderNo: typeof updateOrderByOrderNo;
  getPaymentProductId: (
    productId: string,
    provider: string,
    checkoutCurrency: string
  ) => Promise<string | undefined>;
  getPromotionCode: (
    productId: string,
    provider: string,
    checkoutCurrency: string
  ) => Promise<string | undefined>;
  getSnowId: typeof getSnowId;
  getUuid: typeof getUuid;
  now: () => Date;
};

const defaultDeps: CheckoutHandlerDeps = {
  getUserInfo,
  getAllConfigs,
  getPaymentService,
  createOrder,
  updateOrderByOrderNo,
  getPaymentProductId,
  getPromotionCode,
  getSnowId,
  getUuid,
  now: () => new Date(),
};

function isStripeSecretKey(value: unknown) {
  return (
    typeof value === 'string' &&
    /^(sk|rk)_(test|live)_[A-Za-z0-9]+$/.test(value.trim())
  );
}

function getCheckoutErrorMessage(error: unknown) {
  const message =
    error instanceof Error ? error.message : String(error || 'unknown error');

  if (/invalid api key provided/i.test(message)) {
    return 'checkout failed: payment provider credentials are invalid';
  }

  return `checkout failed: ${message}`;
}

export async function createTopUpCheckoutResponse(input: {
  body: CheckoutRequestBody;
  pricingItems: PricingItem[];
  deps?: Partial<CheckoutHandlerDeps>;
}) {
  if (!checkoutEnabled()) {
    return respErr('checkout is temporarily disabled');
  }

  const deps = { ...defaultDeps, ...(input.deps || {}) };
  const { product_id, custom_amount_usd, currency, locale, payment_provider } =
    input.body;

  let checkout;
  try {
    checkout = resolveTopUpCheckout({
      productId: product_id,
      customAmountUsd: custom_amount_usd,
      currency,
      pricingItems: input.pricingItems,
    });
  } catch (error: any) {
    return respErr(error?.message || 'invalid checkout amount');
  }

  // get sign user
  const user = await deps.getUserInfo();
  if (!user || !user.email) {
    return respErr('no auth, please sign in');
  }

  // get configs
  const configs = await deps.getAllConfigs();

  // choose payment provider
  let paymentProviderName = payment_provider || '';
  if (!paymentProviderName) {
    paymentProviderName = configs.default_payment_provider;
  }
  if (!paymentProviderName) {
    return respErr('no payment provider configured');
  }

  if (
    paymentProviderName === 'stripe' &&
    !isStripeSecretKey(configs.stripe_secret_key)
  ) {
    return respErr('stripe payment provider is not configured correctly');
  }

  const allowedProviders = checkout.allowedProviders;

  // If payment_providers is configured, validate the selected provider
  if (allowedProviders && allowedProviders.length > 0) {
    if (!allowedProviders.includes(paymentProviderName)) {
      return respErr(
        `payment provider ${paymentProviderName} is not supported for this currency`
      );
    }
  }

  // get default payment provider
  const paymentService = await deps.getPaymentService();

  const paymentProvider = paymentService.getProvider(paymentProviderName);
  if (!paymentProvider || !paymentProvider.name) {
    return respErr('no payment provider configured');
  }

  const orderNo = deps.getSnowId();

  // get payment product id from pricing table in local file
  let paymentProductId: string | undefined =
    checkout.paymentProductId || undefined;
  if (!paymentProductId && !checkout.isCustomAmount) {
    paymentProductId = await deps.getPaymentProductId(
      checkout.productId,
      paymentProviderName,
      checkout.currency
    );
  }

  // get preset promotion code for product_id
  const promotionCode = checkout.isCustomAmount
    ? undefined
    : await deps.getPromotionCode(
        checkout.productId,
        paymentProviderName,
        checkout.currency
      );

  // build checkout price with correct amount for selected currency
  const checkoutPrice: PaymentPrice = {
    amount: checkout.amount,
    currency: checkout.currency,
  };

  if (!paymentProductId) {
    // checkout price validation
    if (!checkoutPrice.amount || !checkoutPrice.currency) {
      return respErr('invalid checkout price');
    }
  } else {
    paymentProductId = paymentProductId.trim();
  }

  let callbackBaseUrl = `${configs.app_url}`;
  if (locale && locale !== configs.default_locale) {
    callbackBaseUrl += `/${locale}`;
  }

  const callbackUrl =
    checkout.type === 'subscription'
      ? `${callbackBaseUrl}/settings/billing`
      : `${callbackBaseUrl}/settings/payments`;

  // build checkout order
  const checkoutOrder: PaymentOrder = {
    description: checkout.productName,
    customer: {
      name: user.name,
      email: user.email,
    },
    type: checkout.type,
    metadata: {
      app_name: configs.app_name,
      order_no: orderNo,
      user_id: user.id,
    },
    successUrl: `${configs.app_url}/api/payment/callback?order_no=${orderNo}`,
    // /pricing 是 redirect 到 /models 的占位桩：取消支付后落在模型列表页会
    // 脱离充值上下文。回到账单页并带上状态，便于页面给出提示。
    cancelUrl: `${callbackBaseUrl}/dashboard/billing?checkout=canceled`,
  };

  // checkout with predefined product
  if (paymentProductId) {
    checkoutOrder.productId = paymentProductId;
  }

  // checkout dynamically
  checkoutOrder.price = checkoutPrice;
  if (checkout.type === 'subscription') {
    checkoutOrder.plan = {
      interval: checkout.interval,
      name: checkout.productName,
    };
  }

  if (promotionCode) {
    checkoutOrder.discount = {
      code: promotionCode,
    };
  }

  const currentTime = deps.now();

  // build order info
  const order: NewOrder = {
    id: deps.getUuid(),
    orderNo: orderNo,
    userId: user.id,
    userEmail: user.email,
    status: OrderStatus.PENDING,
    amount: checkout.amount,
    currency: checkout.currency,
    productId: checkout.productId,
    paymentType: checkout.type,
    paymentInterval: checkout.interval,
    paymentProvider: paymentProvider.name,
    checkoutInfo: JSON.stringify(checkoutOrder),
    createdAt: currentTime,
    productName: checkout.productName,
    description: checkout.description,
    callbackUrl: callbackUrl,
    creditsAmount: checkout.creditsAmount,
    creditsValidDays: checkout.creditsValidDays,
    planName: checkout.planName,
    paymentProductId: paymentProductId || '',
    discountCode: promotionCode,
  };

  // create order
  await deps.createOrder(order);

  try {
    // create payment
    const result = await paymentProvider.createPayment({
      order: checkoutOrder,
    });

    // update order status to created, waiting for payment
    await deps.updateOrderByOrderNo(orderNo, {
      status: OrderStatus.CREATED,
      checkoutInfo: JSON.stringify(result.checkoutParams),
      checkoutResult: JSON.stringify(result.checkoutResult),
      checkoutUrl: result.checkoutInfo.checkoutUrl,
      paymentSessionId: result.checkoutInfo.sessionId,
      paymentProvider: result.provider,
    });

    return respData(result.checkoutInfo);
  } catch (e: any) {
    // update order status to completed, means checkout failed
    await deps.updateOrderByOrderNo(orderNo, {
      status: OrderStatus.COMPLETED,
      checkoutInfo: JSON.stringify(checkoutOrder),
    });

    return respErr(getCheckoutErrorMessage(e));
  }
}

// get payemt product id from payment provider's config
async function getPaymentProductId(
  productId: string,
  provider: string,
  checkoutCurrency: string
) {
  if (provider !== 'creem') {
    // currently only creem supports payment product id mapping
    return;
  }

  try {
    const configs = await getAllConfigs();
    const creemProductIds = configs.creem_product_ids;
    if (creemProductIds) {
      const productIds = JSON.parse(creemProductIds);
      return (
        productIds[`${productId}_${checkoutCurrency}`] || productIds[productId]
      );
    }
  } catch (e: any) {
    console.log('get payment product id failed:', e);
    return;
  }
}

// get promotion code from payment provider's config
async function getPromotionCode(
  productId: string,
  provider: string,
  checkoutCurrency: string
) {
  if (provider !== 'stripe') {
    // currently only stripe supports promotion code mapping
    return;
  }

  try {
    const configs = await getAllConfigs();
    const stripePromotionCodes = configs.stripe_promotion_codes;
    if (stripePromotionCodes) {
      const promotionCodes = JSON.parse(stripePromotionCodes);
      return (
        promotionCodes[`${productId}_${checkoutCurrency}`] ||
        promotionCodes[productId]
      );
    }
  } catch (e: any) {
    console.log('get promotion code failed:', e);
    return;
  }
}
