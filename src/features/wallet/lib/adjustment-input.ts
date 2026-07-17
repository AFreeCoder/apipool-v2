// 单笔人工调额上限。远超正常运营场景，仅用于防止误输入过大金额。
const MAX_WALLET_ADJUSTMENT_USD = 100_000;

/**
 * 校验 APIPool 本地钱包的管理员调额金额。
 *
 * 当前调额界面以整美元为运营单位，入账时再精确换算为整数 micro-USD。
 */
export function parseWalletAdjustmentAmount(raw: unknown): {
  amountUsd: number;
} {
  const amountUsd = Number(raw);

  if (!Number.isFinite(amountUsd) || amountUsd === 0) {
    throw new Error('amountUsd must be a non-zero number');
  }
  if (!Number.isInteger(amountUsd)) {
    throw new Error('amountUsd must be an integer number of dollars');
  }
  if (Math.abs(amountUsd) > MAX_WALLET_ADJUSTMENT_USD) {
    throw new Error(
      `amountUsd exceeds the ${MAX_WALLET_ADJUSTMENT_USD} dollar limit for a single adjustment`
    );
  }

  return { amountUsd };
}
