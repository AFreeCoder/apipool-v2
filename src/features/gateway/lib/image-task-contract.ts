export type ImageTaskStatus =
  | 'submission_unknown'
  | 'submitted'
  | 'processing'
  | 'meter_pending'
  | 'completed'
  | 'failed_unbilled';

export interface NewApiTaskAsset {
  url: string[];
  expires_at: number;
}

export interface NewApiTaskSnapshot {
  id: string;
  status: 'pending' | 'submitted' | 'processing' | 'completed' | 'failed';
  created?: number;
  completed?: number;
  result_expires_at?: number;
  result?: { images?: NewApiTaskAsset[] };
  usage?: Record<string, unknown>;
  error?: { code?: string; message?: string };
}

export interface PortalImageTaskResult {
  data: Array<{ url: string; expires_at: number }>;
  result_expires_at: number | null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function safeNonnegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

export function parseNewApiTaskSnapshot(
  value: unknown
): { ok: true; snapshot: NewApiTaskSnapshot } | { ok: false; error: string } {
  const root = record(value);
  if (!root || typeof root.id !== 'string' || !root.id.trim()) {
    return { ok: false, error: 'missing_task_id' };
  }
  const statuses = new Set([
    'pending',
    'submitted',
    'processing',
    'completed',
    'failed',
  ]);
  if (typeof root.status !== 'string' || !statuses.has(root.status)) {
    return { ok: false, error: 'invalid_task_status' };
  }
  return {
    ok: true,
    snapshot: value as NewApiTaskSnapshot,
  };
}

export function flattenNewApiImageResult(
  snapshot: NewApiTaskSnapshot
):
  | { ok: true; result: PortalImageTaskResult; outputCount: number }
  | { ok: false; error: string } {
  const images = snapshot.result?.images;
  if (!Array.isArray(images) || images.length === 0) {
    return { ok: false, error: 'result_images_missing' };
  }
  const data: PortalImageTaskResult['data'] = [];
  for (const asset of images) {
    if (
      !asset ||
      !Array.isArray(asset.url) ||
      asset.url.length === 0 ||
      !safeNonnegativeInteger(asset.expires_at)
    ) {
      return { ok: false, error: 'result_image_invalid' };
    }
    for (const url of asset.url) {
      if (typeof url !== 'string' || !url.trim()) {
        return { ok: false, error: 'result_image_url_invalid' };
      }
      data.push({ url, expires_at: asset.expires_at });
    }
  }
  if (data.length === 0) {
    return { ok: false, error: 'result_images_missing' };
  }
  return {
    ok: true,
    result: {
      data,
      result_expires_at: safeNonnegativeInteger(snapshot.result_expires_at)
        ? snapshot.result_expires_at
        : null,
    },
    outputCount: data.length,
  };
}

export function validateImageTokenUsage(
  usage: unknown
): usage is Record<string, unknown> {
  const root = record(usage);
  const inputDetails = record(root?.input_tokens_details);
  const outputDetails = record(root?.output_tokens_details);
  if (!root || !inputDetails || !outputDetails) return false;
  const values = [
    root.input_tokens,
    root.output_tokens,
    root.total_tokens,
    inputDetails.text_tokens,
    inputDetails.image_tokens,
    outputDetails.image_tokens,
  ];
  if (!values.every(safeNonnegativeInteger)) return false;
  const inputTokens = root.input_tokens as number;
  const outputTokens = root.output_tokens as number;
  return (
    outputTokens > 0 &&
    root.total_tokens === inputTokens + outputTokens &&
    inputTokens ===
      (inputDetails.text_tokens as number) +
        (inputDetails.image_tokens as number)
  );
}

export function parseCachedPortalResult(
  value: string | null
): PortalImageTaskResult | null {
  if (!value) return null;
  try {
    const parsed = record(JSON.parse(value));
    if (!parsed || !Array.isArray(parsed.data)) return null;
    const data = parsed.data.filter(
      (item): item is { url: string; expires_at: number } => {
        const row = record(item);
        return Boolean(
          row &&
            typeof row.url === 'string' &&
            safeNonnegativeInteger(row.expires_at)
        );
      }
    );
    if (data.length !== parsed.data.length || data.length === 0) return null;
    return {
      data,
      result_expires_at: safeNonnegativeInteger(parsed.result_expires_at)
        ? parsed.result_expires_at
        : null,
    };
  } catch {
    return null;
  }
}
