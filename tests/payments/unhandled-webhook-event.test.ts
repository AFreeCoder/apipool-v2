import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  isUnhandledPaymentEvent,
  UnhandledPaymentEventError,
} from '@/extensions/payment/errors';

test('unhandled payment events are distinguishable from real failures', () => {
  const skip = new UnhandledPaymentEventError('stripe', 'charge.refunded');
  assert.equal(isUnhandledPaymentEvent(skip), true);
  assert.match(skip.message, /charge\.refunded/);
  assert.equal(skip.eventType, 'charge.refunded');

  assert.equal(isUnhandledPaymentEvent(new Error('Invalid signature')), false);
  assert.equal(isUnhandledPaymentEvent(null), false);
});

test('every provider signals unhandled event types instead of throwing a generic error', async () => {
  // 三个 provider 的 default 分支原本都 throw 普通 Error → notify 路由 500。
  // Stripe 会按重试策略反复投递数天，持续失败可能触发 endpoint 告警/禁用，
  // 届时真正的支付成功事件也收不到。
  for (const file of [
    'src/extensions/payment/stripe.ts',
    'src/extensions/payment/paypal.ts',
    'src/extensions/payment/creem.ts',
  ]) {
    const source = await readFile(file, 'utf8');
    assert.match(
      source,
      /UnhandledPaymentEventError/,
      `${file} must signal unhandled events`
    );
    assert.doesNotMatch(
      source,
      /throw new Error\(`(Unknown|Not handle)[^`]*event type/i,
      `${file} must not throw a generic error for unknown event types`
    );
  }
});

test('the notify route skips unhandled events with 200 but still rejects bad signatures', async () => {
  const route = await readFile(
    'src/app/api/payment/notify/[provider]/route.ts',
    'utf8'
  );

  assert.match(route, /isUnhandledPaymentEvent/);
  // 验签失败必须仍然非 200
  assert.match(route, /status:\s*500/);
});

test('paypal never relaxes webhook verification in a production runtime', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = await readFile('src/extensions/payment/paypal.ts', 'utf8');

  // 放松验签的前提不能只看 DB 配置项 paypal_environment：一旦上线忘了改成
  // production，伪造的无签名 webhook 就能免费加额。运行时环境必须一票否决。
  assert.match(source, /isProductionRuntime/);
  assert.doesNotMatch(
    source,
    /if \(this\.configs\.environment === 'production'\) \{\s*\n\s*\/\/ In production, reject events without signature headers/,
    'unsigned events must be rejected based on the runtime, not only on config'
  );
});

test('a production runtime is detected from NODE_ENV', async () => {
  const { isProductionRuntime } = await import('@/extensions/payment/errors');
  const original = process.env.NODE_ENV;
  try {
    (process.env as Record<string, string>).NODE_ENV = 'production';
    assert.equal(isProductionRuntime(), true);
    (process.env as Record<string, string>).NODE_ENV = 'development';
    assert.equal(isProductionRuntime(), false);
  } finally {
    (process.env as Record<string, string | undefined>).NODE_ENV = original;
  }
});
