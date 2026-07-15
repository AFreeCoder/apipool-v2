import type { PriceVector } from '@/features/gateway/lib/billing';
import { ceilDiv } from '@/features/gateway/lib/billing';

export function computeWorstCaseMicroUsd(input: {
  contextWindow: number;
  maxOutputTokens: number;
  price: PriceVector;
}): bigint {
  const maxInputSide = Math.max(
    input.price.inputMicroUsdPerM,
    input.price.cachedInputMicroUsdPerM,
    input.price.cacheWrite5mMicroUsdPerM,
    input.price.cacheWrite1hMicroUsdPerM
  );
  return ceilDiv(
    BigInt(input.contextWindow) * BigInt(maxInputSide) +
      BigInt(input.maxOutputTokens) *
        BigInt(input.price.outputMicroUsdPerM),
    BigInt(1_000_000)
  );
}
