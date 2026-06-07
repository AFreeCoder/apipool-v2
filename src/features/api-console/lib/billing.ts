export type BillingUsageLog = {
  id: string;
  keyMasked: string;
  modelId: string;
  status: string;
  inputTokens: number;
  outputTokens: number;
  spendUsd?: number | null;
  createdAt: Date;
};

export type BillingUsageCharge = {
  id: string;
  keyMasked: string;
  modelId: string;
  status: string;
  tokenCount: number;
  spendUsd: number;
  createdAt: Date;
};

export function buildBillingUsageCharges(usage: {
  logs: BillingUsageLog[];
}): BillingUsageCharge[] {
  return usage.logs
    .filter((log) => typeof log.spendUsd === 'number')
    .map((log) => ({
      id: log.id,
      keyMasked: log.keyMasked,
      modelId: log.modelId,
      status: log.status,
      tokenCount: log.inputTokens + log.outputTokens,
      spendUsd: log.spendUsd as number,
      createdAt: log.createdAt,
    }));
}
