// 网关运行时配置直读 process.env，不进 envConfigs，避免双源漂移。
function intEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

export function gatewayConfig() {
  const imageFirstByteTimeoutMs = Math.max(
    180_000,
    intEnv('GATEWAY_IMAGES_FIRST_BYTE_TIMEOUT_MS', 180_000)
  );
  return {
    riskSlotLimit: intEnv('GATEWAY_RISK_SLOT_LIMIT', 10),
    overdraftFreezeMicroUsd: intEnv(
      'GATEWAY_OVERDRAFT_FREEZE_MICRO_USD',
      10_000_000
    ),
    maxBodyBytes: intEnv('GATEWAY_MAX_BODY_BYTES', 26_214_400),
    maxInflight: intEnv('GATEWAY_MAX_INFLIGHT', 16),
    parseBufferMax: intEnv('GATEWAY_PARSE_BUFFER_MAX', 33_554_432),
    firstByteTimeoutMs: intEnv('GATEWAY_FIRST_BYTE_TIMEOUT_MS', 120_000),
    imageFirstByteTimeoutMs,
    nonstreamTotalTimeoutMs: intEnv(
      'GATEWAY_NONSTREAM_TOTAL_TIMEOUT_MS',
      300_000
    ),
    streamIdleTimeoutMs: intEnv('GATEWAY_STREAM_IDLE_TIMEOUT_MS', 180_000),
    hardTimeoutMs: intEnv('GATEWAY_HARD_TIMEOUT_MS', 3_600_000),
    newapiBaseUrl: process.env.NEWAPI_BASE_URL ?? '',
    jobsEnabled: process.env.GATEWAY_JOBS_ENABLED !== 'false',
  };
}

// 钱门禁 fail-closed：仅精确 true 开放，缺失、空值和非法值一律关闭。
export function checkoutEnabled(): boolean {
  return process.env.APIPOOL_CHECKOUT_ENABLED === 'true';
}
