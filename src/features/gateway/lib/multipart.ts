import type { RequestAdmissionMetadata } from './sse-parser';

const CRLF = new Uint8Array([0x0d, 0x0a]);
const HEADER_SEPARATOR = new Uint8Array([0x0d, 0x0a, 0x0d, 0x0a]);
const MAX_PART_HEADER_BYTES = 16 * 1024;
const FIELD_LIMITS: Record<string, number> = {
  model: 512,
  prompt: 1024 * 1024,
  quality: 128,
  size: 128,
  resolution: 128,
  n: 32,
  stream: 8,
};

export type ImageMultipartFields = {
  model: string;
  quality: string | null;
  size: string | null;
  resolution: string | null;
  n: number | null;
  promptBytes: number;
  stream: boolean;
};

export type ImageMultipartExtraction =
  | {
      ok: true;
      fields: ImageMultipartFields;
      admissionMetadata: RequestAdmissionMetadata;
    }
  | {
      ok: false;
      reason:
        | 'missing_model'
        | 'missing_image'
        | 'malformed'
        | 'field_too_large';
    };

function parseBoundary(contentType: string | null): string | null {
  if (!contentType || !/^multipart\/form-data(?:\s*;|$)/i.test(contentType)) {
    return null;
  }
  const match = contentType.match(
    /(?:^|;)\s*boundary=(?:"([^"]+)"|([^;\s]+))/i
  );
  const boundary = match?.[1] ?? match?.[2] ?? '';
  if (
    boundary.length < 1 ||
    boundary.length > 70 ||
    /[^\x21-\x7e]/.test(boundary)
  ) {
    return null;
  }
  return boundary;
}

function indexOfSequence(
  body: Uint8Array,
  needle: Uint8Array,
  start: number
): number {
  let candidate = body.indexOf(needle[0], start);
  while (candidate >= 0 && candidate + needle.length <= body.length) {
    let matched = true;
    for (let offset = 1; offset < needle.length; offset += 1) {
      if (body[candidate + offset] !== needle[offset]) {
        matched = false;
        break;
      }
    }
    if (matched) return candidate;
    candidate = body.indexOf(needle[0], candidate + 1);
  }
  return -1;
}

function startsWithBytes(
  body: Uint8Array,
  expected: Uint8Array,
  start: number
): boolean {
  if (start + expected.length > body.length) return false;
  for (let index = 0; index < expected.length; index += 1) {
    if (body[start + index] !== expected[index]) return false;
  }
  return true;
}

function parseDisposition(headers: string): {
  name: string | null;
  hasFilename: boolean;
} {
  const line = headers
    .split(/\r\n/)
    .find((header) => /^content-disposition\s*:/i.test(header));
  if (!line || !/form-data/i.test(line)) {
    return { name: null, hasFilename: false };
  }
  const name = line.match(/(?:^|;)\s*name="([^"]*)"/i)?.[1] ?? null;
  return {
    name,
    hasFilename: /(?:^|;)\s*filename(?:\*?)=/i.test(line),
  };
}

function decodeText(value: Uint8Array): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(value);
  } catch {
    return null;
  }
}

export function extractImageMultipartRequest(
  body: Uint8Array,
  contentType: string | null
): ImageMultipartExtraction {
  const boundary = parseBoundary(contentType);
  if (!boundary) return { ok: false, reason: 'malformed' };

  const boundaryBytes = new TextEncoder().encode(`--${boundary}`);
  const nextBoundaryBytes = new TextEncoder().encode(`\r\n--${boundary}`);
  if (!startsWithBytes(body, boundaryBytes, 0)) {
    return { ok: false, reason: 'malformed' };
  }

  const values = new Map<string, Uint8Array>();
  let hasImageFile = false;
  let totalTextChars = 0;
  let cursor = boundaryBytes.length;
  let closed = false;
  while (cursor < body.length) {
    if (body[cursor] === 0x2d && body[cursor + 1] === 0x2d) {
      cursor += 2;
      if (startsWithBytes(body, CRLF, cursor)) cursor += CRLF.length;
      if (cursor !== body.length) return { ok: false, reason: 'malformed' };
      closed = true;
      break;
    }
    if (!startsWithBytes(body, CRLF, cursor)) {
      return { ok: false, reason: 'malformed' };
    }
    cursor += CRLF.length;

    const headerEnd = indexOfSequence(body, HEADER_SEPARATOR, cursor);
    if (
      headerEnd < 0 ||
      headerEnd - cursor <= 0 ||
      headerEnd - cursor > MAX_PART_HEADER_BYTES
    ) {
      return { ok: false, reason: 'malformed' };
    }
    const headerText = decodeText(body.subarray(cursor, headerEnd));
    if (headerText === null) return { ok: false, reason: 'malformed' };
    const contentStart = headerEnd + HEADER_SEPARATOR.length;
    const nextBoundary = indexOfSequence(body, nextBoundaryBytes, contentStart);
    if (nextBoundary < 0) return { ok: false, reason: 'malformed' };

    const disposition = parseDisposition(headerText);
    const fieldName = disposition.name;
    if (
      fieldName === 'image' &&
      disposition.hasFilename &&
      nextBoundary > contentStart
    ) {
      hasImageFile = true;
    }
    if (fieldName && Object.hasOwn(FIELD_LIMITS, fieldName)) {
      if (disposition.hasFilename || values.has(fieldName)) {
        return { ok: false, reason: 'malformed' };
      }
      const value = body.subarray(contentStart, nextBoundary);
      if (value.byteLength > FIELD_LIMITS[fieldName]) {
        return { ok: false, reason: 'field_too_large' };
      }
      values.set(fieldName, value);
      totalTextChars += value.byteLength;
    }

    cursor = nextBoundary + CRLF.length + boundaryBytes.length;
  }
  if (!closed) return { ok: false, reason: 'malformed' };

  const modelBytes = values.get('model');
  if (!modelBytes) return { ok: false, reason: 'missing_model' };
  const model = decodeText(modelBytes);
  const hasQuality = values.has('quality');
  const hasSize = values.has('size');
  const hasResolution = values.has('resolution');
  const hasN = values.has('n');
  const hasStream = values.has('stream');
  const quality = hasQuality ? decodeText(values.get('quality')!) : null;
  const size = hasSize ? decodeText(values.get('size')!) : null;
  const resolution = hasResolution
    ? decodeText(values.get('resolution')!)
    : null;
  const nRaw = hasN ? decodeText(values.get('n')!) : null;
  const streamRaw = hasStream ? decodeText(values.get('stream')!) : null;
  if (
    model === null ||
    (quality === null && hasQuality) ||
    (size === null && hasSize) ||
    (resolution === null && hasResolution) ||
    (nRaw === null && hasN) ||
    (streamRaw === null && hasStream)
  ) {
    return { ok: false, reason: 'malformed' };
  }
  if (!model) return { ok: false, reason: 'missing_model' };
  if (!hasImageFile) return { ok: false, reason: 'missing_image' };
  if (streamRaw !== null && streamRaw !== 'true' && streamRaw !== 'false') {
    return { ok: false, reason: 'malformed' };
  }

  let n: number | null = null;
  if (nRaw !== null) {
    if (!/^[1-9]\d*$/.test(nRaw)) {
      return { ok: false, reason: 'malformed' };
    }
    n = Number(nRaw);
    if (!Number.isSafeInteger(n)) return { ok: false, reason: 'malformed' };
  }

  const fields = {
    model,
    quality,
    size,
    resolution,
    n,
    promptBytes: values.get('prompt')?.byteLength ?? 0,
    stream: streamRaw === 'true',
  };
  return {
    ok: true,
    fields,
    admissionMetadata: {
      totalRequestChars: totalTextChars,
      messageCount: 0,
      hasServerTool: false,
      quality,
      size,
      resolution,
    },
  };
}
