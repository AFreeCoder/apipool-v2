import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('the email-verified probe is rate limited per client', async () => {
  const route = await readFile(
    'src/app/api/user/is-email-verified/route.ts',
    'utf8'
  );

  // 不能加登录门槛：verify-email 页正是在「没有 session」时调它，用来发现
  // 用户在另一个浏览器完成了验证。所以只能按 IP 限流，把枚举速度压下来。
  assert.match(route, /enforceMinIntervalRateLimit/);
  assert.doesNotMatch(
    route,
    /getUserInfo/,
    'requiring a session here would break cross-browser verification detection'
  );
});

test('checkout is rate limited so a signed-in user cannot flood orders', async () => {
  const route = await readFile('src/app/api/payment/checkout/route.ts', 'utf8');

  // 登录用户可脚本循环 POST：批量 PENDING 订单 + Stripe session 泛滥
  assert.match(route, /enforceMinIntervalRateLimit/);
});
