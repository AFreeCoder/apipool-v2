function formatUsd(
  value: number | string | null | undefined,
  fractionDigits: number
) {
  if (value === undefined || value === null || value === '') return '—';
  const num = Number(value);
  if (!Number.isFinite(num)) return '—';
  return `$${num.toFixed(fractionDigits)}`;
}

// 控制台美元消耗保留 6 位小数，避免低于 $0.01 的非零 usage 被显示为 $0.00。
// 模型单价与套餐标价不走此格式。
export function formatUsdAmount(value: number | string | null | undefined) {
  return formatUsd(value, 6);
}

export function formatBalanceUsdAmount(
  value: number | string | null | undefined
): string {
  return formatUsd(value, 2);
}

// 充值到账金额来自订单美元金额，不是 usage 计量；面向用户固定展示到 cents。
export function formatLedgerUsdAmount(
  value: number | string | null | undefined
): string {
  return formatUsd(value, 2);
}
