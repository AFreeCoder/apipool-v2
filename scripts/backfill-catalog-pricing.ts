/**
 * Catalog pricing backfill.
 *
 * Usage:
 *   DATABASE_PROVIDER=sqlite DATABASE_URL=file:data/local.db pnpm exec tsx scripts/backfill-catalog-pricing.ts --mode=report
 *   DATABASE_PROVIDER=sqlite DATABASE_URL=file:data/local.db pnpm exec tsx scripts/backfill-catalog-pricing.ts --mode=apply --yes
 */

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { backfillCatalogModelPrices } from '@/features/api-catalog/server/pricing-sync';

type BackfillMode = 'report' | 'apply';

export function parseCatalogPricingBackfillArgs(argv: string[]): {
  mode: BackfillMode;
  yes: boolean;
} {
  const modeArg = argv.find((arg) => arg.startsWith('--mode='));
  const mode = (modeArg?.split('=')[1] || 'report') as BackfillMode;
  if (mode !== 'report' && mode !== 'apply') {
    throw new Error('mode must be report or apply');
  }
  const yes = argv.includes('--yes');
  if (mode === 'apply' && !yes) {
    throw new Error(
      'apply mode requires --yes; run --mode=report first and verify DATABASE_PROVIDER/DATABASE_URL'
    );
  }
  return { mode, yes };
}

export async function runCatalogPricingBackfill(argv = process.argv.slice(2)) {
  const { mode } = parseCatalogPricingBackfillArgs(argv);
  const target = {
    databaseProvider: process.env.DATABASE_PROVIDER || '',
    databaseUrl: process.env.DATABASE_URL || '',
  };
  console.error(
    `Catalog pricing backfill target: DATABASE_PROVIDER=${target.databaseProvider || '(empty)'} DATABASE_URL=${target.databaseUrl || '(empty)'}`
  );
  const report = await backfillCatalogModelPrices({ mode });
  const result = { target, report };
  console.log(JSON.stringify(result, null, 2));
  return result;
}

const isCli =
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isCli) {
  runCatalogPricingBackfill().catch((error) => {
    console.error('Catalog pricing backfill failed:', error);
    process.exit(1);
  });
}
