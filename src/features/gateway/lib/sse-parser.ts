import type { GatewayEndpointKey } from './endpoints';

export type ModelExtraction =
  | { ok: true; model: string }
  | { ok: false; reason: 'missing' | 'ambiguous' | 'malformed' };

export type StreamExtraction =
  | { ok: true; isStream: boolean }
  | { ok: false; reason: 'missing' | 'ambiguous' | 'malformed' };

const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const COLON = 0x3a;
const OPEN_BRACE = 0x7b;
const OPEN_BRACKET = 0x5b;
const CLOSE_BRACE = 0x7d;
const CLOSE_BRACKET = 0x5d;
const MODEL_VALUE_MAX_BYTES = 512;
const MODEL_KEY = [0x6d, 0x6f, 0x64, 0x65, 0x6c];
const STREAM_KEY = [0x73, 0x74, 0x72, 0x65, 0x61, 0x6d];
const TRUE_VALUE = [0x74, 0x72, 0x75, 0x65];
const FALSE_VALUE = [0x66, 0x61, 0x6c, 0x73, 0x65];

const isWhitespace = (byte: number) =>
  byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d;

const hexDigit = (byte: number) =>
  byte >= 0x30 && byte <= 0x39
    ? byte - 0x30
    : byte >= 0x61 && byte <= 0x66
      ? byte - 0x57
      : byte >= 0x41 && byte <= 0x46
        ? byte - 0x37
        : -1;

function skipJsonString(
  body: Uint8Array,
  openQuoteIndex: number
): number | null {
  let index = openQuoteIndex + 1;
  while (index < body.length) {
    const byte = body[index];
    if (byte === QUOTE) return index + 1;
    if (byte < 0x20) return null;
    if (byte !== BACKSLASH) {
      index += 1;
      continue;
    }
    const escape = body[index + 1];
    if (escape === 0x75) {
      for (let offset = 0; offset < 4; offset += 1) {
        if (hexDigit(body[index + 2 + offset] ?? -1) < 0) return null;
      }
      index += 6;
      continue;
    }
    if (
      escape !== 0x22 &&
      escape !== 0x5c &&
      escape !== 0x2f &&
      escape !== 0x62 &&
      escape !== 0x66 &&
      escape !== 0x6e &&
      escape !== 0x72 &&
      escape !== 0x74
    ) {
      return null;
    }
    index += 2;
  }
  return null;
}

function walkJsonString(
  body: Uint8Array,
  openQuoteIndex: number,
  onByte: (byte: number) => boolean
): number | null {
  let index = openQuoteIndex + 1;
  while (index < body.length) {
    const byte = body[index];
    if (byte === QUOTE) return index + 1;
    if (byte < 0x20) return null;
    if (byte !== BACKSLASH) {
      if (!onByte(byte)) return null;
      index += 1;
      continue;
    }

    const escape = body[index + 1];
    if (escape === 0x75) {
      let codePoint = 0;
      for (let offset = 0; offset < 4; offset += 1) {
        const digit = hexDigit(body[index + 2 + offset] ?? -1);
        if (digit < 0) return null;
        codePoint = codePoint * 16 + digit;
      }
      if (codePoint < 0x80) {
        if (!onByte(codePoint)) return null;
      } else if (codePoint < 0x800) {
        if (
          !onByte(0xc0 | (codePoint >> 6)) ||
          !onByte(0x80 | (codePoint & 0x3f))
        ) {
          return null;
        }
      } else if (
        !onByte(0xe0 | (codePoint >> 12)) ||
        !onByte(0x80 | ((codePoint >> 6) & 0x3f)) ||
        !onByte(0x80 | (codePoint & 0x3f))
      ) {
        return null;
      }
      index += 6;
      continue;
    }

    const escapedBytes: Record<number, number> = {
      0x22: 0x22,
      0x5c: 0x5c,
      0x2f: 0x2f,
      0x62: 0x08,
      0x66: 0x0c,
      0x6e: 0x0a,
      0x72: 0x0d,
      0x74: 0x09,
    };
    if (!(escape in escapedBytes)) return null;
    if (!onByte(escapedBytes[escape])) return null;
    index += 2;
  }
  return null;
}

function matchJsonString(
  body: Uint8Array,
  openQuoteIndex: number,
  expected: readonly number[]
): { end: number; matches: boolean } | null {
  const end = skipJsonString(body, openQuoteIndex);
  if (end === null) return null;
  if (end - openQuoteIndex > expected.length * 6 + 2) {
    return { end, matches: false };
  }
  let position = 0;
  let matches = true;
  const decodedEnd = walkJsonString(body, openQuoteIndex, (byte) => {
    if (
      matches &&
      (position >= expected.length || byte !== expected[position])
    ) {
      matches = false;
    }
    position += 1;
    return true;
  });
  if (decodedEnd === null) return null;
  return { end, matches: matches && position === expected.length };
}

function decodeBoundedString(
  body: Uint8Array,
  openQuoteIndex: number,
  maxBytes: number
): { value: string; end: number } | null {
  const output: number[] = [];
  const end = walkJsonString(body, openQuoteIndex, (byte) => {
    if (output.length >= maxBytes) return false;
    output.push(byte);
    return true;
  });
  if (end === null) return null;
  return {
    value: new TextDecoder('utf-8', { fatal: false }).decode(
      Uint8Array.from(output)
    ),
    end,
  };
}

export function extractTopLevelModel(body: Uint8Array): ModelExtraction {
  let model: string | null = null;
  let depth = 0;
  let index = 0;

  while (index < body.length) {
    const byte = body[index];
    if (byte === QUOTE) {
      const key = matchJsonString(body, index, MODEL_KEY);
      if (!key) return { ok: false, reason: 'malformed' };
      if (depth === 1 && key.matches) {
        let colonIndex = key.end;
        while (colonIndex < body.length && isWhitespace(body[colonIndex])) {
          colonIndex += 1;
        }
        if (body[colonIndex] === COLON) {
          let valueIndex = colonIndex + 1;
          while (valueIndex < body.length && isWhitespace(body[valueIndex])) {
            valueIndex += 1;
          }
          if (body[valueIndex] !== QUOTE) {
            return { ok: false, reason: 'malformed' };
          }
          if (model !== null) return { ok: false, reason: 'ambiguous' };
          const value = decodeBoundedString(
            body,
            valueIndex,
            MODEL_VALUE_MAX_BYTES
          );
          if (!value) return { ok: false, reason: 'malformed' };
          model = value.value;
          index = value.end;
          continue;
        }
      }
      index = key.end;
      continue;
    }

    if (byte === OPEN_BRACE || byte === OPEN_BRACKET) depth += 1;
    if (byte === CLOSE_BRACE || byte === CLOSE_BRACKET) {
      depth -= 1;
      if (depth < 0) return { ok: false, reason: 'malformed' };
    }
    index += 1;
  }

  if (depth !== 0) return { ok: false, reason: 'malformed' };
  if (model === null) return { ok: false, reason: 'missing' };
  return { ok: true, model };
}

function matchesLiteral(
  body: Uint8Array,
  start: number,
  expected: readonly number[]
): boolean {
  for (let offset = 0; offset < expected.length; offset += 1) {
    if (body[start + offset] !== expected[offset]) return false;
  }
  const next = body[start + expected.length];
  return (
    next === undefined ||
    isWhitespace(next) ||
    next === 0x2c ||
    next === CLOSE_BRACE ||
    next === CLOSE_BRACKET
  );
}

export function extractTopLevelStream(body: Uint8Array): StreamExtraction {
  let isStream: boolean | null = null;
  let depth = 0;
  let index = 0;

  while (index < body.length) {
    const byte = body[index];
    if (byte === QUOTE) {
      const key = matchJsonString(body, index, STREAM_KEY);
      if (!key) return { ok: false, reason: 'malformed' };
      if (depth === 1 && key.matches) {
        let colonIndex = key.end;
        while (colonIndex < body.length && isWhitespace(body[colonIndex])) {
          colonIndex += 1;
        }
        if (body[colonIndex] === COLON) {
          if (isStream !== null) return { ok: false, reason: 'ambiguous' };
          let valueIndex = colonIndex + 1;
          while (valueIndex < body.length && isWhitespace(body[valueIndex])) {
            valueIndex += 1;
          }
          if (matchesLiteral(body, valueIndex, TRUE_VALUE)) {
            isStream = true;
            index = valueIndex + TRUE_VALUE.length;
            continue;
          }
          if (matchesLiteral(body, valueIndex, FALSE_VALUE)) {
            isStream = false;
            index = valueIndex + FALSE_VALUE.length;
            continue;
          }
          return { ok: false, reason: 'malformed' };
        }
      }
      index = key.end;
      continue;
    }

    if (byte === OPEN_BRACE || byte === OPEN_BRACKET) depth += 1;
    if (byte === CLOSE_BRACE || byte === CLOSE_BRACKET) {
      depth -= 1;
      if (depth < 0) return { ok: false, reason: 'malformed' };
    }
    index += 1;
  }

  if (depth !== 0) return { ok: false, reason: 'malformed' };
  if (isStream === null) return { ok: false, reason: 'missing' };
  return { ok: true, isStream };
}

export interface ExtractedUsage {
  usage: Record<string, unknown> | null;
  complete: boolean;
  unitCount?: number;
}

export interface UsageExtractor {
  push(chunk: Uint8Array): void;
  finish(): ExtractedUsage;
  overflowed: boolean;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function createStreamExtractor(
  endpoint: GatewayEndpointKey,
  maxBufferBytes: number
): UsageExtractor {
  const decoder = new TextDecoder();
  let carry = '';
  let consumed = 0;
  let usage: Record<string, unknown> | null = null;
  let complete = false;
  let overflowed = false;
  let finished: ExtractedUsage | null = null;

  const merge = (found: unknown) => {
    const record = asRecord(found);
    if (record) usage = { ...(usage ?? {}), ...record };
    return record !== null;
  };

  const processLine = (rawLine: string) => {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    const trimmed = line.trimStart();
    if (!trimmed.startsWith('data:')) return;
    const data = trimmed.slice(5).trim();
    if (data === '[DONE]' || !data.includes('"usage"')) return;
    let parsed: Record<string, unknown>;
    try {
      const value = JSON.parse(data);
      const record = asRecord(value);
      if (!record) return;
      parsed = record;
    } catch {
      return;
    }

    if (endpoint === 'chat_completions' || endpoint === 'embeddings') {
      if (merge(parsed.usage)) complete = true;
      return;
    }
    if (endpoint === 'responses') {
      const response = asRecord(parsed.response);
      merge(response?.usage ?? parsed.usage);
      if (parsed.type === 'response.completed') complete = true;
      return;
    }
    if (endpoint === 'messages') {
      const message = asRecord(parsed.message);
      merge(message?.usage);
      if (merge(parsed.usage) && parsed.type === 'message_delta') {
        complete = true;
      }
    }
  };

  const drainLines = () => {
    let newline = carry.indexOf('\n');
    while (newline >= 0) {
      processLine(carry.slice(0, newline));
      carry = carry.slice(newline + 1);
      newline = carry.indexOf('\n');
    }
  };

  return {
    push(chunk: Uint8Array) {
      if (overflowed || finished) return;
      consumed += chunk.byteLength;
      if (consumed > maxBufferBytes) {
        overflowed = true;
        carry = '';
        usage = null;
        complete = false;
        return;
      }
      carry += decoder.decode(chunk, { stream: true });
      drainLines();
    },
    finish() {
      if (finished) return finished;
      if (overflowed) {
        finished = { usage: null, complete: false };
        return finished;
      }
      carry += decoder.decode();
      drainLines();
      if (carry) processLine(carry);
      finished = { usage, complete };
      return finished;
    },
    get overflowed() {
      return overflowed;
    },
    set overflowed(value: boolean) {
      overflowed = value;
    },
  };
}

type ObjectRange = { start: number; end: number };
type PropertyScan = { ok: true; range: ObjectRange | null } | { ok: false };

function skipWhitespace(body: Uint8Array, start: number): number {
  let index = start;
  while (index < body.length && isWhitespace(body[index])) index += 1;
  return index;
}

function findBalancedObject(
  body: Uint8Array,
  openIndex: number
): ObjectRange | null {
  if (body[openIndex] !== OPEN_BRACE) return null;
  let depth = 0;
  let index = openIndex;
  while (index < body.length) {
    const byte = body[index];
    if (byte === QUOTE) {
      const end = skipJsonString(body, index);
      if (end === null) return null;
      index = end;
      continue;
    }
    if (byte === OPEN_BRACE || byte === OPEN_BRACKET) depth += 1;
    if (byte === CLOSE_BRACE || byte === CLOSE_BRACKET) {
      depth -= 1;
      if (depth === 0) return { start: openIndex, end: index + 1 };
      if (depth < 0) return null;
    }
    index += 1;
  }
  return null;
}

function findDirectObjectProperty(
  body: Uint8Array,
  objectRange: ObjectRange,
  keyBytes: readonly number[]
): PropertyScan {
  let depth = 0;
  let index = objectRange.start;
  let found: ObjectRange | null = null;

  while (index < objectRange.end) {
    const byte = body[index];
    if (byte === QUOTE) {
      const key = matchJsonString(body, index, keyBytes);
      if (!key) return { ok: false };
      if (depth === 1 && key.matches) {
        const colonIndex = skipWhitespace(body, key.end);
        if (body[colonIndex] === COLON) {
          if (found) return { ok: false };
          const valueIndex = skipWhitespace(body, colonIndex + 1);
          const valueRange = findBalancedObject(body, valueIndex);
          if (!valueRange) return { ok: false };
          found = valueRange;
          index = valueRange.end;
          continue;
        }
      }
      index = key.end;
      continue;
    }
    if (byte === OPEN_BRACE || byte === OPEN_BRACKET) depth += 1;
    if (byte === CLOSE_BRACE || byte === CLOSE_BRACKET) {
      depth -= 1;
      if (depth < 0) return { ok: false };
    }
    index += 1;
  }
  if (depth !== 0) return { ok: false };
  return { ok: true, range: found };
}

function findDirectArrayProperty(
  body: Uint8Array,
  objectRange: ObjectRange,
  keyBytes: readonly number[]
): PropertyScan {
  let depth = 0;
  let index = objectRange.start;
  let found: ObjectRange | null = null;

  while (index < objectRange.end) {
    const byte = body[index];
    if (byte === QUOTE) {
      const key = matchJsonString(body, index, keyBytes);
      if (!key) return { ok: false };
      if (depth === 1 && key.matches) {
        const colonIndex = skipWhitespace(body, key.end);
        if (body[colonIndex] === COLON) {
          if (found) return { ok: false };
          const valueIndex = skipWhitespace(body, colonIndex + 1);
          if (body[valueIndex] !== OPEN_BRACKET) return { ok: false };
          const valueRange = findBalancedContainer(body, valueIndex);
          if (!valueRange) return { ok: false };
          found = valueRange;
          index = valueRange.end;
          continue;
        }
      }
      index = key.end;
      continue;
    }
    if (byte === OPEN_BRACE || byte === OPEN_BRACKET) depth += 1;
    if (byte === CLOSE_BRACE || byte === CLOSE_BRACKET) {
      depth -= 1;
      if (depth < 0) return { ok: false };
    }
    index += 1;
  }
  if (depth !== 0) return { ok: false };
  return { ok: true, range: found };
}

function findBalancedContainer(
  body: Uint8Array,
  openIndex: number
): ObjectRange | null {
  if (body[openIndex] !== OPEN_BRACE && body[openIndex] !== OPEN_BRACKET) {
    return null;
  }
  let depth = 0;
  let index = openIndex;
  while (index < body.length) {
    const byte = body[index];
    if (byte === QUOTE) {
      const end = skipJsonString(body, index);
      if (end === null) return null;
      index = end;
      continue;
    }
    if (byte === OPEN_BRACE || byte === OPEN_BRACKET) depth += 1;
    if (byte === CLOSE_BRACE || byte === CLOSE_BRACKET) {
      depth -= 1;
      if (depth === 0) return { start: openIndex, end: index + 1 };
      if (depth < 0) return null;
    }
    index += 1;
  }
  return null;
}

function countDirectArrayItems(body: Uint8Array, range: ObjectRange): number {
  let depth = 0;
  let commas = 0;
  let hasValue = false;
  let index = range.start;
  while (index < range.end) {
    const byte = body[index];
    if (byte === QUOTE) {
      hasValue = true;
      const end = skipJsonString(body, index);
      if (end === null) return 0;
      index = end;
      continue;
    }
    if (byte === OPEN_BRACE || byte === OPEN_BRACKET) {
      depth += 1;
      if (depth > 1) hasValue = true;
    } else if (byte === CLOSE_BRACE || byte === CLOSE_BRACKET) {
      depth -= 1;
    } else if (byte === 0x2c && depth === 1) {
      commas += 1;
    } else if (depth === 1 && !isWhitespace(byte)) {
      hasValue = true;
    }
    index += 1;
  }
  return hasValue ? commas + 1 : 0;
}

const USAGE_KEY = [0x75, 0x73, 0x61, 0x67, 0x65];
const RESPONSE_KEY = [0x72, 0x65, 0x73, 0x70, 0x6f, 0x6e, 0x73, 0x65];
const DATA_KEY = [0x64, 0x61, 0x74, 0x61];

function extractBodyUsage(
  endpoint: GatewayEndpointKey,
  body: Uint8Array
): ExtractedUsage {
  const rootStart = skipWhitespace(body, 0);
  const root = findBalancedObject(body, rootStart);
  if (!root || skipWhitespace(body, root.end) !== body.length) {
    return { usage: null, complete: false };
  }

  const rootData = findDirectArrayProperty(body, root, DATA_KEY);
  if (!rootData.ok) return { usage: null, complete: false };
  const unitCount = rootData.range
    ? countDirectArrayItems(body, rootData.range)
    : undefined;
  const countResult = unitCount === undefined ? {} : { unitCount };

  const rootUsage = findDirectObjectProperty(body, root, USAGE_KEY);
  if (!rootUsage.ok) {
    return { usage: null, complete: false, ...countResult };
  }
  const candidates: ObjectRange[] = [];
  if (rootUsage.range) candidates.push(rootUsage.range);

  if (endpoint === 'responses') {
    const response = findDirectObjectProperty(body, root, RESPONSE_KEY);
    if (!response.ok) {
      return { usage: null, complete: false, ...countResult };
    }
    if (response.range) {
      const nestedUsage = findDirectObjectProperty(
        body,
        response.range,
        USAGE_KEY
      );
      if (!nestedUsage.ok) {
        return { usage: null, complete: false, ...countResult };
      }
      if (nestedUsage.range) candidates.push(nestedUsage.range);
    }
  }

  if (candidates.length !== 1) {
    return { usage: null, complete: false, ...countResult };
  }
  const candidate = candidates[0];
  try {
    const parsed = JSON.parse(
      new TextDecoder().decode(body.subarray(candidate.start, candidate.end))
    );
    const usage = asRecord(parsed);
    return usage
      ? { usage, complete: true, ...countResult }
      : { usage: null, complete: false, ...countResult };
  } catch {
    return { usage: null, complete: false, ...countResult };
  }
}

function createBodyExtractor(
  endpoint: GatewayEndpointKey,
  maxBufferBytes: number
): UsageExtractor {
  const chunks: Uint8Array[] = [];
  let total = 0;
  let overflowed = false;
  let finished: ExtractedUsage | null = null;
  return {
    push(chunk: Uint8Array) {
      if (overflowed || finished) return;
      total += chunk.byteLength;
      if (total > maxBufferBytes) {
        overflowed = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk.slice());
    },
    finish() {
      if (finished) return finished;
      if (overflowed) {
        finished = { usage: null, complete: false };
        return finished;
      }
      const body = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        body.set(chunk, offset);
        offset += chunk.byteLength;
      }
      finished = extractBodyUsage(endpoint, body);
      return finished;
    },
    get overflowed() {
      return overflowed;
    },
    set overflowed(value: boolean) {
      overflowed = value;
    },
  };
}

export function createUsageExtractor(
  endpoint: GatewayEndpointKey,
  isStream: boolean,
  maxBufferBytes: number
): UsageExtractor {
  return isStream
    ? createStreamExtractor(endpoint, maxBufferBytes)
    : createBodyExtractor(endpoint, maxBufferBytes);
}
