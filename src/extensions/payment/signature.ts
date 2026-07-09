import { timingSafeEqual } from 'node:crypto';

/**
 * 常量时间比较两个十六进制签名。
 *
 * `a !== b` 会在第一个不同字符处就返回，攻击者可据此逐字节猜出正确签名。
 * 长度不同直接判否——长度本身不是秘密。
 */
export function timingSafeEqualHex(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;

  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;

  return timingSafeEqual(left, right);
}
