import assert from 'node:assert/strict';
import test from 'node:test';

import {
  compileSkuRule,
  evaluateSkuRule,
  SkuRuleCompileError,
  validateCompiledSkuRule,
} from '@/features/api-catalog/lib/sku-rule';

const IMAGE_RULE = `
when quality in ["low", "medium", "high"] && size in ["1024x1024", "1024x1536", "1536x1024"] => "quality=\${quality};size=\${size}"
when quality is missing => "default"
when quality == "auto" => "default"
when size is missing => "default"
when size == "auto" => "default"
else => reject
`;

test('SKU DSL 编译并按顺序选择图片 SKU', () => {
  const compiled = compileSkuRule(IMAGE_RULE, {
    allowedFields: ['quality', 'size'],
  });
  assert.deepEqual(
    evaluateSkuRule(compiled, {
      quality: 'low',
      size: '1024x1024',
    }),
    { ok: true, skuKey: 'quality=low;size=1024x1024' }
  );
  assert.deepEqual(
    evaluateSkuRule(compiled, { quality: 'auto', size: '1024x1024' }),
    { ok: true, skuKey: 'default' }
  );
  assert.deepEqual(
    evaluateSkuRule(compiled, { quality: 'low', size: '2048x2048' }),
    { ok: false, reason: 'rejected' }
  );
});

test('SKU DSL 拒绝未知字段、任意表达式和缺失 else', () => {
  for (const source of [
    'when process == "x" => "default"\nelse => reject',
    'when quality == env("SECRET") => "default"\nelse => reject',
    'when quality == "low" => "default"',
  ]) {
    assert.throws(
      () =>
        compileSkuRule(source, {
          allowedFields: ['quality', 'size'],
        }),
      SkuRuleCompileError
    );
  }
});

test('SKU DSL 模板缺少运行时 fact 时 fail closed', () => {
  const compiled = compileSkuRule(
    'when quality is present => "quality=${quality};size=${size}"\nelse => reject',
    { allowedFields: ['quality', 'size'] }
  );
  assert.deepEqual(evaluateSkuRule(compiled, { quality: 'low', size: null }), {
    ok: false,
    reason: 'missing_template_fact',
  });
});

test('存储中的非法编译 AST 会 fail closed', () => {
  for (const value of [
    {
      version: 1,
      rules: [{ conditions: [], output: { type: 'sku', template: 'x' } }],
      fallback: { type: 'reject' },
    },
    {
      version: 1,
      rules: [
        {
          conditions: [{ field: 'quality', operator: 'eval', value: 'x' }],
          output: { type: 'sku', template: 'x' },
        },
      ],
      fallback: { type: 'reject' },
    },
    {
      version: 1,
      rules: [],
      fallback: { type: 'sku', template: '${process.exit()}' },
    },
  ]) {
    assert.throws(() => validateCompiledSkuRule(value), SkuRuleCompileError);
  }
});
