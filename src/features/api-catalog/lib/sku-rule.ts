export const SKU_RULE_COMPILER_VERSION = 1;

const MAX_SOURCE_LENGTH = 8_192;
const MAX_RULES = 64;
const MAX_CONDITIONS_PER_RULE = 12;
const MAX_LIST_VALUES = 32;

export type SkuRuleCondition =
  | {
      field: string;
      operator: 'eq' | 'ne';
      value: string;
    }
  | {
      field: string;
      operator: 'in';
      values: string[];
    }
  | {
      field: string;
      operator: 'missing' | 'present';
    };

export type SkuRuleOutput =
  | { type: 'sku'; template: string }
  | { type: 'reject' };

export type CompiledSkuRule = {
  version: typeof SKU_RULE_COMPILER_VERSION;
  rules: Array<{
    conditions: SkuRuleCondition[];
    output: SkuRuleOutput;
  }>;
  fallback: SkuRuleOutput;
};

export type SkuRuleEvaluation =
  | { ok: true; skuKey: string }
  | { ok: false; reason: 'rejected' | 'missing_template_fact' };

export class SkuRuleCompileError extends Error {}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function assertFieldName(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    !/^[A-Za-z_][A-Za-z0-9_]*$/.test(value) ||
    value.length > 128
  ) {
    throw new SkuRuleCompileError(`${label} 字段名无效`);
  }
  return value;
}

function validateCompiledOutput(
  value: unknown,
  label: string
): SkuRuleOutput {
  if (!isRecord(value)) {
    throw new SkuRuleCompileError(`${label} 输出无效`);
  }
  if (value.type === 'reject') return { type: 'reject' };
  if (
    value.type !== 'sku' ||
    typeof value.template !== 'string' ||
    value.template.length === 0 ||
    value.template.length > MAX_SOURCE_LENGTH
  ) {
    throw new SkuRuleCompileError(`${label} SKU 模板无效`);
  }
  if (
    value.template
      .replace(/\$\{[A-Za-z_][A-Za-z0-9_]*\}/g, '')
      .includes('${')
  ) {
    throw new SkuRuleCompileError(`${label} SKU 模板包含非法插值`);
  }
  return { type: 'sku', template: value.template };
}

/**
 * Published pricing snapshots are immutable but still originate in storage.
 * Re-validate their compiled rule shape before evaluation so corrupt or
 * hand-edited data fails closed instead of becoming executable input.
 */
export function validateCompiledSkuRule(value: unknown): CompiledSkuRule {
  if (!isRecord(value) || value.version !== SKU_RULE_COMPILER_VERSION) {
    throw new SkuRuleCompileError('不支持的 SKU 规则版本');
  }
  if (!Array.isArray(value.rules) || value.rules.length > MAX_RULES) {
    throw new SkuRuleCompileError('SKU 规则列表无效');
  }

  const rules = value.rules.map((candidate, ruleIndex) => {
    if (!isRecord(candidate) || !Array.isArray(candidate.conditions)) {
      throw new SkuRuleCompileError(`SKU 规则 ${ruleIndex + 1} 无效`);
    }
    if (
      candidate.conditions.length === 0 ||
      candidate.conditions.length > MAX_CONDITIONS_PER_RULE
    ) {
      throw new SkuRuleCompileError(
        `SKU 规则 ${ruleIndex + 1} 的条件数量无效`
      );
    }
    const conditions = candidate.conditions.map(
      (rawCondition, conditionIndex): SkuRuleCondition => {
        const label = `SKU 规则 ${ruleIndex + 1} 条件 ${conditionIndex + 1}`;
        if (!isRecord(rawCondition)) {
          throw new SkuRuleCompileError(`${label} 无效`);
        }
        const field = assertFieldName(rawCondition.field, label);
        if (
          rawCondition.operator === 'missing' ||
          rawCondition.operator === 'present'
        ) {
          return { field, operator: rawCondition.operator };
        }
        if (
          (rawCondition.operator === 'eq' ||
            rawCondition.operator === 'ne') &&
          typeof rawCondition.value === 'string' &&
          rawCondition.value.length > 0 &&
          rawCondition.value.length <= MAX_SOURCE_LENGTH
        ) {
          return {
            field,
            operator: rawCondition.operator,
            value: rawCondition.value,
          };
        }
        if (
          rawCondition.operator === 'in' &&
          Array.isArray(rawCondition.values) &&
          rawCondition.values.length > 0 &&
          rawCondition.values.length <= MAX_LIST_VALUES &&
          rawCondition.values.every(
            (item) =>
              typeof item === 'string' && item.length <= MAX_SOURCE_LENGTH
          )
        ) {
          return {
            field,
            operator: 'in',
            values: [...new Set(rawCondition.values as string[])],
          };
        }
        throw new SkuRuleCompileError(`${label} 运算符或参数无效`);
      }
    );
    return {
      conditions,
      output: validateCompiledOutput(
        candidate.output,
        `SKU 规则 ${ruleIndex + 1}`
      ),
    };
  });

  return {
    version: SKU_RULE_COMPILER_VERSION,
    rules,
    fallback: validateCompiledOutput(value.fallback, 'SKU 规则 else'),
  };
}

function parseJsonString(raw: string, label: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new SkuRuleCompileError(`${label} 必须是合法 JSON 字符串`);
  }
  if (typeof parsed !== 'string' || parsed.length === 0) {
    throw new SkuRuleCompileError(`${label} 必须是非空字符串`);
  }
  return parsed;
}

function assertAllowedField(field: string, allowedFields: Set<string>) {
  if (!allowedFields.has(field)) {
    throw new SkuRuleCompileError(`SKU 规则使用了未允许字段：${field}`);
  }
}

function splitConjunctions(raw: string): string[] {
  const result: string[] = [];
  let start = 0;
  let quote = false;
  let escaped = false;
  let bracketDepth = 0;

  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        quote = false;
      }
      continue;
    }
    if (char === '"') {
      quote = true;
      continue;
    }
    if (char === '[') bracketDepth += 1;
    if (char === ']') bracketDepth -= 1;
    if (bracketDepth < 0) {
      throw new SkuRuleCompileError('SKU 规则条件中的数组括号不匹配');
    }
    if (bracketDepth === 0 && char === '&' && raw[index + 1] === '&') {
      result.push(raw.slice(start, index).trim());
      start = index + 2;
      index += 1;
    }
  }

  if (quote || bracketDepth !== 0) {
    throw new SkuRuleCompileError('SKU 规则条件包含未闭合的字符串或数组');
  }
  result.push(raw.slice(start).trim());
  if (result.some((part) => !part)) {
    throw new SkuRuleCompileError('SKU 规则包含空条件');
  }
  if (result.length > MAX_CONDITIONS_PER_RULE) {
    throw new SkuRuleCompileError('单条 SKU 规则条件过多');
  }
  return result;
}

function parseCondition(
  raw: string,
  allowedFields: Set<string>
): SkuRuleCondition {
  const presence = raw.match(
    /^([A-Za-z_][A-Za-z0-9_]*)\s+is\s+(missing|present)$/
  );
  if (presence) {
    const [, field, operator] = presence;
    assertAllowedField(field, allowedFields);
    return {
      field,
      operator: operator as 'missing' | 'present',
    };
  }

  const list = raw.match(/^([A-Za-z_][A-Za-z0-9_]*)\s+in\s+(\[[\s\S]*\])$/);
  if (list) {
    const [, field, valuesRaw] = list;
    assertAllowedField(field, allowedFields);
    let values: unknown;
    try {
      values = JSON.parse(valuesRaw);
    } catch {
      throw new SkuRuleCompileError(`字段 ${field} 的 in 列表不是合法 JSON`);
    }
    if (
      !Array.isArray(values) ||
      values.length === 0 ||
      values.length > MAX_LIST_VALUES ||
      !values.every((value) => typeof value === 'string')
    ) {
      throw new SkuRuleCompileError(
        `字段 ${field} 的 in 列表必须包含 1 到 ${MAX_LIST_VALUES} 个字符串`
      );
    }
    return { field, operator: 'in', values: [...new Set(values)] };
  }

  const comparison = raw.match(
    /^([A-Za-z_][A-Za-z0-9_]*)\s*(==|!=)\s*("[\s\S]*")$/
  );
  if (comparison) {
    const [, field, rawOperator, valueRaw] = comparison;
    assertAllowedField(field, allowedFields);
    return {
      field,
      operator: rawOperator === '==' ? 'eq' : 'ne',
      value: parseJsonString(valueRaw, `字段 ${field} 的比较值`),
    };
  }

  throw new SkuRuleCompileError(`无法解析 SKU 规则条件：${raw}`);
}

function parseOutput(raw: string, allowedFields: Set<string>): SkuRuleOutput {
  if (raw === 'reject') return { type: 'reject' };
  const template = parseJsonString(raw, 'SKU 规则输出');
  const placeholders = [
    ...template.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g),
  ];
  for (const match of placeholders) {
    assertAllowedField(match[1], allowedFields);
  }
  if (template.replace(/\$\{[A-Za-z_][A-Za-z0-9_]*\}/g, '').includes('${')) {
    throw new SkuRuleCompileError('SKU 模板包含非法插值');
  }
  return { type: 'sku', template };
}

export function compileSkuRule(
  source: string,
  options: { allowedFields: readonly string[] }
): CompiledSkuRule {
  const normalized = source.replace(/\r\n?/g, '\n').trim();
  if (!normalized) {
    throw new SkuRuleCompileError('SKU 规则不能为空');
  }
  if (normalized.length > MAX_SOURCE_LENGTH) {
    throw new SkuRuleCompileError('SKU 规则过长');
  }

  const allowedFields = new Set(options.allowedFields);
  const lines = normalized
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
  const rules: CompiledSkuRule['rules'] = [];
  let fallback: SkuRuleOutput | null = null;

  for (const line of lines) {
    const otherwise = line.match(/^else\s*=>\s*([\s\S]+)$/);
    if (otherwise) {
      if (fallback) {
        throw new SkuRuleCompileError('SKU 规则只能包含一个 else');
      }
      fallback = parseOutput(otherwise[1].trim(), allowedFields);
      continue;
    }
    if (fallback) {
      throw new SkuRuleCompileError('SKU 规则的 else 必须位于最后');
    }

    const when = line.match(/^when\s+([\s\S]+?)\s*=>\s*([\s\S]+)$/);
    if (!when) {
      throw new SkuRuleCompileError(`无法解析 SKU 规则行：${line}`);
    }
    rules.push({
      conditions: splitConjunctions(when[1]).map((condition) =>
        parseCondition(condition, allowedFields)
      ),
      output: parseOutput(when[2].trim(), allowedFields),
    });
    if (rules.length > MAX_RULES) {
      throw new SkuRuleCompileError('SKU 规则条数过多');
    }
  }

  if (!fallback) {
    throw new SkuRuleCompileError('SKU 规则必须包含 else');
  }
  return {
    version: SKU_RULE_COMPILER_VERSION,
    rules,
    fallback,
  };
}

function conditionMatches(
  condition: SkuRuleCondition,
  facts: Readonly<Record<string, string | null>>
) {
  const value = facts[condition.field] ?? null;
  switch (condition.operator) {
    case 'missing':
      return value === null || value === '';
    case 'present':
      return value !== null && value !== '';
    case 'eq':
      return value === condition.value;
    case 'ne':
      return value !== condition.value;
    case 'in':
      return value !== null && condition.values.includes(value);
  }
}

function renderOutput(
  output: SkuRuleOutput,
  facts: Readonly<Record<string, string | null>>
): SkuRuleEvaluation {
  if (output.type === 'reject') return { ok: false, reason: 'rejected' };
  let missing = false;
  const skuKey = output.template.replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g,
    (_, field: string) => {
      const value = facts[field];
      if (value === null || value === undefined || value === '') {
        missing = true;
        return '';
      }
      return value;
    }
  );
  if (missing) return { ok: false, reason: 'missing_template_fact' };
  return { ok: true, skuKey };
}

export function evaluateSkuRule(
  rule: CompiledSkuRule,
  facts: Readonly<Record<string, string | null>>
): SkuRuleEvaluation {
  for (const candidate of rule.rules) {
    if (
      candidate.conditions.every((condition) =>
        conditionMatches(condition, facts)
      )
    ) {
      return renderOutput(candidate.output, facts);
    }
  }
  return renderOutput(rule.fallback, facts);
}
