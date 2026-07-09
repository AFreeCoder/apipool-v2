// 单笔人工调额上限。远超任何正常运营场景，纯粹用来兜住手滑多敲的零。
const MAX_QUOTA_ADJUSTMENT_USD = 100_000;

/**
 * 校验管理员调额金额。
 *
 * `apipoolLedgerEntry.amountUsd` 是**美元整数**（5 = $5）。SQLite 是动态类型，
 * 不会拦下 10.5，一旦写入就破坏了整张账本的口径与后续对账。
 */
export function parseQuotaAdjustmentAmount(raw: unknown): {
  amountUsd: number;
} {
  const amountUsd = Number(raw);

  if (!Number.isFinite(amountUsd) || amountUsd === 0) {
    throw new Error('amountUsd must be a non-zero number');
  }
  if (!Number.isInteger(amountUsd)) {
    throw new Error('amountUsd must be an integer number of dollars');
  }
  if (Math.abs(amountUsd) > MAX_QUOTA_ADJUSTMENT_USD) {
    throw new Error(
      `amountUsd exceeds the ${MAX_QUOTA_ADJUSTMENT_USD} dollar limit for a single adjustment`
    );
  }

  return { amountUsd };
}
