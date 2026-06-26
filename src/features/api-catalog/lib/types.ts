export type ListingRow = {
  modelId: string;
  displayName: string;
  vendorName: string;
  groupName: string;
  groupSlug: string;
  capabilities: string[];
  contextWindow: number | null;
  inputMicroUsd: number;
  outputMicroUsd: number;
  listInputMicroUsd?: number;
  listOutputMicroUsd?: number;
  discountNote?: string;
  description?: string;
  statusSlug: string;
  statusName: string;
  isCallable: boolean;
};

export type FilterDimensions = {
  vendors: { slug: string; name: string }[];
  groups: { slug: string; name: string }[];
  capabilities: { slug: string; name: string }[];
  statuses: { slug: string; name: string }[];
};
