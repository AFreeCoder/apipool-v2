import type { PricePresentation } from './pricing';

export type PublicCatalogListingDto = {
  modelId: string;
  displayName: string;
  vendorName: string;
  groupName: string;
  groupSlug: string;
  category: string;
  capabilities: string[];
  contextWindow: number | null;
  inputMicroUsd?: number;
  outputMicroUsd?: number;
  imageInputMicroUsd?: number;
  imageOutputMicroUsd?: number;
  listInputMicroUsd?: number;
  listOutputMicroUsd?: number;
  discountRateBps?: number;
  discountNote?: string;
  description?: string;
  statusSlug: string;
  statusName: string;
  isCallable: boolean;
  effectiveInputMicroUsd?: number;
  effectiveOutputMicroUsd?: number;
  effectiveImageInputMicroUsd?: number;
  effectiveImageOutputMicroUsd?: number;
  pricePresentation?: PricePresentation;
};

export type ListingRow = PublicCatalogListingDto;

export type AdminPricingSummaryDto = {
  modelId: string;
  displayName: string;
  basePrice?: {
    inputMicroUsd?: number | null;
    outputMicroUsd?: number | null;
    imageInputMicroUsd?: number | null;
    imageOutputMicroUsd?: number | null;
    pricingMode: string;
    source: string;
    syncStatus: string;
    driftStatus: string;
    sourceSyncedAt?: Date | null;
  };
  groupPricing?: {
    groupSlug: string;
    newapiGroup: string;
    ratioDecimal?: string | null;
    ratioBps?: number | null;
    syncStatus: string;
    syncedAt?: Date | null;
  };
  listingPolicy?: {
    pricePolicy: string;
    overrideStatus: string;
    priceDriftStatus: string;
    discountRateBps?: number | null;
    effectiveFormula?: string | null;
  };
};

export type FilterDimensions = {
  vendors: { slug: string; name: string }[];
  groups: { slug: string; name: string }[];
  categories: { slug: string; name: string }[];
  capabilities: { slug: string; name: string }[];
  statuses: { slug: string; name: string }[];
};
