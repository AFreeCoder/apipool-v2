// 服务端裸调 `date.toLocaleString()` 会跟随 Node 运行时的 locale 与时区
// （容器里通常是 en-US / UTC），中文页面因此显示美式日期，且时间与用户不符。
//
// 统一按页面 locale 格式化，并固定用 UTC 显示——账单、用量、日志三处口径一致，
// 用户对账时不会因为时区漂移而对不上。
const LOCALE_TAGS: Record<string, string> = {
  en: 'en-US',
  zh: 'zh-CN',
};

function resolveLocaleTag(locale: string) {
  return LOCALE_TAGS[locale] ?? 'en-US';
}

export function formatConsoleDateTime(
  value: Date | string | number | null | undefined,
  locale: string
): string {
  if (value === null || value === undefined || value === '') return '—';

  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '—';

  return new Intl.DateTimeFormat(resolveLocaleTag(locale), {
    timeZone: 'UTC',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}

export function formatConsoleNumber(
  value: number | null | undefined,
  locale: string
): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return '—';
  }

  return new Intl.NumberFormat(resolveLocaleTag(locale)).format(value);
}
