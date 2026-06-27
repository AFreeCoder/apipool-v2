// Pure, UI-free helpers for the API key creation flow. Kept out of the
// component module so they can be imported under the `react-server` test
// condition without pulling in client-only UI deps (e.g. Radix Select).

export type ApiKeyGroup = {
  slug: string;
  name: string;
  userDescription?: string;
};

export type GroupSelectOption = {
  value: string;
  label: string;
  description?: string;
};

export function buildCreateKeyRequest(name: string, groupSlug: string) {
  return {
    name: name.trim() || 'Default APIPool key',
    groupSlug: groupSlug.trim(),
  };
}

export function buildGroupSelectOptions(
  groups: ApiKeyGroup[]
): GroupSelectOption[] {
  return groups.map((group) => ({
    value: group.slug,
    label: group.name,
    ...(group.userDescription ? { description: group.userDescription } : {}),
  }));
}
