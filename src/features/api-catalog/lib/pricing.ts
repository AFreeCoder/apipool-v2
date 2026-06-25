export function dollarsToMicroUsd(value: number | string): number {
  const amount = typeof value === 'number' ? value : Number(value);

  if (!Number.isFinite(amount)) {
    throw new Error('price must be a finite number');
  }

  if (amount < 0) {
    throw new Error('price must be non-negative');
  }

  return Math.round(amount * 1_000_000);
}

export function optionalDollarsToMicroUsd(
  value: FormDataEntryValue | null
): number | null {
  if (value === null) return null;

  const raw = String(value).trim();
  if (!raw) return null;

  return dollarsToMicroUsd(raw);
}

export function microUsdToDollars(value: number | null | undefined): string {
  if (value === null || value === undefined) return '';

  return String(value / 1_000_000);
}
