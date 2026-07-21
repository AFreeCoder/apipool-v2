import assert from 'node:assert/strict';
import test from 'node:test';
import {
  LONG_METER_MAP,
  TOKEN_METER_KEYS,
  toLongMeterKey,
} from '@/features/gateway/lib/meters';

test('词表：token meter 键集合与设计 §5.1 一致', () => {
  assert.deepEqual(
    [...TOKEN_METER_KEYS].sort(),
    [
      'cache_write',
      'cache_write_5m',
      'cache_write_1h',
      'cached_image_input',
      'cached_input',
      'image_input',
      'image_output',
      'input',
      'output',
    ].sort()
  );
});

test('词表：长档映射只覆盖文本四通道且键名带 _long 后缀', () => {
  assert.deepEqual(LONG_METER_MAP, {
    input: 'input_long',
    cached_input: 'cached_input_long',
    cache_write: 'cache_write_long',
    output: 'output_long',
  });
  assert.equal(toLongMeterKey('input'), 'input_long');
  assert.equal(toLongMeterKey('image_input'), 'image_input');
});
