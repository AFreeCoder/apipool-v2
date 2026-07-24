import 'server-only';

import { createHash, randomBytes } from 'node:crypto';
import { and, eq, isNull, lt, or } from 'drizzle-orm';

import {
  newApiUserBinding,
  portalApiKey,
  walletAccount,
} from '@/config/db/schema';
import { db } from '@/core/db';
import type { GatewayProtocol } from '@/features/gateway/lib/endpoints';
import { gatewayErrorResponse } from '@/features/gateway/lib/errors';
import { ensureWalletAccount } from '@/features/wallet/server/ledger';

const KEY_PREFIX = 'sk-ap-';
const LAST_USED_WRITE_INTERVAL_MS = 60_000;

export function hashPortalKey(plain: string): string {
  return createHash('sha256').update(plain).digest('hex');
}

export function generatePortalKey() {
  const plain = `${KEY_PREFIX}${randomBytes(32).toString('base64url')}`;
  return {
    plain,
    hash: hashPortalKey(plain),
    prefix: `${KEY_PREFIX}…${plain.slice(-4)}`,
  };
}

export function extractPortalKey(headers: Headers): string | null {
  const authorization = headers.get('authorization');
  if (authorization?.toLowerCase().startsWith('bearer ')) {
    const token = authorization.slice(7).trim();
    if (token) return token;
  }
  return headers.get('x-api-key')?.trim() || null;
}

export type GatewayAuthResult =
  | { ok: true; key: any; wallet: any }
  | { ok: false; response: Response };

export async function authenticateGatewayRequest(
  headers: Headers,
  protocol: GatewayProtocol,
  portalRequestId: string
): Promise<GatewayAuthResult> {
  const deny = (
    code: Parameters<typeof gatewayErrorResponse>[1],
    status: number
  ): GatewayAuthResult => ({
    ok: false,
    response: gatewayErrorResponse(protocol, code, {
      status,
      portalRequestId,
    }),
  });

  const plain = extractPortalKey(headers);
  if (!plain) return deny('invalid_api_key', 401);

  const [key] = await db()
    .select()
    .from(portalApiKey)
    .where(eq(portalApiKey.keyHash, hashPortalKey(plain)))
    .limit(1);
  if (!key || key.status !== 'active') {
    return deny('invalid_api_key', 401);
  }

  const [binding] = await db()
    .select({ status: newApiUserBinding.status })
    .from(newApiUserBinding)
    .where(eq(newApiUserBinding.portalUserId, key.userId))
    .limit(1);
  if (binding?.status === 'disabled') {
    return deny('account_disabled', 403);
  }

  await ensureWalletAccount(key.userId);
  const [wallet] = await db()
    .select()
    .from(walletAccount)
    .where(eq(walletAccount.userId, key.userId))
    .limit(1);
  if (wallet.frozenAt) return deny('account_frozen', 403);
  if (wallet.balanceMicroUsd <= 0) return deny('insufficient_quota', 429);

  const cutoff = new Date(Date.now() - LAST_USED_WRITE_INTERVAL_MS);
  void (async () => {
    await db()
      .update(portalApiKey)
      .set({ lastUsedAt: new Date() })
      .where(
        and(
          eq(portalApiKey.id, key.id),
          or(
            isNull(portalApiKey.lastUsedAt),
            lt(portalApiKey.lastUsedAt, cutoff)
          )
        )
      );
  })().catch(() => {});

  return { ok: true, key, wallet };
}
