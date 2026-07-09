import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('checkout is rate limited so a signed-in user cannot flood orders', async () => {
  const route = await readFile('src/app/api/payment/checkout/route.ts', 'utf8');

  // 登录用户可脚本循环 POST：批量 PENDING 订单 + Stripe session 泛滥。
  // 这里的 429 会被 top-up-packages 当成普通错误展示，不会误导用户。
  assert.match(route, /enforceMinIntervalRateLimit/);
});

test('the email-verified probe stays un-throttled on purpose', async () => {
  const route = await readFile(
    'src/app/api/user/is-email-verified/route.ts',
    'utf8'
  );

  // 该端点由 verify-email 页的「继续」按钮触发（用户点击，非轮询）。
  // 限流返回的 429 体没有 data 字段，客户端读 json.data.emailVerified 得到
  // undefined → 向已验证的用户提示「邮箱尚未验证」。为了一个「某邮箱是否为
  // 已验证用户」的窄泄漏面换一条误导真实用户的假消息，不划算。
  //
  // 真要防枚举，应在 Caddy 边缘按 IP 限流（不进业务逻辑），或让客户端正确
  // 处理 429。在那之前保持原状。
  assert.doesNotMatch(route, /enforceMinIntervalRateLimit/);
});
