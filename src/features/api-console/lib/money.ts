// 控制台账单金额统一展示精度：与同类站点对齐，固定 6 位小数。
// 仅用于余额/消费/账单等账务金额；模型单价与套餐标价不走此格式。
export function formatUsdAmount(
  value: number | string | null | undefined
): string {
  if (value === undefined || value === null || value === '') return '—';
  const num = Number(value);
  if (!Number.isFinite(num)) return '—';
  return `$${num.toFixed(6)}`;
}
