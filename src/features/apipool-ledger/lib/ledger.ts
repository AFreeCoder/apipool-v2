export type LedgerSource = 'manual_adjustment' | 'api_usage' | 'recharge';
export type LedgerStatus = 'pending' | 'applied' | 'failed' | 'rolled_back';
export type LedgerExecutor = 'newapi';
export type RollbackStatus =
  | 'not_required'
  | 'pending'
  | 'completed'
  | 'failed';

export type AdjustmentLedgerDraft = {
  portalUserId: string;
  operatorUserId: string;
  amountUsd: number;
  reason: string;
  source: LedgerSource;
  status: LedgerStatus;
  executor: LedgerExecutor;
  newapiUserId: string;
  newapiChangeId?: string;
  rollbackStatus: RollbackStatus;
  createdAt: Date;
};

export function createAdjustmentLedgerDraft(input: {
  portalUserId: string;
  operatorUserId: string;
  amountUsd: number;
  reason: string;
  newapiUserId: string;
  newapiChangeId?: string;
}): AdjustmentLedgerDraft {
  if (!input.portalUserId) {
    throw new Error('portalUserId is required');
  }
  if (!input.operatorUserId) {
    throw new Error('operatorUserId is required');
  }
  if (!input.newapiUserId) {
    throw new Error('newapiUserId is required');
  }
  if (!Number.isFinite(input.amountUsd) || input.amountUsd === 0) {
    throw new Error('amountUsd must be a non-zero number');
  }
  if (!input.reason.trim()) {
    throw new Error('reason is required');
  }

  return {
    portalUserId: input.portalUserId,
    operatorUserId: input.operatorUserId,
    amountUsd: input.amountUsd,
    reason: input.reason.trim(),
    source: 'manual_adjustment',
    status: input.newapiChangeId ? 'applied' : 'pending',
    executor: 'newapi',
    newapiUserId: input.newapiUserId,
    newapiChangeId: input.newapiChangeId,
    rollbackStatus: 'not_required',
    createdAt: new Date(),
  };
}
