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

export function buildCreateKeyRequest(
  name: string,
  groupSlug: string,
  defaultName = 'Your API key'
) {
  return {
    name: name.trim() || defaultName,
    groupSlug: groupSlug.trim(),
  };
}

export function buildGroupSelectOptions(
  groups: ApiKeyGroup[],
  localizedNames: Record<string, string> = {}
): GroupSelectOption[] {
  return groups.map((group) => ({
    value: group.slug,
    label: localizedNames[group.slug] ?? group.name,
    ...(group.userDescription ? { description: group.userDescription } : {}),
  }));
}

export function applyApiKeyMutationResult<
  T extends { id: string },
  U extends { id: string; status: string },
>(keys: readonly T[], updatedKey: U): Array<T | U> {
  if (updatedKey.status === 'deleted') {
    return keys.filter((key) => key.id !== updatedKey.id);
  }

  return keys.map((key) => (key.id === updatedKey.id ? updatedKey : key));
}
