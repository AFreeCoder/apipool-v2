import { enforceMinIntervalRateLimit } from '@/shared/lib/rate-limit';
import { respData, respErr } from '@/shared/lib/resp';
import { isEmailVerified } from '@/shared/models/user';

// 匿名可访问是有意的：verify-email 页正是在「当前浏览器没有 session」时调它，
// 用来发现用户在另一个浏览器完成了邮箱验证。加登录门槛会直接打断该流程。
//
// 代价是返回值本身泄漏「某邮箱是否为本站已验证用户」（不存在与未验证同返
// false，泄漏面比完整用户枚举窄）。按客户端 IP 限流把批量探测的速度压下来，
// 边缘再加一层 Caddy rate_limit 兜底。
const MIN_INTERVAL_MS =
  Number(process.env.EMAIL_VERIFIED_PROBE_MIN_INTERVAL_MS) || 1000;

export async function POST(req: Request) {
  const limited = enforceMinIntervalRateLimit(req, {
    intervalMs: MIN_INTERVAL_MS,
    keyPrefix: 'is-email-verified',
  });
  if (limited) return limited;

  try {
    const body = await req.json().catch(() => ({}));
    const email = String(body?.email || '')
      .trim()
      .toLowerCase();
    if (!email) {
      return respErr('email is required');
    }

    const emailVerified = await isEmailVerified(email);

    return respData({ emailVerified });
  } catch (e) {
    console.log('check email verified failed:', e);
    return respErr('check email verified failed');
  }
}
