export type CatalogVendorMatch = {
  id?: string | null;
  slug?: string | null;
  name?: string | null;
};

export type ModelPricingCandidateMatch = {
  modelId: string;
  displayName: string;
  vendorId: string;
  vendorName: string;
  enabledGroups?: string[] | null;
};

export function filterModelPricingCandidates<
  T extends ModelPricingCandidateMatch,
>({
  pricing,
  keyword,
  localVendorId,
  vendor,
  newapiGroup,
  limit,
}: {
  pricing: T[];
  keyword: string;
  localVendorId: string;
  vendor: CatalogVendorMatch | null;
  newapiGroup?: string;
  limit: number;
}): T[] {
  const normalizedKeyword = normalizeSearchValue(keyword);
  const normalizedNewapiGroup = normalizeSearchValue(newapiGroup);

  return pricing
    .filter((model) => matchesCatalogVendor(model, vendor, localVendorId))
    .filter((model) => matchesNewapiGroup(model, normalizedNewapiGroup))
    .filter((model) => {
      if (!normalizedKeyword) return true;
      return (
        normalizeSearchValue(model.modelId).includes(normalizedKeyword) ||
        normalizeSearchValue(model.displayName).includes(normalizedKeyword)
      );
    })
    .slice(0, limit);
}

function matchesCatalogVendor(
  model: ModelPricingCandidateMatch,
  vendor: CatalogVendorMatch | null,
  localVendorId: string
) {
  const aliases = [localVendorId, vendor?.id, vendor?.slug, vendor?.name]
    .map(normalizeVendorValue)
    .filter(Boolean);

  if (aliases.length === 0) return true;

  const remoteValues = [model.vendorId, model.vendorName]
    .map(normalizeVendorValue)
    .filter(Boolean);

  return remoteValues.some((remoteValue) => aliases.includes(remoteValue));
}

function matchesNewapiGroup(
  model: ModelPricingCandidateMatch,
  normalizedNewapiGroup: string
) {
  if (!normalizedNewapiGroup) return true;

  return (model.enabledGroups ?? [])
    .map(normalizeSearchValue)
    .includes(normalizedNewapiGroup);
}

function normalizeVendorValue(value: string | null | undefined) {
  return normalizeSearchValue(value).replace(/[\s_-]+/g, '');
}

function normalizeSearchValue(value: string | null | undefined) {
  return String(value || '')
    .trim()
    .toLowerCase();
}
