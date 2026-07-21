// 计费词表唯一事实源（DESIGN §5.1）：账本、价格和用量归一化共用。
export const TOKEN_METER_KEYS = [
  'input',
  'cached_input',
  'cache_write',
  'cache_write_5m',
  'cache_write_1h',
  'output',
  'image_input',
  'cached_image_input',
  'image_output',
] as const;

export const LONG_TOKEN_METER_KEYS = [
  'input_long',
  'cached_input_long',
  'cache_write_long',
  'output_long',
] as const;

export type MeterKey =
  | (typeof TOKEN_METER_KEYS)[number]
  | (typeof LONG_TOKEN_METER_KEYS)[number]
  | 'web_search';

export const LONG_METER_MAP: Partial<Record<MeterKey, MeterKey>> = {
  input: 'input_long',
  cached_input: 'cached_input_long',
  cache_write: 'cache_write_long',
  output: 'output_long',
};

export function toLongMeterKey(key: MeterKey): MeterKey {
  return LONG_METER_MAP[key] ?? key;
}

export type MeterQuantities = Partial<Record<MeterKey, number>>;
export type BillingScheme = 'token' | 'per_call';
