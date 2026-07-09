/**
 * 把不可信的回跳路径（?callbackUrl=…）收敛为站内路径。
 *
 * 只判断「以 / 开头」是不够的：`//evil.com` 是协议相对 URL，浏览器会当成
 * 外站；部分浏览器还会把 `/\evil.com` 里的反斜杠等同于斜杠。二者都会让
 * 登录回跳变成开放重定向（钓鱼）。
 */
export function safeInternalPath(raw?: string | null): string {
  if (!raw) return '/';
  if (!raw.startsWith('/')) return '/';

  // 控制字符（含 CR/LF、TAB）可用于响应头注入，也能绕过下面的前缀检查
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(raw)) return '/';

  // `//host`、`/\host` 都会离开本站
  if (/^\/[/\\]/.test(raw)) return '/';

  return raw;
}

/**
 * 同上，但先做一次 URL 解码。
 *
 * 回跳参数常以 `%2Fdashboard` 的形式出现；只在解码前校验会漏掉
 * `%2F%2Fevil.com`（解码后是 `//evil.com`，浏览器当外站）。
 * 解码失败（畸形百分号序列）一律回退站内根路径。
 */
export function safeDecodedInternalPath(raw?: string | null): string {
  if (!raw) return '/';

  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return '/';
  }

  return safeInternalPath(decoded);
}
