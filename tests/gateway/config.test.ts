import assert from 'node:assert/strict';
import test from 'node:test';

test('gatewayConfig 默认值与 env 覆盖', async () => {
  delete process.env.GATEWAY_RISK_SLOT_LIMIT;
  delete process.env.GATEWAY_IMAGES_FIRST_BYTE_TIMEOUT_MS;
  delete process.env.NEWAPI_RUNTIME_POOL_TARGET_USD;
  delete process.env.NEWAPI_RUNTIME_POOL_LOW_WATERMARK_USD;
  const { gatewayConfig, checkoutEnabled } = await import(
    '@/features/gateway/lib/config'
  );
  assert.equal(gatewayConfig().riskSlotLimit, 10);
  assert.equal(gatewayConfig().overdraftFreezeMicroUsd, 10_000_000);
  assert.equal(gatewayConfig().maxBodyBytes, 26_214_400);
  assert.equal(gatewayConfig().parseBufferMax, 33_554_432);
  assert.equal(gatewayConfig().firstByteTimeoutMs, 120_000);
  assert.equal(gatewayConfig().imageFirstByteTimeoutMs, 180_000);
  assert.equal(gatewayConfig().runtimePoolTargetUsd, 1000);
  assert.equal(gatewayConfig().runtimePoolLowWatermarkUsd, 100);
  process.env.GATEWAY_IMAGES_FIRST_BYTE_TIMEOUT_MS = '1000';
  assert.equal(gatewayConfig().imageFirstByteTimeoutMs, 180_000);
  process.env.GATEWAY_IMAGES_FIRST_BYTE_TIMEOUT_MS = '200000';
  assert.equal(gatewayConfig().imageFirstByteTimeoutMs, 200_000);
  process.env.GATEWAY_RISK_SLOT_LIMIT = '25';
  assert.equal(gatewayConfig().riskSlotLimit, 25);
  process.env.GATEWAY_RISK_SLOT_LIMIT = 'garbage';
  assert.equal(gatewayConfig().riskSlotLimit, 10, '非法值回退默认');

  process.env.NEWAPI_RUNTIME_POOL_TARGET_USD = '2000';
  process.env.NEWAPI_RUNTIME_POOL_LOW_WATERMARK_USD = '200';
  assert.equal(gatewayConfig().runtimePoolTargetUsd, 2000);
  assert.equal(gatewayConfig().runtimePoolLowWatermarkUsd, 200);
  process.env.NEWAPI_RUNTIME_POOL_TARGET_USD = 'garbage';
  assert.throws(() => gatewayConfig(), /必须是正安全整数/);
  process.env.NEWAPI_RUNTIME_POOL_TARGET_USD = '200';
  assert.throws(() => gatewayConfig(), /必须小于/);

  delete process.env.APIPOOL_CHECKOUT_ENABLED;
  assert.equal(checkoutEnabled(), false, '缺失 → 关闭（fail-closed）');
  process.env.APIPOOL_CHECKOUT_ENABLED = '';
  assert.equal(checkoutEnabled(), false, '空值 → 关闭');
  process.env.APIPOOL_CHECKOUT_ENABLED = 'yes';
  assert.equal(checkoutEnabled(), false, '非法值 → 关闭');
  process.env.APIPOOL_CHECKOUT_ENABLED = 'true';
  assert.equal(checkoutEnabled(), true, '仅精确 true → 开放');
  process.env.APIPOOL_CHECKOUT_ENABLED = 'false';
  assert.equal(checkoutEnabled(), false);
  delete process.env.APIPOOL_CHECKOUT_ENABLED;
  delete process.env.GATEWAY_RISK_SLOT_LIMIT;
  delete process.env.GATEWAY_IMAGES_FIRST_BYTE_TIMEOUT_MS;
  delete process.env.NEWAPI_RUNTIME_POOL_TARGET_USD;
  delete process.env.NEWAPI_RUNTIME_POOL_LOW_WATERMARK_USD;
});
