import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const REQUIRED = [
  'NEWAPI_RUNTIME_POOL_TARGET_USD',
  'NEWAPI_RUNTIME_POOL_LOW_WATERMARK_USD',
  'GATEWAY_RISK_SLOT_LIMIT',
  'GATEWAY_OVERDRAFT_FREEZE_MICRO_USD',
  'GATEWAY_MAX_BODY_BYTES',
  'GATEWAY_MAX_INFLIGHT',
  'GATEWAY_PARSE_BUFFER_MAX',
  'GATEWAY_FIRST_BYTE_TIMEOUT_MS',
  'GATEWAY_NONSTREAM_TOTAL_TIMEOUT_MS',
  'GATEWAY_STREAM_IDLE_TIMEOUT_MS',
  'GATEWAY_HARD_TIMEOUT_MS',
  'GATEWAY_JOBS_ENABLED',
  'APIPOOL_CHECKOUT_ENABLED',
];

for (const composePath of ['docker-compose.yml', 'docker-compose.prod.yml']) {
  test(`${composePath} 将网关与 checkout 变量显式注入门户容器`, async () => {
    const compose = await readFile(composePath, 'utf8');
    for (const key of REQUIRED) {
      assert.equal(
        compose
          .split('\n')
          .some((line) => line.trim() === `${key}: ` + '${' + `${key}}`),
        true,
        `${composePath} 缺少 ${key} allowlist 映射`
      );
    }
    for (const removed of [
      'WALLET_LEDGER_WRITE_ENABLED',
      'WALLET_DISPLAY_ENABLED',
      'APIPOOL_API_MODE',
    ]) {
      assert.doesNotMatch(compose, new RegExp(removed));
    }
  });
}
