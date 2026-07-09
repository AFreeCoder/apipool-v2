/**
 * 验签通过、但本站不处理的 webhook 事件类型。
 *
 * 这类事件必须以 200 应答：provider 只关心「你收到了吗」。若回 500，Stripe 会
 * 按重试策略反复投递数天，持续失败可能触发 endpoint 告警甚至禁用——届时真正
 * 的支付成功事件也一并收不到。
 *
 * 与之相对，验签失败必须继续回非 200：那不是「不处理」，是「不可信」。
 */
export class UnhandledPaymentEventError extends Error {
  readonly provider: string;
  readonly eventType: string;

  constructor(provider: string, eventType: string) {
    super(`${provider} does not handle event type: ${eventType}`);
    this.name = 'UnhandledPaymentEventError';
    this.provider = provider;
    this.eventType = eventType;
  }
}

export function isUnhandledPaymentEvent(
  error: unknown
): error is UnhandledPaymentEventError {
  return error instanceof UnhandledPaymentEventError;
}

/**
 * 是否运行在生产环境。
 *
 * 用于 webhook 验签的兜底：provider 的「sandbox 可放松验签」开关来自 DB 配置，
 * 上线时忘改就等于把伪造 webhook 的大门敞开。运行时环境一票否决——配置项只能
 * 让验签更严，不能更松。
 */
export function isProductionRuntime(): boolean {
  return process.env.NODE_ENV === 'production';
}
