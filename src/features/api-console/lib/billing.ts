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

export type WalletLedgerEntry = {
  id: string;
  entryType: string;
  signedAmountUsd: number;
  balanceAfterUsd: number;
  createdAt: string;
};

export type BalanceAdjustment = {
  id: string;
  amountUsd: number;
  balanceAfterUsd: number;
  createdAt: string;
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

export function buildBalanceAdjustments(
  ledger: WalletLedgerEntry[]
): BalanceAdjustment[] {
  return ledger
    .filter((entry) => entry.entryType === 'manual_adjustment')
    .map((entry) => ({
      id: entry.id,
      amountUsd: entry.signedAmountUsd,
      balanceAfterUsd: entry.balanceAfterUsd,
      createdAt: entry.createdAt,
    }));
}
