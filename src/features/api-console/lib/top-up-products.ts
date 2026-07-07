import { PaymentInterval, PaymentType } from '@/extensions/payment/types';
import type {
  PricingCurrency,
  PricingItem,
} from '@/shared/types/blocks/pricing';

export const TOP_UP_CUSTOM_MIN_USD = 10;
export const TOP_UP_CUSTOM_MAX_USD = 1000;
export const TOP_UP_CURRENCY = 'usd';
export const TOP_UP_CUSTOM_PRODUCT_ID = 'topup_custom';

export type ResolvedTopUpCheckout = {
  productId: string;
  productName: string;
  description: string;
  amount: number;
  currency: string;
  priceLabel: string;
  interval: PaymentInterval;
  type: PaymentType;
  creditsAmount: number;
  creditsValidDays: number;
  planName: string;
  paymentProductId: string;
  allowedProviders?: string[];
  isCustomAmount: boolean;
};

export function normalizeTopUpCurrency(currency?: string) {
  return (currency || TOP_UP_CURRENCY).toLowerCase();
}

function hasCustomAmount(value: unknown) {
  return value !== undefined && value !== null && value !== '';
}

function parseCustomAmountUsd(value: unknown) {
  const amountUsd = Number(value);
  if (!Number.isInteger(amountUsd)) {
    throw new Error('custom_amount_usd must be an integer USD amount');
  }
  if (amountUsd < TOP_UP_CUSTOM_MIN_USD || amountUsd > TOP_UP_CUSTOM_MAX_USD) {
    throw new Error(
      `custom_amount_usd must be between ${TOP_UP_CUSTOM_MIN_USD} and ${TOP_UP_CUSTOM_MAX_USD}`
    );
  }
  return amountUsd;
}

export function parseCustomTopUpAmountInput(value: unknown) {
  const amountUsd = Number(value);
  if (
    !Number.isInteger(amountUsd) ||
    amountUsd < TOP_UP_CUSTOM_MIN_USD ||
    amountUsd > TOP_UP_CUSTOM_MAX_USD
  ) {
    return undefined;
  }
  return amountUsd;
}

function resolvePresetCurrency(input: {
  item: PricingItem;
  currency: string;
}): {
  amount: number;
  currency: string;
  priceLabel: string;
  paymentProductId: string;
  allowedProviders?: string[];
} {
  const defaultCurrency = normalizeTopUpCurrency(input.item.currency);
  const requestedCurrency = normalizeTopUpCurrency(input.currency);
  const selectedCurrency =
    requestedCurrency === defaultCurrency
      ? undefined
      : input.item.currencies?.find(
          (currency: PricingCurrency) =>
            normalizeTopUpCurrency(currency.currency) === requestedCurrency
        );

  if (selectedCurrency) {
    return {
      amount: selectedCurrency.amount,
      currency: normalizeTopUpCurrency(selectedCurrency.currency),
      priceLabel: selectedCurrency.price,
      paymentProductId:
        selectedCurrency.payment_product_id ||
        input.item.payment_product_id ||
        '',
      allowedProviders:
        selectedCurrency.payment_providers || input.item.payment_providers,
    };
  }

  return {
    amount: input.item.amount,
    currency: defaultCurrency,
    priceLabel: input.item.price || '',
    paymentProductId: input.item.payment_product_id || '',
    allowedProviders: input.item.payment_providers,
  };
}

export function resolveTopUpCheckout(input: {
  productId?: string;
  customAmountUsd?: unknown;
  currency?: string;
  pricingItems: PricingItem[];
}): ResolvedTopUpCheckout {
  const customAmountProvided = hasCustomAmount(input.customAmountUsd);
  if (input.productId && customAmountProvided) {
    throw new Error('choose either product_id or custom_amount_usd');
  }

  const currency = normalizeTopUpCurrency(input.currency);
  if (currency !== TOP_UP_CURRENCY) {
    throw new Error('top-up only supports USD');
  }

  if (customAmountProvided) {
    const amountUsd = parseCustomAmountUsd(input.customAmountUsd);
    const amount = amountUsd * 100;
    return {
      productId: TOP_UP_CUSTOM_PRODUCT_ID,
      productName: `APIPool Credit USD $${amountUsd}`,
      description: 'Custom APIPool credit top-up',
      amount,
      currency: TOP_UP_CURRENCY,
      priceLabel: `USD $${amountUsd}`,
      interval: PaymentInterval.ONE_TIME,
      type: PaymentType.ONE_TIME,
      creditsAmount: amount,
      creditsValidDays: 0,
      planName: '',
      paymentProductId: '',
      isCustomAmount: true,
    };
  }

  if (!input.productId) {
    throw new Error('product_id or custom_amount_usd is required');
  }

  const pricingItem = input.pricingItems.find(
    (item) => item.product_id === input.productId
  );
  if (!pricingItem) {
    throw new Error('pricing item not found');
  }
  if (!pricingItem.product_id && !pricingItem.amount) {
    throw new Error('invalid pricing item');
  }

  const resolvedCurrency = resolvePresetCurrency({
    item: pricingItem,
    currency,
  });
  const interval = (pricingItem.interval ||
    PaymentInterval.ONE_TIME) as PaymentInterval;
  const type =
    interval === PaymentInterval.ONE_TIME
      ? PaymentType.ONE_TIME
      : PaymentType.SUBSCRIPTION;

  return {
    productId: pricingItem.product_id,
    productName: pricingItem.product_name || pricingItem.product_id,
    description: pricingItem.description || '',
    amount: resolvedCurrency.amount,
    currency: resolvedCurrency.currency,
    priceLabel: resolvedCurrency.priceLabel,
    interval,
    type,
    creditsAmount: pricingItem.credits || 0,
    creditsValidDays: pricingItem.valid_days || 0,
    planName: pricingItem.plan_name || '',
    paymentProductId: resolvedCurrency.paymentProductId,
    allowedProviders: resolvedCurrency.allowedProviders,
    isCustomAmount: false,
  };
}
